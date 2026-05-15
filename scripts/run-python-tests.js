const { spawnSync } = require('node:child_process');

const candidates = process.platform === 'win32'
  ? [
    { command: 'py', args: ['-3.11', '-m', 'pytest', 'tests/python'] },
    { command: 'python', args: ['-m', 'pytest', 'tests/python'] },
  ]
  : [
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
