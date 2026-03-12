const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildFileUrl,
  buildPermissionErrorMessage,
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  buildModelDownloadCheck,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  getQuitInterceptState,
  getRecorderEventAction,
  getMacMLXCacheDir,
  getMacMLXModelStorageDirs,
  getModelDownloadPatterns,
  getRecordingStopTimeout,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  splitBufferedLines,
} = require('../../src/main-process-helpers');


test('buildModelDownloadCheck returns Windows faster-whisper cache settings', () => {
  const result = buildModelDownloadCheck({
    platform: 'win32',
    arch: 'x64',
    homeDir: '/Users/tester',
    modelSize: 'medium',
  });

  assert.equal(result.cacheDir, path.join('/Users/tester', '.cache', 'huggingface', 'hub'));
  assert.deepEqual(result.modelPatterns, ['models--guillaumekln--faster-whisper-medium']);
  assert.equal(result.modelSize, 'medium');
});


test('buildFileUrl returns a file URL for absolute paths', () => {
  assert.equal(
    buildFileUrl('/tmp/demo audio.opus'),
    'file:///tmp/demo%20audio.opus',
  );
});


test('buildFileUrl preserves existing file URLs', () => {
  assert.equal(
    buildFileUrl('file:///tmp/demo.opus'),
    'file:///tmp/demo.opus',
  );
});


test('buildModelDownloadCheck returns macOS MLX cache settings for Apple Silicon', () => {
  const result = buildModelDownloadCheck({
    platform: 'darwin',
    arch: 'arm64',
    homeDir: '/Users/tester',
    modelSize: 'small',
  });

  assert.equal(result.cacheDir, path.join('/Users/tester', 'Library', 'Caches', 'meeting-transcriber', 'mlx_models'));
  assert.deepEqual(result.modelPatterns, [
    'distil-small.en',
    'whisper-small-mlx',
  ]);
});


test('getMacMLXCacheDir returns writable MLX cache path', () => {
  assert.equal(
    getMacMLXCacheDir('/Users/tester'),
    path.join('/Users/tester', 'Library', 'Caches', 'meeting-transcriber', 'mlx_models'),
  );
});


test('getMacMLXModelStorageDirs returns expected per-model cache directories', () => {
  assert.deepEqual(getMacMLXModelStorageDirs('small'), ['distil-small.en', 'whisper-small-mlx']);
  assert.deepEqual(getMacMLXModelStorageDirs('medium'), ['distil-medium.en', 'whisper-medium-mlx']);
  assert.deepEqual(getMacMLXModelStorageDirs('large'), ['distil-large-v3', 'whisper-large-v3-mlx']);
});


test('getModelDownloadPatterns returns macOS Apple Silicon MLX patterns', () => {
  assert.deepEqual(getModelDownloadPatterns('darwin', 'arm64', 'small'), [
    'distil-small.en',
    'whisper-small-mlx',
  ]);
});


test('cacheContainsModel matches a cached model entry by pattern fragment', () => {
  const items = [
    'models--foo--bar',
    'models--guillaumekln--faster-whisper-small',
  ];

  assert.equal(
    cacheContainsModel(items, ['models--guillaumekln--faster-whisper-small']),
    true,
  );
});


test('classifyRecorderStdoutChunk parses the first audio level payload', () => {
  const chunk = '{"type": "levels", "micLevel": 0.4, "desktopLevel": 0.2}\n{"type": "levels", "micLevel": 0.1, "desktopLevel": 0.1}';

  const result = classifyRecorderStdoutChunk(chunk);

  assert.equal(result.type, 'levels');
  assert.deepEqual(result.levels, {
    type: 'levels',
    mic: 0.4,
    desktop: 0.2,
  });
});


test('classifyRecorderStdoutChunk treats malformed level JSON as progress text until a full line arrives', () => {
  const result = classifyRecorderStdoutChunk('{"type": "levels", bad json');

  assert.equal(result.type, 'progress');
  assert.equal(result.output, '{"type": "levels", bad json');
});


test('classifyRecorderStdoutChunk keeps non-level output as progress text', () => {
  const result = classifyRecorderStdoutChunk('Desktop audio stream opened');

  assert.deepEqual(result, {
    type: 'progress',
    output: 'Desktop audio stream opened',
  });
});


test('splitBufferedLines preserves incomplete trailing JSON data', () => {
  const result = splitBufferedLines('{"type":"warning"}\n{"type":"event"', '');

  assert.deepEqual(result, {
    lines: ['{"type":"warning"}'],
    remainder: '{"type":"event"',
  });
});


test('parseRecorderMessageLine normalizes level payload keys for the renderer', () => {
  const result = parseRecorderMessageLine('{"type":"levels","micLevel":0.3,"desktopLevel":0.6}');

  assert.equal(result.kind, 'levels');
  assert.deepEqual(result.payload, {
    type: 'levels',
    mic: 0.3,
    desktop: 0.6,
  });
});


test('parseRecorderStdoutChunk parses mixed structured recorder messages', () => {
  const chunk = [
    '{"type":"event","event":"mic_stream_opened","message":"Microphone stream opened"}',
    '{"type":"warning","code":"NO_DESKTOP_AUDIO","message":"Desktop disabled"}',
    '{"type":"levels","mic":0.1,"desktop":0.2}',
    '',
  ].join('\n');

  const result = parseRecorderStdoutChunk(chunk);

  assert.equal(result.remainder, '');
  assert.deepEqual(result.messages.map((message) => message.kind), ['event', 'warning', 'levels']);
  assert.equal(result.messages[0].payload.event, 'mic_stream_opened');
  assert.equal(result.messages[1].payload.code, 'NO_DESKTOP_AUDIO');
  assert.deepEqual(result.messages[2].payload, {
    type: 'levels',
    mic: 0.1,
    desktop: 0.2,
  });
});


test('parseRecorderStdoutChunk keeps incomplete trailing chunks for the next read', () => {
  const firstChunk = parseRecorderStdoutChunk('{"type":"event","event":"recording_started","message":"Recording sta');
  assert.equal(firstChunk.messages.length, 0);
  assert.equal(firstChunk.remainder, '{"type":"event","event":"recording_started","message":"Recording sta');

  const secondChunk = parseRecorderStdoutChunk('rted!"}\n', firstChunk.remainder);
  assert.equal(secondChunk.messages.length, 1);
  assert.equal(secondChunk.messages[0].kind, 'event');
  assert.equal(secondChunk.messages[0].payload.event, 'recording_started');
});


test('parseRecorderStdoutChunk parses recorder config events without stderr fallbacks', () => {
  const chunk = [
    '{"type":"event","event":"configuring_devices","message":"Configuring audio devices..."}',
    '{"type":"event","event":"mic_stream_opened","message":"Microphone stream opened"}',
    '{"type":"event","event":"desktop_stream_opened","message":"Desktop audio stream opened"}',
    '{"type":"event","event":"recording_started","message":"Recording started!"}',
    '',
  ].join('\n');

  const result = parseRecorderStdoutChunk(chunk);

  assert.deepEqual(result.messages.map((message) => message.payload.event), [
    'configuring_devices',
    'mic_stream_opened',
    'desktop_stream_opened',
    'recording_started',
  ]);
});


test('getRecorderEventAction maps structured recorder events to renderer actions', () => {
  assert.deepEqual(
    getRecorderEventAction({ event: 'configuring_devices', message: 'Configuring audio devices...' }),
    {
      initProgress: {
        stage: 'configuring',
        message: 'Configuring audio devices...',
      },
      warning: null,
      recordingStartedMessage: null,
      progressMessage: null,
    },
  );

  assert.deepEqual(
    getRecorderEventAction({
      event: 'desktop_capture_disabled',
      message: 'Desktop audio capture is disabled. Recording microphone only.',
      code: 'NO_DESKTOP_AUDIO',
      help: 'Ensure audiocapture-helper is bundled or install PyObjC as fallback.',
    }),
    {
      initProgress: {
        stage: 'desktop_disabled',
        message: 'Desktop audio capture is disabled. Recording microphone only.',
      },
      warning: {
        code: 'NO_DESKTOP_AUDIO',
        message: 'Desktop audio capture is disabled. Recording microphone only.',
        help: 'Ensure audiocapture-helper is bundled or install PyObjC as fallback.',
        type: 'desktop_capture_disabled',
      },
      recordingStartedMessage: null,
      progressMessage: null,
    },
  );

  assert.deepEqual(
    getRecorderEventAction({ event: 'recording_started', message: 'Recording started!' }),
    {
      initProgress: null,
      warning: null,
      recordingStartedMessage: 'Recording started!',
      progressMessage: null,
    },
  );
});


test('isModelDownloadErrorOutput ignores non-critical warnings but flags actual errors', () => {
  assert.equal(isModelDownloadErrorOutput('ERROR: failed to download model'), true);
  assert.equal(isModelDownloadErrorOutput('non-critical error: retrying download'), false);
});


test('getRecordingStopTimeout uses a minimum timeout when recording has not started', () => {
  assert.equal(getRecordingStopTimeout(null, 5000), 30000);
});


test('getRecordingStopTimeout scales with recording duration', () => {
  assert.equal(getRecordingStopTimeout(0, 61000), 50000);
});


test('resolveStopTimeoutAction keeps the in-flight stop promise during graceful quit timeout', () => {
  assert.deepEqual(resolveStopTimeoutAction({
    forceKillOnTimeout: false,
    errorMessage: 'Recorder stop is taking longer than expected.',
    timeoutMessage: 'Recorder stop is taking longer than expected.',
    hasRecordingProcess: true,
  }), {
    timedOut: true,
    shouldKillProcess: false,
    shouldKeepStopPromise: true,
  });
});


test('resolveStopTimeoutAction kills the recorder on stop timeout when forced', () => {
  assert.deepEqual(resolveStopTimeoutAction({
    forceKillOnTimeout: true,
    errorMessage: 'Recording stop timeout - process took too long to finish',
    timeoutMessage: 'Recording stop timeout - process took too long to finish',
    hasRecordingProcess: true,
  }), {
    timedOut: true,
    shouldKillProcess: true,
    shouldKeepStopPromise: true,
  });
});


test('getQuitInterceptState ignores quit interception when no recorder is active', () => {
  assert.deepEqual(getQuitInterceptState({
    hasRecordingProcess: false,
    recordingStartTime: Date.now(),
    stopInProgress: false,
  }), {
    interceptQuit: false,
    state: 'idle',
    progressMessage: null,
  });
});


test('getQuitInterceptState treats an active recording as graceful-stop eligible', () => {
  assert.deepEqual(getQuitInterceptState({
    hasRecordingProcess: true,
    recordingStartTime: 123,
    stopInProgress: false,
  }), {
    interceptQuit: true,
    state: 'recording',
    progressMessage: 'Stopping and saving the current recording before quitting...',
  });
});


test('getQuitInterceptState prioritizes an in-progress stop over recording state', () => {
  assert.deepEqual(getQuitInterceptState({
    hasRecordingProcess: true,
    recordingStartTime: 123,
    stopInProgress: true,
  }), {
    interceptQuit: true,
    state: 'stopping',
    progressMessage: 'Finishing the current recording before quitting...',
  });
});


test('buildQuitRecordingDialogOptions warns clearly about recording data loss', () => {
  const result = buildQuitRecordingDialogOptions({
    quitState: 'recording',
    stopErrorMessage: 'Recorder stop is taking longer than expected.',
  });

  assert.equal(result.title, 'Recording Still In Progress');
  assert.equal(result.message, 'Meeting Transcriber could not stop and save the current recording cleanly.');
  assert.match(result.detail, /Recorder stop is taking longer than expected\./);
  assert.match(result.detail, /may discard the in-progress recording/i);
  assert.deepEqual(result.buttons, ['Keep App Open', 'Quit Anyway']);
});


test('buildPermissionErrorMessage includes error and help details', () => {
  assert.equal(
    buildPermissionErrorMessage('Screen Recording', {
      error: 'Screen Recording permission not granted',
      help: 'Open System Settings > Privacy & Security > Screen Recording',
    }),
    'Screen Recording permission is not granted. Screen Recording permission not granted Open System Settings > Privacy & Security > Screen Recording',
  );
});


test('buildRecordingPreflightReport blocks start when device validation returns errors', () => {
  const result = buildRecordingPreflightReport({
    platform: 'darwin',
    deviceCheck: {
      valid: false,
      errors: ['Microphone device (ID: 3) not found. It may have been disconnected.'],
      warnings: [],
    },
    diskCheck: { success: true, warning: null },
    audioOutputCheck: { supported: true, warning: null },
  });

  assert.equal(result.canStart, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errorMessage, /Recording checks failed:/);
  assert.match(result.errorMessage, /Microphone device/);
  assert.match(result.errorMessage, /System Settings > Privacy & Security > Microphone/);
});


test('buildRecordingPreflightReport combines disk and audio output warnings', () => {
  const result = buildRecordingPreflightReport({
    platform: 'darwin',
    deviceCheck: {
      valid: true,
      errors: [],
      warnings: ['Non-standard loopback device selected on macOS.'],
    },
    diskCheck: {
      success: true,
      warning: 'Low disk space (< 500MB)',
      availableGB: '0.42',
    },
    audioOutputCheck: {
      supported: true,
      warning: null,
      deviceName: 'AirPods Pro',
      deviceTransport: 'Bluetooth',
    },
  });

  assert.equal(result.canStart, true);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warningMessage, /Recording checks found warnings:/);
  assert.match(result.warningMessage, /Only 0.42 GB free/);
  assert.match(result.warningMessage, /Continue anyway\?/);
});


test('buildRecordingPreflightReport blocks start with actionable macOS permission guidance', () => {
  const result = buildRecordingPreflightReport({
    platform: 'darwin',
    deviceCheck: { valid: true, errors: [], warnings: [] },
    diskCheck: { success: true, warning: null },
    audioOutputCheck: { supported: true, warning: null },
    permissionCheck: {
      all_granted: false,
      microphone: {
        granted: false,
        error: 'No input devices found (permission may be denied)',
        help: 'Grant microphone permission in: System Settings > Privacy & Security > Microphone',
      },
      screen_recording: {
        granted: false,
        error: 'Screen Recording permission not granted',
        help: 'Grant Screen Recording permission in: System Settings > Privacy & Security > Screen Recording',
      },
    },
  });

  assert.equal(result.canStart, false);
  assert.equal(result.permissionStatus.missingMicrophone, true);
  assert.equal(result.permissionStatus.missingScreenRecording, true);
  assert.equal(result.permissionStatus.settingsTarget, 'privacy');
  assert.match(result.errorMessage, /Microphone permission is not granted/);
  assert.match(result.errorMessage, /Screen Recording permission is not granted/);
});
