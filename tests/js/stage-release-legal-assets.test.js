const test = require('node:test');
const assert = require('node:assert/strict');
const { stageSourceWithRetry } = require('../../scripts/stage-release-legal-assets');

test('legal source staging retries transient failures and returns the verified archive', async () => {
  let attempts = 0;
  const delays = [];
  const result = await stageSourceWithRetry('/legal', {
    stage: async (dir) => {
      assert.equal(dir, '/legal');
      if (++attempts < 3) throw new Error('connection timeout');
      return '/legal/ffmpeg.tar.xz';
    },
    delay: async (ms) => delays.push(ms),
  });
  assert.equal(result, '/legal/ffmpeg.tar.xz');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5000, 10000]);
});

test('legal source staging fails closed after retries are exhausted', async () => {
  let attempts = 0;
  await assert.rejects(stageSourceWithRetry('/legal', {
    stage: async () => { attempts += 1; throw new Error('checksum mismatch'); },
    delay: async () => {},
  }), /checksum mismatch/);
  assert.equal(attempts, 3);
});
