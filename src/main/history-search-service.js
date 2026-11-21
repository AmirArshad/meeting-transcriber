'use strict';

const { normalizeTagsFilter } = require('../renderer/tag-helpers');

/**
 * Main-process SQLite FTS5 history search service for AvaNevis.
 *
 * Owns the derived index path under `app.getPath('userData')/search/`,
 * serializes sync/query/rebuild invocations against `search.cli`, tracks
 * `dirtyGeneration` across concurrent meeting mutations, and registers IPC.
 */

const VALID_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/;

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeOptionalDate(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !VALID_ISO_DATE_RE.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {object} deps.pythonConfig
 * @param {Function} deps.spawnTrackedPython
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.collectPythonProcessOutput
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} [deps.getRecordingsDir]
 * @param {Function} [deps.isQuitCommitted]
 * @param {Function} [deps.terminateProcessBestEffort]
 * @param {number} [deps.commandTimeoutMs]
 */
function createHistorySearchService(deps) {
  const {
    app,
    path,
    fs,
    pythonConfig,
    spawnTrackedPython,
    getBackendModuleArgs,
    collectPythonProcessOutput,
    assertTrustedRendererSender,
    getRecordingsDir = () => path.join(app.getPath('userData'), 'recordings'),
    isQuitCommitted = () => false,
    terminateProcessBestEffort = async (proc) => proc?.kill?.(),
    commandTimeoutMs = 30 * 1000,
  } = deps;

  let dirty = true;
  let dirtyGeneration = 1;
  let queueTail = Promise.resolve();
  let backgroundSyncScheduled = false;
  const lingeringProcesses = new Set();

  function retainProcessUntilExit(proc) {
    lingeringProcesses.add(proc);
    proc.once('close', () => lingeringProcesses.delete(proc));
  }

  function getSearchDir() {
    return path.join(app.getPath('userData'), 'search');
  }

  function getIndexPath() {
    return path.join(getSearchDir(), 'history-index.sqlite');
  }

  function markDirty() {
    dirty = true;
    dirtyGeneration += 1;
  }

  function enqueueOperation(action) {
    const run = queueTail.catch(() => {}).then(() => {
      if (lingeringProcesses.size) throw new Error('Previous history operation is still stopping; please retry.');
      return action();
    });
    queueTail = run.catch(() => {});
    return run;
  }

  function runSearchCli(args, payload = null) {
    return new Promise((resolve, reject) => {
      const indexPath = getIndexPath();
      const recordingsDir = getRecordingsDir();
      const python = spawnTrackedPython(
        getBackendModuleArgs('search.cli', [
          '--recordings-dir',
          recordingsDir,
          '--index-path',
          indexPath,
          ...args,
        ]),
        { cwd: pythonConfig.backendPath },
      );

      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });
      let settled = false;
      let timedOut = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        callback(value);
      };

      const timeoutHandle = setTimeout(() => {
        void Promise.resolve(terminateProcessBestEffort(python)).catch(() => {});
        timedOut = true;
        retainProcessUntilExit(python);
        finish(reject, new Error('History search command timed out.'));
      }, commandTimeoutMs);
      timeoutHandle.unref?.();

      if (payload && python.stdin) {
        python.stdin.on?.('error', () => {});
        python.stdin.end(JSON.stringify(payload));
      }
      python.on('close', (code) => {
        if (timedOut) { finish(reject, new Error('History search command timed out.')); return; }
        try {
          processOutput.assertStdoutWithinLimit();
        } catch (error) {
          finish(reject, error);
          return;
        }

        if (code === 0) {
          try {
            finish(resolve, JSON.parse(processOutput.getStdout()));
          } catch (error) {
            finish(reject, new Error(`Failed to parse history search output: ${error.message}`));
          }
          return;
        }

        finish(reject, new Error(`History search failed with exit code ${code}`));
      });

      python.on('error', (error) => {
        finish(reject, error);
      });
    });
  }

  async function ensureSynced({ force = false } = {}) {
    if (isQuitCommitted()) {
      throw new Error('Cannot sync history index while the app is quitting.');
    }
    return enqueueOperation(async () => {
      const indexPath = getIndexPath();
      if (!force && !dirty && fs.existsSync(indexPath)) {
        return {
          indexPath,
          skipped: true,
        };
      }
      const syncGen = dirtyGeneration;
      const result = await runSearchCli(['sync']);
      if (dirtyGeneration === syncGen) {
        dirty = false;
      }
      return result;
    });
  }

  function triggerBackgroundSync() {
    markDirty();
    if (isQuitCommitted() || backgroundSyncScheduled) {
      return;
    }
    backgroundSyncScheduled = true;
    const timer = setTimeout(() => {
      backgroundSyncScheduled = false;
      if (isQuitCommitted()) {
        return;
      }
      void ensureSynced().catch((error) => {
        console.warn('Background history index sync failed:', error?.message || error);
      });
    }, 50);
    timer.unref?.();
  }

  async function searchHistory(options = {}) {
    const query = typeof options.query === 'string' ? options.query.slice(0, 500) : '';
    const limit = clampInt(options.limit, 50, 1, 100);
    const maxMatches = clampInt(options.maxMatches, 3, 1, 10);
    const meetingId = typeof options.meetingId === 'string' && options.meetingId.trim()
      ? options.meetingId.trim().slice(0, 120)
      : null;
    const dateFrom = normalizeOptionalDate(options.dateFrom);
    const dateTo = normalizeOptionalDate(options.dateTo);
    const rawTags = options.tags !== undefined
      ? options.tags
      : (options.tag != null && options.tag !== '' ? [options.tag] : null);
    const tags = normalizeTagsFilter(rawTags);

    return enqueueOperation(async () => {
      const indexPath = getIndexPath();
      const syncGen = dirtyGeneration;
      const shouldSync = dirty || !fs.existsSync(indexPath);

      const args = [
        'search',
        '--stdin-json',
        '--limit',
        String(limit),
        '--max-matches',
        String(maxMatches),
      ];
      if (meetingId) {
        args.push('--meeting-id', meetingId);
      }
      if (dateFrom) {
        args.push('--date-from', dateFrom);
      }
      if (dateTo) {
        args.push('--date-to', dateTo);
      }
      if (tags.length > 0) {
        args.push('--tags', tags.join(','));
      }
      if (!shouldSync) {
        args.push('--no-sync');
      }

      const result = await runSearchCli(args, { query, ...(tags.length > 0 ? { tags } : {}) });
      if (dirtyGeneration !== syncGen) throw new Error('History changed while searching; please retry.');
      if (shouldSync && dirtyGeneration === syncGen) {
        dirty = false;
      }
      return result;
    });
  }

  async function rebuildIndex() {
    if (isQuitCommitted()) {
      throw new Error('Cannot rebuild history index while the app is quitting.');
    }
    return enqueueOperation(async () => {
      const syncGen = dirtyGeneration;
      const result = await runSearchCli(['rebuild']);
      if (dirtyGeneration === syncGen) {
        dirty = false;
      }
      return result;
    });
  }

  async function getIndexStatus() {
    return enqueueOperation(() => runSearchCli(['status']));
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('search-history', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return searchHistory(options || {});
    });

    ipcMain.handle('rebuild-history-index', async (event) => {
      assertTrustedRendererSender(event);
      return rebuildIndex();
    });

    ipcMain.handle('get-history-index-status', async (event) => {
      assertTrustedRendererSender(event);
      return getIndexStatus();
    });
  }

  return {
    getIndexPath,
    enqueueOperation,
    retainProcessUntilExit,
    getGeneration: () => dirtyGeneration,
    getSearchDir,
    markDirty,
    triggerBackgroundSync,
    ensureSynced,
    searchHistory,
    rebuildIndex,
    getIndexStatus,
    registerIpc,
    isDirty: () => dirty,
  };
}

module.exports = { createHistorySearchService };
