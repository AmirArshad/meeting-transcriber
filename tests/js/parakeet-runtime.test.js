'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const { EventEmitter } = require('node:events');

const {
  buildParakeetBootstrapArgs,
  buildParakeetChildEnv,
  launchParakeetBootstrap,
  parseDeviceProbeStdout,
  terminateLateRuntimeChild,
  verifyRuntimeTree,
  resolveEmbeddedPythonPth,
  resolveParakeetPythonExecutable,
  windowsPthLines,
} = require('../../src/main/parakeet-runtime');
const { createPythonRuntime } = require('../../src/main/python-runtime');

test('Linux child env keeps only the verified CUDA library path', () => {
  const env = buildParakeetChildEnv({
    backendPath: '/app/backend',
    runtimeDir: '/app/runtime',
    platform: 'linux',
    cudaLibraryDirs: ['/opt/parakeet/cuda'],
    baseEnv: {
      LD_LIBRARY_PATH: '/usr/lib/whisper-cuda',
      PYTHONPATH: '/opt/speakrs',
      HF_TOKEN: 'secret',
    },
  });
  assert.equal(env.LD_LIBRARY_PATH, '/opt/parakeet/cuda');
  assert.equal(env.PYTHONPATH, '/app/runtime:/app/backend');
  assert.equal(env.HF_TOKEN, '');
  assert.equal(env.HF_TOKEN_PATH, os.devNull);
});

test('an extra native library fails runtime verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-parakeet-runtime-'));
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'model.bin'), 'data');
  fs.writeFileSync(path.join(root, 'pkg', 'extra.so'), 'nope');
  assert.throws(
    () => verifyRuntimeTree(root, {
      wheels: [{
        extractedFiles: [{ path: 'pkg/model.bin', sizeBytes: 4, sha256: 'ignored' }],
      }],
    }),
    (error) => error.code === 'PARAKEET_RUNTIME_INVALID',
  );
});

test('unlisted Python files and links fail runtime verification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-parakeet-runtime-'));
  const lock = {
    wheels: [{
      extractedFiles: [{ path: 'pkg/model.bin', sizeBytes: 4, sha256: 'ignored' }],
    }],
  };
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'model.bin'), 'data');
  fs.writeFileSync(path.join(root, 'sitecustomize.py'), 'import os\n');
  assert.throws(
    () => verifyRuntimeTree(root, lock),
    (error) => error.code === 'PARAKEET_RUNTIME_INVALID',
  );
  fs.rmSync(path.join(root, 'sitecustomize.py'));
  fs.symlinkSync(path.join(root, 'pkg', 'model.bin'), path.join(root, 'pkg', 'linked.bin'));
  assert.throws(
    () => verifyRuntimeTree(root, lock),
    (error) => error.code === 'PARAKEET_RUNTIME_INVALID',
  );
});

test('bootstrap args honor an embedded pth file and an isolated spawn drops ambient imports', async () => {
  assert.deepEqual(buildParakeetBootstrapArgs({
    backendPath: 'C:\\backend',
    runtimeDir: 'C:\\runtime',
    pthFile: 'C:\\python\\python311._pth',
    ambientPythonPath: 'C:\\ambient',
    commandArgs: ['--probe-device', 'cuda'],
  }), [
    '--runtime', 'C:\\runtime',
    '--backend', 'C:\\backend',
    '--pth', 'C:\\python\\python311._pth',
    '--ambient-pythonpath', 'C:\\ambient',
    '--probe-device', 'cuda',
  ]);
  assert.deepEqual(parseDeviceProbeStdout('noise\n{"device":"cuda","deviceAvailable":true}\n'), {
    device: 'cuda',
    deviceAvailable: true,
  });

  const calls = [];
  const dirname = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-parakeet-spawn-'));
  const runtime = createPythonRuntime({
    app: { isPackaged: false },
    spawn(exe, args, options) {
      calls.push({ exe, args, options });
      const proc = new EventEmitter();
      proc.pid = 1;
      return proc;
    },
    path,
    fs,
    dirname,
  });
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = '/tmp/ambient-modules:/usr/lib/python3/dist-packages';
  try {
    runtime.spawnParakeetPython(['-m', 'transcription.parakeet_bootstrap'], {
      runtimeDir: '/opt/parakeet-runtime',
    });
  } finally {
    if (previous == null) {
      delete process.env.PYTHONPATH;
    } else {
      process.env.PYTHONPATH = previous;
    }
  }
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '-S',
    '-P',
    '-m',
    'transcription.parakeet_bootstrap',
  ]);
  const pythonPath = calls[0].options.env.PYTHONPATH;
  assert.equal(pythonPath.includes('ambient-modules'), false);
  assert.equal(pythonPath.includes('dist-packages'), false);
  assert.equal(pythonPath.includes('/opt/parakeet-runtime'), true);
  assert.equal(calls[0].options.env.PYTHONNOUSERSITE, '1');

  let launched = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const pending = launchParakeetBootstrap({
    spawnParakeetPython(args, options) {
      launched = { args, options };
      return child;
    },
    args: ['--probe-device', 'cuda'],
    runtimeDir: '/opt/parakeet-runtime',
    cwd: '/app/backend',
  });
  child.stdout.emit('data', Buffer.from('{"device":"cpu","deviceAvailable":false}\n'));
  child.emit('close', 0);
  assert.equal(await pending, '{"device":"cpu","deviceAvailable":false}\n');
  assert.deepEqual(launched.options, { runtimeDir: '/opt/parakeet-runtime', cwd: '/app/backend' });
});

test('production Parakeet setup probes through the isolated launcher', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/transcription-service.js'), 'utf8');
  assert.equal(source.includes("spawnTrackedPython(getBackendModuleArgs('transcription.parakeet_bootstrap'"), false);
  assert.equal(source.includes('probeDevice: probeParakeetDevice'), true);
  assert.equal(source.includes('materializeRuntime: materializeParakeetRuntime'), true);
  assert.equal(source.includes("launchParakeet(['--probe-device', expectedDevice]"), true);
});

test('Windows pth lines name the runtime and backend, and a finished child is not killed again', () => {
  assert.deepEqual(windowsPthLines({
    runtimeDir: 'C:\\runtime',
    backendDir: 'C:\\backend',
  }), ['python311.zip', '.', 'C:\\runtime', 'C:\\backend']);
  assert.equal(
    terminateLateRuntimeChild({ exitCode: 0 }, { timedOut: true, terminate() { throw new Error('late'); } }).terminated,
    false,
  );
});

function repoPython() {
  const candidates = [
    process.env.AVANEVIS_PYTHON,
    process.env.VIRTUAL_ENV && path.join(process.env.VIRTUAL_ENV, 'bin', 'python'),
    path.join(__dirname, '../../.venv/bin/python'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

test('a site-enabled ._pth is replaced by a private interpreter that does not import site', () => {
  const sourcePython = repoPython();
  assert.ok(sourcePython, 'expected a repo Python 3.11 interpreter');
  const realPython = fs.realpathSync(sourcePython);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-pth-'));
  try {
    const prefix = path.join(root, 'shared');
    const bin = path.join(prefix, 'bin');
    const stdlib = path.join(prefix, 'lib', 'python3.11');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(stdlib), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(path.dirname(realPython)), 'lib', 'python3.11'), stdlib);
    const sharedExe = path.join(bin, path.basename(realPython));
    try {
      fs.linkSync(realPython, sharedExe);
    } catch (error) {
      fs.copyFileSync(realPython, sharedExe);
    }
    fs.writeFileSync(path.join(bin, 'sitecustomize.py'), 'raise SystemExit("site-hook")\n');
    fs.writeFileSync(
      path.join(bin, `${path.basename(sharedExe)}._pth`),
      `${stdlib}\n.\nimport site\n`,
    );
    fs.writeFileSync(path.join(bin, 'python311.dll'), '');
    const shared = spawnSync(sharedExe, ['-S', '-P', '-c', 'print("alive")'], { encoding: 'utf8' });
    assert.notEqual(shared.status, 0);
    assert.match(`${shared.stderr || ''}${shared.stdout || ''}`, /site-hook/);

    const cacheRoot = path.join(root, 'cache');
    const isolated = resolveParakeetPythonExecutable({
      pythonExe: sharedExe,
      backendPath: path.join(root, 'backend'),
      runtimeDir: path.join(root, 'runtime'),
      cacheRoot,
    });
    assert.notEqual(path.resolve(isolated), path.resolve(sharedExe));
    const home = path.dirname(isolated);
    for (const name of fs.readdirSync(home)) {
      if (!name.endsWith('._pth')) continue;
      const body = fs.readFileSync(path.join(home, name), 'utf8');
      assert.equal(body.split(/\r?\n/).some((line) => line.split('#')[0].trim() === 'import site'), false);
      assert.equal(body.split(/\r?\n/).includes('.'), false);
    }
    assert.equal(fs.existsSync(path.join(home, 'python311.dll')), true);
    fs.writeFileSync(path.join(home, 'sitecustomize.py'), 'raise SystemExit("private-hook")\n');
    const child = spawnSync(isolated, ['-S', '-P', '-c', 'import sys; print("alive", "sitecustomize" in sys.modules)'], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /alive False/);

    const linkedDir = path.join(root, 'link');
    fs.mkdirSync(linkedDir);
    const linkedExe = path.join(linkedDir, path.basename(sharedExe));
    fs.symlinkSync(sharedExe, linkedExe);
    const linkedLaunch = resolveParakeetPythonExecutable({
      pythonExe: linkedExe,
      backendPath: path.join(root, 'backend'),
      runtimeDir: path.join(root, 'runtime'),
      cacheRoot,
    });
    assert.notEqual(path.resolve(linkedLaunch), path.resolve(linkedExe));
    assert.notEqual(path.resolve(linkedLaunch), path.resolve(sharedExe));

    const calls = [];
    const runtime = createPythonRuntime({
      app: {
        isPackaged: false,
        getPath() {
          return path.join(root, 'userData');
        },
      },
      spawn(exe, args) {
        calls.push({ exe, args });
        const proc = new EventEmitter();
        proc.pid = 1;
        return proc;
      },
      path,
      fs,
      dirname: root,
    });
    runtime.spawnParakeetPython(['-m', 'transcription.parakeet_bootstrap'], {
      pythonExe: sharedExe,
      runtimeDir: path.join(root, 'runtime'),
    });
    assert.notEqual(path.resolve(calls[0].exe), path.resolve(sharedExe));
    assert.deepEqual(calls[0].args.slice(0, 2), ['-S', '-P']);
    const launchedPth = resolveEmbeddedPythonPth(calls[0].exe, fs);
    assert.equal(launchedPth.endsWith('python311._pth'), true);
    assert.equal(
      fs.readFileSync(launchedPth, 'utf8').split(/\r?\n/).some((line) => line.split('#')[0].trim() === 'import site'),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interpreter without a site-enabled ._pth is launched unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-plain-'));
  try {
    const exe = path.join(root, 'python3.11');
    fs.writeFileSync(exe, '');
    fs.writeFileSync(path.join(root, 'python3.11._pth'), '# import site\n/opt/lib/python3.11\n');
    const cacheRoot = path.join(root, 'cache');
    assert.equal(resolveParakeetPythonExecutable({
      pythonExe: exe,
      backendPath: path.join(root, 'backend'),
      cacheRoot,
    }), exe);
    assert.equal(fs.existsSync(cacheRoot), false);
    assert.equal(resolveParakeetPythonExecutable({ pythonExe: 'python3' }), 'python3');

    const broken = path.join(root, 'broken');
    fs.mkdirSync(broken);
    const brokenExe = path.join(broken, 'python.exe');
    fs.writeFileSync(brokenExe, '');
    fs.writeFileSync(path.join(broken, 'python311._pth'), 'import site\n');
    assert.throws(
      () => resolveParakeetPythonExecutable({
        pythonExe: brokenExe,
        backendPath: path.join(root, 'backend'),
        cacheRoot: path.join(root, 'unused-cache'),
      }),
      (error) => error.code === 'PARAKEET_RUNTIME_INVALID',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
