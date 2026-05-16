const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mainProcessHelpers = require('../../src/main-process-helpers');

const {
  buildFileUrl,
  buildDesktopAudioAvailabilityError,
  buildMacOSPermissionCheckFailureStatus,
  isTrustedExternalUrl,
  buildPermissionErrorMessage,
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  buildDiarizationOutputPath,
  buildModelDownloadCheck,
  buildPythonModuleArgs,
  buildTranscriberArgs,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  getQuitInterceptState,
  getRecorderCloseAction,
  getRecorderEventAction,
  getMacMLXCacheDir,
  getMacMLXModelStorageDirs,
  getModelDownloadPatterns,
  getRecordingStopTimeout,
  getTranscriberModule,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  parseAiBackendProgressLine,
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  resolveExternalUrl,
  resolveTranscriptionAudioFile,
  splitBufferedLines,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
} = mainProcessHelpers;


test('buildModelDownloadCheck returns Windows faster-whisper cache settings', () => {
  const result = buildModelDownloadCheck({
    platform: 'win32',
    arch: 'x64',
    homeDir: '/Users/tester',
    modelSize: 'medium',
  });

  assert.equal(result.cacheDir, path.join('/Users/tester', '.cache', 'huggingface', 'hub'));
  assert.deepEqual(result.modelPatterns, [
    'models--Systran--faster-whisper-medium',
    'models--guillaumekln--faster-whisper-medium',
  ]);
  assert.equal(result.modelSize, 'medium');
});


test('buildFileUrl returns a file URL for absolute paths', () => {
  const absolutePath = path.resolve('/tmp/demo audio.opus');

  assert.match(buildFileUrl(absolutePath), /^file:\/\//);
  assert.match(buildFileUrl(absolutePath), /demo%20audio\.opus$/);
});


test('buildFileUrl preserves existing file URLs', () => {
  assert.equal(
    buildFileUrl('file:///tmp/demo.opus'),
    'file:///tmp/demo.opus',
  );
});


test('isTrustedExternalUrl only allows explicit external destinations', () => {
  assert.equal(isTrustedExternalUrl('https://github.com/AmirArshad/meeting-transcriber'), true);
  assert.equal(isTrustedExternalUrl('https://github.com/AmirArshad/meeting-transcriber/releases/download/v1.8.0/app.exe'), true);
  assert.equal(isTrustedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy'), true);
  assert.equal(isTrustedExternalUrl('https://example.com'), false);
  assert.equal(isTrustedExternalUrl('https://github.com/electron/electron'), false);
  assert.equal(isTrustedExternalUrl('https://github.com/AmirArshad/meeting-transcriber-malicious'), false);
  assert.equal(isTrustedExternalUrl('http://example.com'), false);
  assert.equal(isTrustedExternalUrl('file:///tmp/demo.opus'), false);
  assert.equal(isTrustedExternalUrl('not a url'), false);
});


test('resolveExternalUrl returns null for untrusted external URLs', () => {
  assert.equal(resolveExternalUrl('https://github.com/AmirArshad/meeting-transcriber'), 'https://github.com/AmirArshad/meeting-transcriber');
  assert.equal(resolveExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy'), 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  assert.equal(resolveExternalUrl('javascript:alert(1)'), null);
});


test('resolveTranscriptionAudioFile keeps existing wav fallback files', () => {
  const wavPath = path.join('/recordings', 'fallback.wav');

  assert.equal(
    resolveTranscriptionAudioFile({
      audioFile: wavPath,
      recordingsDir: '/recordings',
      existsSync: (candidate) => candidate === wavPath,
    }),
    wavPath,
  );
});


test('resolveTranscriptionAudioFile uses opus sibling only when wav is missing', () => {
  const wavPath = path.join('/recordings', 'recording.wav');
  const opusPath = path.join('/recordings', 'recording.opus');

  assert.equal(
    resolveTranscriptionAudioFile({
      audioFile: 'recording.wav',
      recordingsDir: '/recordings',
      existsSync: (candidate) => candidate === opusPath,
    }),
    opusPath,
  );
});


test('buildDiarizationOutputPath creates speakers sidecar path', () => {
  assert.equal(
    buildDiarizationOutputPath({ audioPath: path.join('/recordings', 'meeting_20260107_104555.opus') }),
    path.join('/recordings', 'meeting_20260107_104555.speakers.json'),
  );
  assert.equal(
    buildDiarizationOutputPath({
      audioPath: path.join('/recordings', 'meeting.opus'),
      outputPath: path.join('/custom', 'meeting.speakers.json'),
    }),
    path.join('/custom', 'meeting.speakers.json'),
  );
});


test('parseAiBackendProgressLine returns redacted progress events only', () => {
  const event = parseAiBackendProgressLine(JSON.stringify({
    type: 'progress',
    feature: 'diarization',
    phase: 'loading model',
    message: 'Loading with hf_secret_token',
    percent: 120,
    transcriptText: 'do not expose',
    token: 'hf_secret_token',
  }), 'diarization');

  assert.deepEqual(event, {
    feature: 'diarization',
    phase: 'loading-model',
    message: 'Loading with [redacted-token]',
    percent: 100,
  });
  assert.equal(parseAiBackendProgressLine('not json', 'diarization'), null);
  assert.equal(parseAiBackendProgressLine('{"type":"progress","feature":"summary"}', 'diarization'), null);
});


test('buildModelDownloadCheck returns macOS MLX cache settings for Apple Silicon', () => {
  const result = buildModelDownloadCheck({
    platform: 'darwin',
    arch: 'arm64',
    homeDir: '/Users/tester',
    modelSize: 'small',
  });

  assert.equal(result.cacheDir, path.join('/Users/tester', 'Library', 'Caches', 'avanevis', 'mlx_models'));
  assert.deepEqual(result.modelPatterns, [
    'distil-small.en',
    'whisper-small-mlx',
  ]);
});


test('getMacMLXCacheDir returns writable MLX cache path', () => {
  assert.equal(
    getMacMLXCacheDir('/Users/tester'),
    path.join('/Users/tester', 'Library', 'Caches', 'avanevis', 'mlx_models'),
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


test('getTranscriberModule returns packaged-safe module names', () => {
  assert.equal(
    getTranscriberModule('win32', 'x64'),
    'transcription.faster_whisper_transcriber',
  );
  assert.equal(
    getTranscriberModule('darwin', 'arm64'),
    'transcription.mlx_whisper_transcriber',
  );
  assert.equal(
    getTranscriberModule('darwin', 'x64'),
    'transcription.faster_whisper_transcriber',
  );
});


test('buildTranscriberArgs runs transcribers as modules for relative imports', () => {
  assert.deepEqual(
    buildTranscriberArgs({
      platform: 'win32',
      arch: 'x64',
      extraArgs: ['--file', 'demo.opus', '--json'],
    }),
    [
      '-m',
      'transcription.faster_whisper_transcriber',
      '--file',
      'demo.opus',
      '--json',
    ],
  );
});


test('buildPythonModuleArgs builds generic backend module entrypoints', () => {
  assert.deepEqual(
    buildPythonModuleArgs('meeting_manager', ['list']),
    ['-m', 'meeting_manager', 'list'],
  );
  assert.deepEqual(
    buildPythonModuleArgs('device_manager'),
    ['-m', 'device_manager'],
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
  const result = classifyRecorderStdoutChunk('diagnostic output');

  assert.deepEqual(result, {
    type: 'progress',
    output: 'diagnostic output',
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


test('parseRecorderMessageLine preserves structured recorder startup errors', () => {
  const result = parseRecorderMessageLine(
    '{"type":"error","code":"MIC_START_FAILED","message":"Microphone recording failed"}',
  );

  assert.equal(result.kind, 'error');
  assert.deepEqual(result.payload, {
    type: 'error',
    code: 'MIC_START_FAILED',
    message: 'Microphone recording failed',
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


test('getRecorderEventAction maps required stdout startup events to renderer actions', () => {
  const requiredEvents = [
    {
      payload: { event: 'configuring_devices', message: 'Configuring audio devices...' },
      expected: {
        initProgress: {
          stage: 'configuring',
          message: 'Configuring audio devices...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      },
    },
    {
      payload: { event: 'mic_stream_opened', message: 'Microphone stream opened' },
      expected: {
        initProgress: {
          stage: 'mic_opened',
          message: 'Microphone stream opened',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      },
    },
    {
      payload: { event: 'desktop_stream_opened', message: 'Desktop audio stream opened' },
      expected: {
        initProgress: {
          stage: 'desktop_opened',
          message: 'Desktop audio stream opened',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      },
    },
    {
      payload: { event: 'recording_started', message: 'Recording started!' },
      expected: {
        initProgress: null,
        warning: null,
        recordingStartedMessage: 'Recording started!',
        progressMessage: null,
      },
    },
  ];

  for (const { payload, expected } of requiredEvents) {
    assert.deepEqual(getRecorderEventAction(payload), expected);
  }

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


test('main process helpers do not export a recorder stderr control parser', () => {
  assert.equal(Object.hasOwn(mainProcessHelpers, 'getRecorderStderrAction'), false);
});


test('getRecorderCloseAction clears active recording after unexpected recorder exit', () => {
  assert.deepEqual(getRecorderCloseAction({
    recordingStarted: true,
    stopInProgress: false,
    exitCode: 1,
  }), {
    type: 'unexpected_exit',
    errorMessage: null,
    warning: {
      type: 'recorder_exited',
      code: 'RECORDER_EXITED',
      level: 'error',
      message: 'Recorder exited unexpectedly after startup with code 1.',
      help: 'The recording process stopped unexpectedly. Start a new recording when ready.',
    },
  });
});


test('getRecorderCloseAction preserves startup failure guidance before recording starts', () => {
  const result = getRecorderCloseAction({
    recordingStarted: false,
    stopInProgress: false,
    progressStage: 'configuring',
    exitCode: 1,
  });

  assert.equal(result.type, 'startup_failed');
  assert.match(result.errorMessage, /Recording failed to start/);
  assert.match(result.errorMessage, /selected audio devices/);
  assert.equal(result.warning, null);
});


test('getRecorderCloseAction ignores process close after startup failure was already rejected', () => {
  assert.deepEqual(getRecorderCloseAction({
    recordingStarted: false,
    stopInProgress: false,
    startupSettled: true,
    exitCode: null,
  }), {
    type: 'startup_already_settled',
    errorMessage: null,
    warning: null,
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
  assert.equal(result.message, 'AvaNevis could not stop and save the current recording cleanly.');
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


test('buildDesktopAudioAvailabilityError includes packaging guidance', () => {
  assert.equal(
    buildDesktopAudioAvailabilityError({
      error: 'audiocapture-helper not available',
      help: 'Reinstall AvaNevis',
    }),
    'Desktop audio capture is unavailable. audiocapture-helper not available Reinstall AvaNevis',
  );
});


test('buildMacOSPermissionCheckFailureStatus fails closed for recording preflight', () => {
  const result = buildMacOSPermissionCheckFailureStatus('Permission check timed out');

  assert.equal(result.platform, 'darwin');
  assert.equal(result.all_granted, false);
  assert.equal(result.warning, 'Permission check timed out');
  assert.equal(result.microphone.granted, true);
  assert.equal(result.screen_recording.granted, true);
  assert.equal(result.desktop_audio.available, false);
  assert.match(result.desktop_audio.error, /preflight could not be verified/);
});


test('macOS permission preflight timeout remains bounded', () => {
  assert.equal(Number.isInteger(MACOS_PERMISSION_CHECK_TIMEOUT_MS), true);
  assert.equal(MACOS_PERMISSION_CHECK_TIMEOUT_MS > 0, true);
  assert.equal(MACOS_PERMISSION_CHECK_TIMEOUT_MS <= 10000, true);
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


test('buildRecordingPreflightReport blocks macOS start when desktop backend is unavailable', () => {
  const result = buildRecordingPreflightReport({
    platform: 'darwin',
    deviceCheck: { valid: true, errors: [], warnings: [] },
    diskCheck: { success: true, warning: null },
    audioOutputCheck: { supported: true, warning: null },
    permissionCheck: {
      all_granted: false,
      microphone: { granted: true },
      screen_recording: { granted: true },
      desktop_audio: {
        available: false,
        error: 'Desktop audio capture backend unavailable',
        help: 'Reinstall AvaNevis or rebuild the macOS package',
      },
    },
  });

  assert.equal(result.canStart, false);
  assert.equal(result.permissionStatus.missingDesktopAudio, true);
  assert.equal(result.permissionStatus.settingsTarget, null);
  assert.match(result.errorMessage, /Desktop audio capture is unavailable/);
  assert.match(result.errorMessage, /rebuild the macOS package/);
});
