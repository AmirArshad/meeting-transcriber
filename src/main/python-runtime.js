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

const {
  STARTUP_ISOLATION_FLAGS,
  buildParakeetChildEnv,
  parakeetCudaLibraryDirs,
  parakeetInterpreterCacheRoot,
  resolveParakeetPythonExecutable,
} = require('./parakeet-runtime');

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
 * Layout for the bundled / venv Python interpreter. Windows is the special
 * case; macOS and Linux both use POSIX `bin/python3` (python-build-standalone).
 */
function resolvePythonRuntimeLayout(platform = process.platform) {
  if (platform === 'win32') {
    return {
      family: 'windows',
      venvBinDir: 'Scripts',
      pythonFileName: 'python.exe',
      systemPython: 'python',
      packagedPythonSegments: ['python', 'python.exe'],
      packagedFfmpegSegments: ['ffmpeg', 'ffmpeg.exe'],
    };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return {
      family: 'posix',
      venvBinDir: 'bin',
      pythonFileName: 'python3',
      systemPython: 'python3',
      packagedPythonSegments: ['python', 'bin', 'python3'],
      packagedFfmpegSegments: ['ffmpeg', 'ffmpeg'],
    };
  }
  throw new Error(`Unsupported Python runtime platform: ${platform}`);
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
    const layout = resolvePythonRuntimeLayout(process.platform);

    if (isDev) {
      const explicitPython = process.env.AVANEVIS_PYTHON || null;
      const venvPythonCandidate = process.env.VIRTUAL_ENV
        ? path.join(process.env.VIRTUAL_ENV, layout.venvBinDir, layout.pythonFileName)
        : null;
      // Stale VIRTUAL_ENV must not win over a working repo .venv (ENOENT on every spawn).
      const venvPython = venvPythonCandidate && fs.existsSync(venvPythonCandidate)
        ? venvPythonCandidate
        : null;
      const repoVenvPython = path.join(dirname, '..', '.venv', layout.venvBinDir, layout.pythonFileName);
      const repoVenvExists = fs.existsSync(repoVenvPython);
      const systemPython = layout.systemPython;

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
      return {
        pythonExe: path.join(resourcesPath, ...layout.packagedPythonSegments),
        pythonSource: 'packaged',
        virtualEnv: null,
        pythonArgsPrefix: [],
        backendPath: path.join(resourcesPath, 'backend'),
        ffmpegPath: path.join(resourcesPath, ...layout.packagedFfmpegSegments),
      };
    }
  }

  const pythonConfig = getPythonConfig();

  function buildPythonProcessArgs(args = []) {
    return [...(pythonConfig.pythonArgsPrefix || []), ...args];
  }

  function buildPythonEnv(extra = {}) {
    const { PYTHONPATH: extraPythonPath, ...restExtra } = extra || {};
    const separator = process.platform === 'win32' ? ';' : ':';
    // Packaged children must not inherit a developer or attacker PYTHONPATH —
    // python-build-standalone honors it and would import pulsectl/numpy from
    // outside the bundle. Dev still concatenates ambient PYTHONPATH.
    const ambientPythonPath = app.isPackaged ? '' : (process.env.PYTHONPATH || '');
    const basePythonPath = pythonConfig.backendPath
      + (ambientPythonPath ? separator + ambientPythonPath : '');

    // Caller keys set to `undefined` are explicit unsets and must not inherit
    // from process.env after the merge (Speakrs must not see ambient HF caches).
    const env = {
      ...process.env,
      ...restExtra,
      PYTHONPATH: extraPythonPath ? `${extraPythonPath}${separator}${basePythonPath}` : basePythonPath,
    };
    for (const [key, value] of Object.entries(restExtra)) {
      if (value === undefined) {
        delete env[key];
      }
    }
    // Packaged children always see AVANEVIS_PACKAGED=1; callers cannot override it.
    if (app.isPackaged) {
      env.AVANEVIS_PACKAGED = '1';
      env.PYTHONNOUSERSITE = '1';
      env.PYTHONDONTWRITEBYTECODE = '1';
      delete env.PYTHONHOME;
      delete env.PYTHONUSERBASE;
    }

    return env;
  }

  /**
   * Helper to spawn and track Python processes for cleanup.
   *
   * Dev: PYTHONPATH includes the repo backend (plus ambient PYTHONPATH).
   * Packaged: buildPythonEnv uses only bundled paths, ignores ambient
   * PYTHONPATH/HOME/USERBASE, disables user site and bytecode writes. Windows embedded
   * Python also reads backend from python311._pth.
   */
  function isolatedPythonEnv(env) {
    const isolated = { ...(env || {}) };
    if (app.isPackaged) {
      isolated.AVANEVIS_PACKAGED = '1';
      isolated.PYTHONNOUSERSITE = '1';
      isolated.PYTHONDONTWRITEBYTECODE = '1';
      delete isolated.PYTHONHOME;
      delete isolated.PYTHONUSERBASE;
    }
    return isolated;
  }

  function spawnTrackedPython(args, options = {}) {
    const usePosixProcessGroup = process.platform !== 'win32' && options.detached !== false;
    const isolatedPythonPath = options.isolatedPythonPath === true;
    const executable = options.pythonExe || pythonConfig.pythonExe;
    const spawnOptions = { ...options };
    delete spawnOptions.isolatedPythonPath;
    delete spawnOptions.pythonExe;
    // Merge our environment with any options.env provided by caller.
    // Packaged POSIX Python honors PYTHONPATH; buildPythonEnv strips ambient
    // import paths. Windows embedded Python also uses python311._pth.
    // isolatedPythonPath keeps a caller-built PYTHONPATH exactly, so a Parakeet
    // child cannot inherit developer, Whisper, or Speakrs import roots.
    const mergedOptions = {
      ...spawnOptions,
      detached: usePosixProcessGroup,
      env: isolatedPythonPath ? isolatedPythonEnv(options.env || {}) : buildPythonEnv(options.env || {}),
    };

    const proc = spawn(executable, buildPythonProcessArgs(args), mergedOptions);
    proc.avanevisProcessGroup = usePosixProcessGroup;
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

  function spawnParakeetPython(args, options = {}) {
    const {
      runtimeDir,
      cudaLibraryDirs,
      cwd,
      ...spawnOptions
    } = options || {};
    const env = buildParakeetChildEnv({
      backendPath: pythonConfig.backendPath,
      runtimeDir,
      platform: process.platform,
      packaged: Boolean(app.isPackaged),
      cudaLibraryDirs: Array.isArray(cudaLibraryDirs)
        ? cudaLibraryDirs
        : parakeetCudaLibraryDirs(runtimeDir, fs),
      baseEnv: process.env,
    });
    let cacheRoot = null;
    try {
      if (app && typeof app.getPath === 'function') {
        cacheRoot = parakeetInterpreterCacheRoot(app.getPath('userData'), path);
      }
    } catch (error) {
      cacheRoot = null;
    }
    const pythonExe = resolveParakeetPythonExecutable({
      pythonExe: spawnOptions.pythonExe || pythonConfig.pythonExe,
      backendPath: pythonConfig.backendPath,
      runtimeDir,
      cacheRoot,
      fsModule: fs,
      pathModule: path,
    });
    delete spawnOptions.pythonExe;
    return spawnTrackedPython([...STARTUP_ISOLATION_FLAGS, ...(args || [])], {
      ...spawnOptions,
      pythonExe,
      cwd: cwd || pythonConfig.backendPath,
      env,
      isolatedPythonPath: true,
    });
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
    buildParakeetChildEnv,
    spawnTrackedPython,
    spawnParakeetPython,
    getActiveProcesses,
    drainActiveProcesses,
  };
}

module.exports = { createPythonRuntime, resolveVirtualEnvFromPythonExe, resolvePythonRuntimeLayout };
