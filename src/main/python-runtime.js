'use strict';

/**
 * Python runtime service for the AvaNevis main process.
 *
 * Owns the single shared `activeProcesses` tracking array plus the Python
 * executable/backend resolution and spawn helpers. The factory keeps behavior
 * identical to the previous inline definitions in `src/main.js`; only the
 * `__dirname` dependency is injected (as `dirname`) so this module stays
 * relocatable.
 */

/**
 * Infer a virtualenv root from a resolved interpreter path (…/bin/python3 or
 * …/Scripts/python.exe) when pyvenv.cfg is present.
 */
function resolveVirtualEnvFromPythonExe(pythonExe, { path, fs }) {
  if (!pythonExe || typeof pythonExe !== 'string') {
    return null;
  }
  if (pythonExe === 'python' || pythonExe === 'python3' || !path.isAbsolute(pythonExe)) {
    return null;
  }
  const exeDir = path.dirname(pythonExe);
  const baseName = path.basename(exeDir).toLowerCase();
  if (baseName !== 'bin' && baseName !== 'scripts') {
    return null;
  }
  const venvRoot = path.dirname(exeDir);
  if (fs.existsSync(path.join(venvRoot, 'pyvenv.cfg'))) {
    return venvRoot;
  }
  return null;
}

/**
 * Create a Python runtime bound to injected Electron/Node primitives.
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {string} deps.dirname - Value of `__dirname` from the main entrypoint.
 */
function createPythonRuntime({ app, spawn, path, fs, dirname }) {
  // Single source of truth for spawned Python processes. Never copy this array;
  // callers must mutate the same reference (via spawnTrackedPython or drain).
  const activeProcesses = [];

  /**
   * Determine the correct Python executable and backend path based on environment.
   * In production (packaged app), use bundled Python.
   * In development, use system Python.
   */
  function getPythonConfig() {
    const isDev = !app.isPackaged;
    const isMac = process.platform === 'darwin';

    if (isDev) {
      const explicitPython = process.env.AVANEVIS_PYTHON || null;
      const venvPythonCandidate = process.env.VIRTUAL_ENV
        ? path.join(process.env.VIRTUAL_ENV, isMac ? 'bin' : 'Scripts', isMac ? 'python3' : 'python.exe')
        : null;
      // Stale VIRTUAL_ENV must not win over a working repo .venv (ENOENT on every spawn).
      const venvPython = venvPythonCandidate && fs.existsSync(venvPythonCandidate)
        ? venvPythonCandidate
        : null;
      const repoVenvPython = path.join(dirname, '..', '.venv', isMac ? 'bin' : 'Scripts', isMac ? 'python3' : 'python.exe');
      const repoVenvExists = fs.existsSync(repoVenvPython);
      const systemPython = isMac ? 'python3' : 'python';

      let pythonExe;
      let pythonSource;
      if (explicitPython) {
        pythonExe = explicitPython;
        pythonSource = 'AVANEVIS_PYTHON';
      } else if (venvPython) {
        pythonExe = venvPython;
        pythonSource = 'VIRTUAL_ENV';
      } else if (repoVenvExists) {
        pythonExe = repoVenvPython;
        pythonSource = '.venv';
      } else {
        pythonExe = systemPython;
        pythonSource = 'system';
      }

      // Only attach a virtualEnv that belongs to the chosen interpreter. Do not
      // inherit process.env.VIRTUAL_ENV when AVANEVIS_PYTHON selected a different exe.
      let virtualEnv = resolveVirtualEnvFromPythonExe(pythonExe, { path, fs });
      if (!virtualEnv) {
        if (pythonSource === 'VIRTUAL_ENV' && process.env.VIRTUAL_ENV) {
          virtualEnv = process.env.VIRTUAL_ENV;
        } else if (pythonSource === '.venv' && repoVenvExists) {
          virtualEnv = path.join(dirname, '..', '.venv');
        }
      }

      return {
        pythonExe,
        pythonSource,
        virtualEnv,
        pythonArgsPrefix: [],
        backendPath: path.join(dirname, '../backend'),
        ffmpegPath: 'ffmpeg' // Assume in PATH
      };
    } else {
      // Production mode - use bundled Python
      const resourcesPath = process.resourcesPath;

      if (isMac) {
        // macOS: Use bundled Python from resources/python/bin/
        return {
          pythonExe: path.join(resourcesPath, 'python', 'bin', 'python3'),
          pythonSource: 'packaged',
          virtualEnv: null,
          pythonArgsPrefix: [],
          backendPath: path.join(resourcesPath, 'backend'),
          ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg')
        };
      } else {
        // Windows: Use bundled Python from resources/python/
        return {
          pythonExe: path.join(resourcesPath, 'python', 'python.exe'),
          pythonSource: 'packaged',
          virtualEnv: null,
          pythonArgsPrefix: [],
          backendPath: path.join(resourcesPath, 'backend'),
          ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe')
        };
      }
    }
  }

  const pythonConfig = getPythonConfig();

  function buildPythonProcessArgs(args = []) {
    return [...(pythonConfig.pythonArgsPrefix || []), ...args];
  }

  function buildPythonEnv(extra = {}) {
    const { PYTHONPATH: extraPythonPath, ...restExtra } = extra || {};
    const basePythonPath = pythonConfig.backendPath + (process.env.PYTHONPATH ?
      (process.platform === 'win32' ? ';' : ':') + process.env.PYTHONPATH : '');
    const separator = process.platform === 'win32' ? ';' : ':';
    const packagedEnv = app.isPackaged ? { AVANEVIS_PACKAGED: '1' } : {};

    return {
      ...process.env,
      ...packagedEnv,
      ...restExtra,
      PYTHONPATH: extraPythonPath ? `${extraPythonPath}${separator}${basePythonPath}` : basePythonPath,
    };
  }

  /**
   * Helper to spawn and track Python processes for cleanup.
   *
   * NOTE: Sets PYTHONPATH environment variable for development mode where system
   * Python is used. For production builds with embedded Python, the .pth file is
   * modified in build/prepare-resources.js to include the backend path, as embedded
   * Python ignores the PYTHONPATH environment variable.
   */
  function spawnTrackedPython(args, options = {}) {
    // Merge our environment with any options.env provided by caller
    const mergedOptions = {
      ...options,
      env: buildPythonEnv(options.env || {})
    };

    const proc = spawn(pythonConfig.pythonExe, buildPythonProcessArgs(args), mergedOptions);
    activeProcesses.push(proc);

    // Auto-remove from tracking when process exits
    proc.on('close', () => {
      const index = activeProcesses.indexOf(proc);
      if (index > -1) {
        activeProcesses.splice(index, 1);
      }
    });

    return proc;
  }

  // Return the same array reference so callers (e.g. before-quit cleanup) can
  // iterate the live tracking list. Do not copy this array.
  function getActiveProcesses() {
    return activeProcesses;
  }

  // Clear tracking (mutates the shared array in place; keeps the reference stable).
  function drainActiveProcesses() {
    activeProcesses.length = 0;
  }

  return {
    getPythonConfig,
    // Design-doc alias; actual name stays getPythonConfig.
    resolvePythonPath: getPythonConfig,
    pythonConfig,
    buildPythonProcessArgs,
    buildPythonEnv,
    spawnTrackedPython,
    getActiveProcesses,
    drainActiveProcesses,
  };
}

module.exports = { createPythonRuntime, resolveVirtualEnvFromPythonExe };
