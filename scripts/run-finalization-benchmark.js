'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, 'benchmark_finalization.py');
const forwarded = process.argv.slice(2);
const candidates = process.platform === 'win32'
  ? [
    { command: 'py', args: ['-3.11', script, ...forwarded] },
    { command: 'python', args: [script, ...forwarded] },
  ]
  : [
    { command: 'python3', args: [script, ...forwarded] },
    { command: 'python', args: [script, ...forwarded] },
  ];

for (const candidate of candidates) {
  const result = spawnSync(candidate.command, candidate.args, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error?.code === 'ENOENT') {
    continue;
  }
  process.exit(result.status ?? 1);
}

console.error('No usable Python interpreter found for finalization benchmark.');
process.exit(1);
