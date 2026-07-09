'use strict';

/**
 * Regression coverage for Phase 3c recorder-service DI wiring.
 *
 * Successful stop builds `{ existsSync, getRecordingsDir }` before calling
 * parseRecordingStopResult. A missing getRecordingsDir binding is a
 * ReferenceError that Phase 0 source-scans cannot see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createRecorderService } = require('../../src/main/recorder-service');

function createMinimalDeps(overrides = {}) {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-recorder-deps-'));
  return {
    deps: {
      app: { getPath: () => path.dirname(recordingsDir), quit() {} },
      path,
      fs,
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      powerSaveBlocker: { start: () => 1, stop() {} },
      pythonConfig: { pythonExe: 'python', backendPath: recordingsDir, ffmpegPath: 'ffmpeg' },
      spawnTrackedPython() {
        throw new Error('spawnTrackedPython should not run in this unit test');
      },
      sendToRenderer() {},
      assertTrustedRendererSender() {},
      getMainWindow: () => null,
      setIsQuitting() {},
      getAllowImmediateQuit: () => false,
      setAllowImmediateQuit() {},
      getQuitWorkflowPromise: () => null,
      setQuitWorkflowPromise() {},
      validateSelectedDevices: async () => ({ ok: true }),
      checkDiskSpace: async () => ({ ok: true }),
      checkAudioOutputSupport: async () => ({ ok: true }),
      getMacOSPermissionStatus: async () => ({ ok: true }),
      addMeetingToHistory: async () => ({}),
      formatDurationForTranscript: () => '0:00',
      getRecordingsDir: () => recordingsDir,
      ...overrides,
    },
    recordingsDir,
  };
}

test('createRecorderService requires getRecordingsDir', () => {
  const { deps } = createMinimalDeps();
  delete deps.getRecordingsDir;
  assert.throws(() => createRecorderService(deps), /getRecordingsDir/);
});

test('parseRecordingStopResultFromStdout resolves with injected getRecordingsDir', () => {
  const { deps, recordingsDir } = createMinimalDeps();
  const audioPath = path.join(recordingsDir, 'meeting_test.wav');
  fs.writeFileSync(audioPath, 'fake');

  const service = createRecorderService(deps);
  const result = service.parseRecordingStopResultFromStdout(JSON.stringify({
    success: true,
    audioPath,
    duration: 1.25,
  }));

  assert.equal(result.success, true);
  assert.equal(result.audioPath, audioPath);
});

test('parseRecordingStopResultFromStdout does not throw ReferenceError for getRecordingsDir', () => {
  // Even when the payload is empty, building the options object must evaluate
  // the getRecordingsDir binding. Missing wiring used to throw here.
  const { deps } = createMinimalDeps();
  const service = createRecorderService(deps);
  assert.throws(
    () => service.parseRecordingStopResultFromStdout(''),
    (error) => error instanceof Error && error.name !== 'ReferenceError',
  );
});
