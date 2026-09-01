const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const posixVenvPython = path.join(ROOT, '.venv', 'bin', 'python');
const winVenvPython = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

const candidates = process.platform === 'win32'
  ? [
    ...(fs.existsSync(winVenvPython) ? [{ command: winVenvPython, args: ['-m', 'pytest', 'tests/python'] }] : []),
    { command: 'py', args: ['-3.11', '-m', 'pytest', 'tests/python'] },
    { command: 'python', args: ['-m', 'pytest', 'tests/python'] },
  ]
  : [
    ...(fs.existsSync(posixVenvPython) ? [{ command: posixVenvPython, args: ['-m', 'pytest', 'tests/python'] }] : []),
    { command: 'python3.11', args: ['-m', 'pytest', 'tests/python'] },
    { command: 'python3', args: ['-m', 'pytest', 'tests/python'] },
    { command: 'python', args: ['-m', 'pytest', 'tests/python'] },
  ];

let lastFailure = null;

function canStartInterpreter(candidate) {
  const probe = spawnSync(candidate.command, candidate.args.slice(0, -3).concat(['-c', 'import sys; print(sys.version)']), {
    stdio: 'ignore',
    shell: false,
  });

  if (probe.error) {
    lastFailure = probe.error;
    return false;
  }

  if (probe.status !== 0) {
    lastFailure = new Error(`${candidate.command} ${candidate.args.slice(0, -3).join(' ')} could not start`);
    return false;
  }

  return true;
}

for (const candidate of candidates) {
  if (!canStartInterpreter(candidate)) {
    continue;
  }

  const result = spawnSync(candidate.command, candidate.args, {
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    lastFailure = result.error;
    if (result.error.code === 'ENOENT') {
      continue;
    }
    break;
  }

  process.exit(result.status ?? 1);
}

if (lastFailure) {
  console.error(`Unable to run Python tests: ${lastFailure.message}`);
} else {
  console.error('Unable to run Python tests: no Python interpreter found.');
}

process.exit(1);
