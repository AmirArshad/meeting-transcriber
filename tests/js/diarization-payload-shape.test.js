'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { createTranscriptionService } = require('../../src/main/transcription-service');

const DIARIZE_REQUIRED_FLAGS = Object.freeze([
  '--audio',
  '--segments-json',
  '--output-json',
  '--model-ref',
  '--speaker-count',
  '--ffmpeg',
]);
const GUIDED_REQUIRED_FLAGS = Object.freeze([
  '--audio',
  '--output-transcript',
  '--language',
  '--model',
  '--transcriber-backend',
  '--model-ref',
  '--speaker-count',
  '--ffmpeg',
]);
const ENGINE_AGNOSTIC_OPTIONAL_FLAGS = Object.freeze([
  '--require-device',
  '--output-json',
  '--engine',
]);

function flagNames(args) {
  return args.filter((value) => typeof value === 'string' && value.startsWith('--'));
}

function assertEngineAgnosticFlags(actualFlags, requiredFlags) {
  for (const flag of requiredFlags) {
    assert.ok(actualFlags.includes(flag), `missing required flag ${flag}`);
  }
  for (const flag of actualFlags) {
    assert.ok(
      requiredFlags.includes(flag) || ENGINE_AGNOSTIC_OPTIONAL_FLAGS.includes(flag),
      `unexpected engine-specific flag ${flag}`,
    );
  }
}

function createService() {
  return createTranscriptionService({
    app: { getPath: () => '/tmp/avanevis-test', isPackaged: false },
    path,
    fs: {
      promises: {
        readFile: async () => '',
        writeFile: async () => {},
        rm: async () => {},
        mkdtemp: async (prefix) => `${prefix}test`,
      },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python', ffmpegPath: '/tmp/ffmpeg' },
    spawnTrackedPython: () => {},
    getBackendModuleArgs: (_moduleName, extraArgs) => extraArgs,
    enqueueAiComputeAction: (action) => action(),
    getCachedCudaStatus: () => ({ available: false }),
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({}),
    getDiarizationCacheEnv: () => ({}),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    listMeetings: async () => [],
    isQuitCommitted: () => false,
  });
}

test('diarize-transcript spawn flags stay engine-agnostic', () => {
  const service = createService();
  const args = service.buildManagedDiarizationArgs({
    audioPath: '/tmp/meeting.opus',
    segmentsJsonPath: '/tmp/meeting.segments.json',
    outputPath: '/tmp/meeting.speakers.json',
    modelRef: 'pyannote/speaker-diarization-community-1',
    speakerCount: 'auto',
    requiredDevice: 'mps',
  });

  assertEngineAgnosticFlags(flagNames(args), DIARIZE_REQUIRED_FLAGS);
  assert.ok(flagNames(args).includes('--require-device'));
  assert.equal(args.includes('--engine'), false);
});

test('transcribe-audio-with-speakers spawn flags stay engine-agnostic', () => {
  const service = createService();
  const args = service.buildManagedDiarizationGuidedTranscriptionArgs({
    audioPath: '/tmp/meeting.opus',
    outputTranscript: '/tmp/meeting.md',
    outputJson: '/tmp/meeting.speakers.json',
    language: 'en',
    modelSize: 'small',
    modelRef: 'pyannote/speaker-diarization-community-1',
    speakerCount: 'auto',
    requiredDevice: 'mps',
  });

  assertEngineAgnosticFlags(flagNames(args), GUIDED_REQUIRED_FLAGS);
  assert.ok(flagNames(args).includes('--output-json'));
  assert.ok(flagNames(args).includes('--require-device'));
  assert.equal(args.includes('--engine'), false);
});
