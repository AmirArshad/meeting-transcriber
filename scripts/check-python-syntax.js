'use strict';

/**
 * Cross-platform wrapper for scripts/check_python_syntax.py.
 * Mirrors scripts/run-python-tests.js interpreter selection (py -3.11 / python3).
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(__dirname, 'check_python_syntax.py');

const candidates = process.platform === 'win32'
  ? [
    { command: 'py', args: ['-3.11', SCRIPT] },
    { command: 'python', args: [SCRIPT] },
  ]
  : [
    { command: 'python3', args: [SCRIPT] },
    { command: 'python', args: [SCRIPT] },
  ];

let lastFailure = null;

function canStartInterpreter(candidate) {
  const probeArgs = candidate.command === 'py'
    ? ['-3.11', '-c', 'import sys; print(sys.version)']
    : ['-c', 'import sys; print(sys.version)'];
  const probe = spawnSync(candidate.command, probeArgs, {
    stdio: 'ignore',
    shell: false,
  });

  if (probe.error) {
    lastFailure = probe.error;
    return false;
  }

  if (probe.status !== 0) {
    lastFailure = new Error(`${candidate.command} could not start`);
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
    cwd: ROOT,
  });

  if (result.error) {
    console.error(result.error.message || String(result.error));
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

console.error('No usable Python 3.11+ interpreter found for backend syntax check.');
if (lastFailure) {
  console.error(lastFailure.message || String(lastFailure));
}
process.exit(1);
