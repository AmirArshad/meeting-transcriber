'use strict';

/**
 * File-export IPC service for the AvaNevis main process.
 *
 * Registers the transcript/speaker-segment save channels plus the legal-notices
 * opener, and owns the safe save-dialog default-name helper. Handler bodies are
 * moved verbatim from `src/main.js`; cross-module dependencies (including the
 * main entrypoint `__dirname` as `dirname`) are injected via `deps`.
 */

const WINDOWS_RESERVED_FILE_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {import('electron').Dialog} deps.dialog
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {import('electron').Shell} deps.shell
 * @param {Function} deps.isSafeRecordingsMarkdownPath
 * @param {Function} deps.isSafeRecordingsJsonPath
 * @param {Function} deps.getLegalNoticesPath
 * @param {string} deps.dirname - Value of `__dirname` from the main entrypoint.
 */
function createFileExportIpc(deps) {
  const {
    app,
    path,
    fs,
    dialog,
    BrowserWindow,
    shell,
    isSafeRecordingsMarkdownPath,
    isSafeRecordingsJsonPath,
    getLegalNoticesPath,
    dirname,
  } = deps;

  function buildSafeSaveDialogDefaultPath(suggestedName) {
    let safeName = suggestedName
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/g, '');

    if (!safeName) {
      safeName = 'transcript';
    }

    const defaultName = safeName.toLowerCase().endsWith('.md') ? safeName : `${safeName}.md`;
    const parsed = path.parse(defaultName);
    let baseName = (parsed.name || 'transcript').replace(/[. ]+$/g, '') || 'transcript';

    if (WINDOWS_RESERVED_FILE_BASENAME.test(baseName)) {
      baseName = `file ${baseName}`;
    }

    return `${baseName}${parsed.ext || '.md'}`;
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('save-transcript-file', async (event, options = {}) => {
      const { filePath, content } = options;
      if (!filePath || typeof content !== 'string') {
        throw new Error('save-transcript-file requires filePath and content');
      }

      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      if (!isSafeRecordingsMarkdownPath({ filePath, recordingsDir })) {
        throw new Error('Transcript file must be a Markdown file in the recordings directory.');
      }

      const resolvedPath = path.resolve(filePath);
      await fs.promises.writeFile(resolvedPath, content, 'utf8');
      return { success: true, filePath: resolvedPath };
    });

    ipcMain.handle('save-speaker-segments-file', async (event, options = {}) => {
      const { filePath, content } = options;
      if (!filePath || typeof content !== 'string') {
        throw new Error('save-speaker-segments-file requires filePath and content');
      }

      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      if (!isSafeRecordingsJsonPath({ filePath, recordingsDir })) {
        throw new Error('Speaker segment file must be a JSON file in the recordings directory.');
      }

      const resolvedPath = path.resolve(filePath);
      const parsed = JSON.parse(content);
      await fs.promises.writeFile(resolvedPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      return { success: true, filePath: resolvedPath };
    });

    /**
     * Show a Save dialog and write the supplied transcript text to disk.
     *
     * The renderer chooses the suggested filename (typically derived from the
     * meeting's display label) so users get a meaningful default name.
     */
    ipcMain.handle('save-transcript-as', async (event, options) => {
      const opts = options || {};
      const suggestedName = (opts.suggestedName || 'transcript').toString();
      const content = typeof opts.content === 'string' ? opts.content : '';
      const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : 'Save Transcript';

      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(window, {
        title,
        defaultPath: buildSafeSaveDialogDefaultPath(suggestedName),
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      await fs.promises.writeFile(result.filePath, content, 'utf8');
      return { canceled: false, filePath: result.filePath };
    });

    ipcMain.handle('open-legal-notices', async () => {
      const noticesPath = getLegalNoticesPath({
        resourcesPath: app.isPackaged ? process.resourcesPath : null,
        devRoot: path.join(dirname, '..'),
      });

      if (!noticesPath) {
        return {
          success: false,
          error: 'Third-party notices file is not available.',
        };
      }

      const openError = await shell.openPath(noticesPath);
      if (openError) {
        return {
          success: false,
          path: noticesPath,
          error: openError,
        };
      }

      return {
        success: true,
        path: noticesPath,
      };
    });
  }

  return { buildSafeSaveDialogDefaultPath, registerIpc };
}

/**
 * Convenience wiring helper: build the file-export service and register IPC.
 */
function registerFileExportIpc(ipcMain, deps) {
  const service = createFileExportIpc(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = {
  createFileExportIpc,
  registerFileExportIpc,
  WINDOWS_RESERVED_FILE_BASENAME,
};
