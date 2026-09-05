'use strict';

const { parentPort, workerData } = require('worker_threads');
const { runLinuxCudaFileWorkerJob } = require('./linux-cuda-runtime-helpers');

try {
  const result = runLinuxCudaFileWorkerJob(workerData);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
    },
  });
}
