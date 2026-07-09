'use strict';

/**
 * Shared source-scan helpers for Phase 0 characterization tests.
 * Prefer scanning source over require()-ing Electron entrypoints under node --test.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(ROOT, 'src');
const MAIN_ENTRY = path.join(SRC_ROOT, 'main.js');
const MAIN_SERVICES_DIR = path.join(SRC_ROOT, 'main');

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }

  return out;
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Main-process sources that may host IPC handlers / compute-queue wiring.
 * Includes src/main.js today and every .js file under src/main/ after Phase 3 moves.
 */
function getMainProcessScanFiles() {
  const files = [MAIN_ENTRY, ...collectJsFiles(MAIN_SERVICES_DIR)];
  return files
    .filter((filePath) => fs.existsSync(filePath))
    .sort((a, b) => a.localeCompare(b));
}

function readMainProcessSources() {
  return getMainProcessScanFiles().map((filePath) => ({
    filePath,
    relativePath: toPosix(path.relative(ROOT, filePath)),
    source: readUtf8(filePath),
  }));
}

function readCombinedMainProcessSource() {
  return readMainProcessSources()
    .map((entry) => `/* FILE: ${entry.relativePath} */\n${entry.source}`)
    .join('\n');
}

function extractQuotedStrings(source, pattern) {
  const values = new Set();
  for (const match of source.matchAll(pattern)) {
    values.add(match[1]);
  }
  return [...values].sort();
}

function extractIpcMainHandleChannels(source) {
  return extractQuotedStrings(
    source,
    /ipcMain\.handle\(\s*['"]([a-z0-9-]+)['"]/g,
  );
}

function extractWebContentsSendChannels(source) {
  // Direct sends plus sendToRenderer('channel', ...) used throughout main.js.
  const channels = new Set([
    ...extractQuotedStrings(source, /webContents\.send\(\s*['"]([a-z0-9-]+)['"]/g),
    ...extractQuotedStrings(source, /sendToRenderer\(\s*['"]([a-z0-9-]+)['"]/g),
    ...extractQuotedStrings(source, /sendRedactedProgress\(\s*['"]([a-z0-9-]+)['"]/g),
    ...extractQuotedStrings(source, /flushRedactedProgress\(\s*['"]([a-z0-9-]+)['"]/g),
  ]);

  // AI_ADDON_PROGRESS_CHANNEL is imported as a constant; resolve its literal.
  if (/sendToRenderer\(\s*AI_ADDON_PROGRESS_CHANNEL\b/.test(source)
    || /webContents\.send\(\s*AI_ADDON_PROGRESS_CHANNEL\b/.test(source)) {
    channels.add('ai-addon-progress');
  }

  return [...channels].sort();
}

function extractPreloadInvokeChannels(preloadSource) {
  return extractQuotedStrings(
    preloadSource,
    /ipcRenderer\.invoke\(\s*['"]([a-z0-9-]+)['"]/g,
  );
}

function extractPreloadListenerChannels(preloadSource) {
  return extractQuotedStrings(
    preloadSource,
    /add(?:Once)?Listener\(\s*['"]([a-z0-9-]+)['"]/g,
  );
}

/**
 * Extract the source body of an ipcMain.handle('channel', ...) callback.
 * Scans until the matching closing paren/brace for the handle call.
 */
function extractIpcHandlerSource(combinedSource, channel) {
  const needle = `ipcMain.handle('${channel}'`;
  const altNeedle = `ipcMain.handle("${channel}"`;
  let start = combinedSource.indexOf(needle);
  if (start < 0) {
    start = combinedSource.indexOf(altNeedle);
  }
  if (start < 0) {
    return null;
  }

  const openParen = combinedSource.indexOf('(', start);
  if (openParen < 0) {
    return null;
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = openParen; i < combinedSource.length; i += 1) {
    const ch = combinedSource[i];
    const next = combinedSource[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle || inDouble || inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      } else if (inTemplate && ch === '`') {
        inTemplate = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return combinedSource.slice(start, i + 1);
      }
    }
  }

  return combinedSource.slice(start);
}

function handlerEnqueuesComputeAction(handlerSource) {
  if (!handlerSource) {
    return false;
  }
  return /\benqueueAiComputeAction\s*\(/.test(handlerSource)
    || /\baiComputeActionQueue\.enqueue\s*\(/.test(handlerSource);
}

/**
 * Extract a top-level `function name(...) { ... }` body from renderer app.js.
 * Used only for Phase 0.3 characterization before Pattern B extraction.
 */
function extractTopLevelFunctionSource(source, functionName) {
  const pattern = new RegExp(`^function ${functionName}\\s*\\(`, 'm');
  const match = pattern.exec(source);
  if (!match) {
    return null;
  }

  const start = match.index;
  const openBrace = source.indexOf('{', start);
  if (openBrace < 0) {
    return null;
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle || inDouble || inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      } else if (inTemplate && ch === '`') {
        inTemplate = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function loadExtractedFunctions(appSource, functionNames) {
  const parts = [];
  for (const name of functionNames) {
    const fnSource = extractTopLevelFunctionSource(appSource, name);
    if (!fnSource) {
      throw new Error(`Could not extract function ${name} from app.js`);
    }
    if (/\bdocument\./.test(fnSource) || /\bwindow\./.test(fnSource)) {
      throw new Error(`Refusing to characterize non-pure helper ${name} (touches document/window)`);
    }
    parts.push(fnSource);
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(`${parts.join('\n\n')}\nreturn { ${functionNames.join(', ')} };`);
  return factory();
}

module.exports = {
  ROOT,
  SRC_ROOT,
  MAIN_ENTRY,
  collectJsFiles,
  readUtf8,
  getMainProcessScanFiles,
  readMainProcessSources,
  readCombinedMainProcessSource,
  extractIpcMainHandleChannels,
  extractWebContentsSendChannels,
  extractPreloadInvokeChannels,
  extractPreloadListenerChannels,
  extractIpcHandlerSource,
  handlerEnqueuesComputeAction,
  extractTopLevelFunctionSource,
  loadExtractedFunctions,
  toPosix,
};
