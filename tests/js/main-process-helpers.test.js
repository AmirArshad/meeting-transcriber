const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mainProcessHelpers = require('../../src/main-process-helpers');
const { createLineChunkRedactor } = require('../../src/ai-progress-sanitizer');

const {
  buildFileUrl,
  buildDesktopAudioAvailabilityError,
  buildMacOSPermissionCheckFailureStatus,
  isTrustedExternalUrl,
  buildPermissionErrorMessage,
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  buildDiarizationOutputPath,
  buildGuidedTranscriptTempPath,
  buildHuggingFaceOfflineEnv,
  buildTranscriptionRuntimeEnv,
  buildModelDownloadCheck,
  runGuidedTranscriptionProcess,
  buildPythonModuleArgs,
  buildTranscriberArgs,
  buildTranscriptionCudaInstallArgs,
  buildTranscriptionCudaUninstallArgs,
  buildUnsupportedCudaPythonMessage,
  cacheContainsModel,
  getPythonSitePackagesCandidates,
  getPyTorchCudaBinCandidates,
  classifyRecorderStdoutChunk,
  cacheContainsCompleteTranscriptionModel,
  getQuitInterceptState,
  getRecorderCloseAction,
  getRecorderEventAction,
  findRecorderResultPayload,
  getRecorderResultAudioPath,
  getMacMLXCacheDir,
  getMacMLXModelStorageDirs,
  getGuidedTranscriptionTimeoutMinutes,
  getModelDownloadPatterns,
  getRecordingStopTimeout,
  getTranscriberModule,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  isSafeRecordingsAudioPath,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  isSupportedCudaInstallPythonVersion,
  parseAiBackendProgressLine,
  parsePythonVersion,
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  redactSensitiveText,
  resolveExternalUrl,
  resolveTranscriptionAudioFile,
  summarizeAiBackendError,
  splitBufferedLines,
  appendCappedSpawnLogBuffer,
  appendSpawnJsonResultBuffer,
  buildRecorderBusyResponse,
  normalizeModelSize,
  isRecorderBusy,
  ALLOWED_WHISPER_MODELS,
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
  assert.equal(isTrustedExternalUrl('https://huggingface.co/pyannote/speaker-diarization-community-1'), true);
  assert.equal(isTrustedExternalUrl('https://huggingface.co/settings/tokens'), true);
  assert.equal(isTrustedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy'), true);
  assert.equal(isTrustedExternalUrl('https://example.com'), false);
  assert.equal(isTrustedExternalUrl('https://github.com/electron/electron'), false);
  assert.equal(isTrustedExternalUrl('https://huggingface.co/pyannote/speaker-diarization-community-1-malicious'), false);
  assert.equal(isTrustedExternalUrl('https://huggingface.co/pyannote/other-model'), false);
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
    path.join('/recordings', 'meeting.speakers.json'),
  );
});


test('buildGuidedTranscriptTempPath creates hidden markdown temp path', () => {
  assert.equal(
    buildGuidedTranscriptTempPath({ finalTranscriptPath: path.join('/recordings', 'meeting_1.md'), now: 1234 }),
    path.join('/recordings', '.meeting_1.guided.1234.tmp.md'),
  );
});


test('getGuidedTranscriptionTimeoutMinutes scales by model size', () => {
  assert.equal(getGuidedTranscriptionTimeoutMinutes('base'), 60);
  assert.equal(getGuidedTranscriptionTimeoutMinutes('medium'), 135);
  assert.equal(getGuidedTranscriptionTimeoutMinutes('large-v3'), 180);
  assert.equal(getGuidedTranscriptionTimeoutMinutes('custom'), 90);
});


function createFakeGuidedProcess() {
  const handlers = { stdout: {}, stderr: {}, process: {} };
  return {
    stdout: { on: (event, callback) => { handlers.stdout[event] = callback; } },
    stderr: { on: (event, callback) => { handlers.stderr[event] = callback; } },
    on: (event, callback) => { handlers.process[event] = callback; },
    emitStdout: (data) => handlers.stdout.data(Buffer.from(data)),
    emitStderr: (data) => handlers.stderr.data(Buffer.from(data)),
    close: (code) => handlers.process.close(code),
    error: (error) => handlers.process.error(error),
  };
}


test('runGuidedTranscriptionProcess renames temp transcript on success', async () => {
  const fakeProcess = createFakeGuidedProcess();
  const operations = [];
  const run = runGuidedTranscriptionProcess({
    spawnProcess: () => fakeProcess,
    args: ['-m', 'diarization.guided_transcription'],
    cwd: '/backend',
    env: {},
    finalTranscriptPath: '/recordings/meeting.md',
    tempTranscriptPath: '/recordings/.meeting.guided.1.tmp.md',
    modelSize: 'base',
    fsPromises: {
      rename: async (from, to) => operations.push(['rename', from, to]),
      readFile: async (filePath, encoding) => {
        operations.push(['readFile', filePath, encoding]);
        return '# transcript';
      },
      rm: async (filePath, options) => operations.push(['rm', filePath, options]),
    },
    terminateProcess: () => operations.push(['terminate']),
    summarizeError: () => '',
    setTimer: () => 'timer',
    clearTimer: (timer) => operations.push(['clearTimer', timer]),
  });

  fakeProcess.emitStdout(JSON.stringify({ text: 'ok', segments: [] }));
  fakeProcess.close(0);
  const result = await run;

  assert.equal(result.output_file, '/recordings/meeting.md');
  assert.equal(result.transcriptContent, '# transcript');
  assert.deepEqual(operations, [
    ['rename', '/recordings/.meeting.guided.1.tmp.md', '/recordings/meeting.md'],
    ['readFile', '/recordings/meeting.md', 'utf8'],
    ['clearTimer', 'timer'],
  ]);
});


test('runGuidedTranscriptionProcess cleans temp transcript on failure', async () => {
  const fakeProcess = createFakeGuidedProcess();
  const operations = [];
  const run = runGuidedTranscriptionProcess({
    spawnProcess: () => fakeProcess,
    args: [],
    cwd: '/backend',
    env: {},
    finalTranscriptPath: '/recordings/meeting.md',
    tempTranscriptPath: '/recordings/.meeting.guided.1.tmp.md',
    modelSize: 'base',
    fsPromises: {
      rename: async () => operations.push(['rename']),
      readFile: async () => '# transcript',
      rm: async (filePath, options) => operations.push(['rm', filePath, options]),
    },
    terminateProcess: () => operations.push(['terminate']),
    summarizeError: () => 'pyannote failed',
    setTimer: () => 'timer',
    clearTimer: (timer) => operations.push(['clearTimer', timer]),
  });

  fakeProcess.close(1);
  await assert.rejects(run, /pyannote failed/);
  assert.deepEqual(operations, [
    ['rm', '/recordings/.meeting.guided.1.tmp.md', { force: true }],
    ['clearTimer', 'timer'],
  ]);
});


test('runGuidedTranscriptionProcess terminates and cleans temp transcript on timeout', async () => {
  const fakeProcess = createFakeGuidedProcess();
  const operations = [];
  let timeoutCallback;
  const run = runGuidedTranscriptionProcess({
    spawnProcess: () => fakeProcess,
    args: [],
    cwd: '/backend',
    env: {},
    finalTranscriptPath: '/recordings/meeting.md',
    tempTranscriptPath: '/recordings/.meeting.guided.1.tmp.md',
    modelSize: 'base',
    fsPromises: {
      rename: async () => operations.push(['rename']),
      readFile: async () => '# transcript',
      rm: async (filePath, options) => operations.push(['rm', filePath, options]),
    },
    terminateProcess: () => operations.push(['terminate']),
    summarizeError: () => '',
    setTimer: (callback, timeoutMs) => {
      timeoutCallback = callback;
      operations.push(['setTimer', timeoutMs]);
      return 'timer';
    },
    clearTimer: (timer) => operations.push(['clearTimer', timer]),
  });

  timeoutCallback();
  await assert.rejects(run, /timeout after 60 minutes/);
  assert.deepEqual(operations, [
    ['setTimer', 60 * 60 * 1000],
    ['terminate'],
    ['rm', '/recordings/.meeting.guided.1.tmp.md', { force: true }],
  ]);
});


test('isSafeRecordingsMarkdownPath allows only markdown files inside recordings', () => {
  const recordingsDir = path.join('/tmp', 'AvaNevis', 'recordings');

  assert.equal(isSafeRecordingsMarkdownPath({
    filePath: path.join(recordingsDir, 'meeting_20260107_104555.md'),
    recordingsDir,
  }), true);
  assert.equal(isSafeRecordingsMarkdownPath({
    filePath: path.join(recordingsDir, 'meeting_20260107_104555.txt'),
    recordingsDir,
  }), false);
  assert.equal(isSafeRecordingsMarkdownPath({
    filePath: path.join('/tmp', 'AvaNevis', 'other', 'meeting.md'),
    recordingsDir,
  }), false);
  assert.equal(isSafeRecordingsJsonPath({
    filePath: path.join(recordingsDir, 'meeting.speakers.json'),
    recordingsDir,
  }), true);
  assert.equal(isSafeRecordingsJsonPath({
    filePath: path.join(recordingsDir, '..', 'meeting.speakers.json'),
    recordingsDir,
  }), false);
  assert.equal(isSafeRecordingsAudioPath({
    filePath: path.join(recordingsDir, 'meeting.opus'),
    recordingsDir,
  }), true);
});


test('isSafeRecordingsAudioPath rejects symlinks that resolve outside recordings', (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlink path hardening test requires Unix-style symlinks.');
    return;
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-recordings-safe-'));
  const recordingsDir = path.join(rootDir, 'recordings');
  const outsideFile = path.join(rootDir, 'outside.opus');
  const symlinkPath = path.join(recordingsDir, 'linked.opus');

  try {
    fs.mkdirSync(recordingsDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside');
    fs.symlinkSync(outsideFile, symlinkPath);

    assert.equal(isSafeRecordingsAudioPath({
      filePath: symlinkPath,
      recordingsDir,
    }), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});


test('parseAiBackendProgressLine returns redacted progress events only', () => {
  const event = parseAiBackendProgressLine(JSON.stringify({
    type: 'progress',
    feature: 'diarization',
    phase: 'loading model',
    message: 'Loading with hf_secret_token',
    percent: 120,
    downloadedBytes: 600.9,
    totalBytes: 500.1,
    transcriptText: 'do not expose',
    token: 'hf_secret_token',
  }), 'diarization');

  assert.deepEqual(event, {
    feature: 'diarization',
    phase: 'loading-model',
    message: 'Loading with [redacted-token]',
    percent: 100,
    // Progress bytes are floored and clamped so downloaded never exceeds total.
    downloadedBytes: 500,
    totalBytes: 500,
  });
  assert.equal(parseAiBackendProgressLine('not json', 'diarization'), null);
  assert.equal(parseAiBackendProgressLine('{"type":"progress","feature":"summary"}', 'diarization'), null);
});


test('redactSensitiveText removes bearer tokens and URL credentials', () => {
  const redacted = redactSensitiveText('Authorization: Bearer abc.DEF_123 Authorization: token ghp_secret X-Api-Key: key123 https://user:secret@huggingface.co/model?token=secret&access_token=other&api_key=third hf_secret_token');

  assert.equal(redacted.includes('abc.DEF_123'), false);
  assert.equal(redacted.includes('ghp_secret'), false);
  assert.equal(redacted.includes('key123'), false);
  assert.equal(redacted.includes('user:secret'), false);
  assert.equal(redacted.includes('token=secret'), false);
  assert.equal(redacted.includes('access_token=other'), false);
  assert.equal(redacted.includes('api_key=third'), false);
  assert.equal(redacted.includes('hf_secret_token'), false);
  assert.match(redacted, /Bearer \[redacted-token]/);
  assert.match(redacted, /Authorization: token \[redacted-token]/);
  assert.match(redacted, /X-Api-Key: \[redacted-token]/);
  assert.match(redacted, /https:\/\/\[redacted]@huggingface\.co/);
});


test('redactSensitiveText preserves at signs outside URL credentials', () => {
  const url = 'https://api.huggingface.co/models?webhook=user@example.com#team@docs';

  assert.equal(redactSensitiveText(url), url);
});

test('createLineChunkRedactor redacts tokens split across stderr chunks', () => {
  const redactor = createLineChunkRedactor();
  const first = redactor.redactChunk('prefix hf_abc');
  assert.equal(first, '');

  const second = redactor.redactChunk('123token suffix\nnext line hf_other\n');
  assert.match(second, /\[redacted-token]/);
  assert.equal(second.includes('hf_abc123token'), false);
  assert.match(second, /next line \[redacted-token]/);
});

test('createLineChunkRedactor flush emits trailing partial line', () => {
  const redactor = createLineChunkRedactor();
  assert.equal(redactor.redactChunk('still running hf_secret_token'), '');
  assert.equal(redactor.flush(), 'still running [redacted-token]');
  assert.equal(redactor.flush(), '');
});

test('createLineChunkRedactor caps unbounded newline-free remainder', () => {
  const redactor = createLineChunkRedactor({ maxRemainderChars: 8 });
  assert.equal(redactor.redactChunk('123456789'), '');
  assert.equal(redactor.flush(), '23456789');
});

test('normalizeModelSize accepts allowlisted sizes and rejects unknown values', () => {
  assert.deepEqual(normalizeModelSize('small'), { ok: true, modelSize: 'small' });
  assert.deepEqual(normalizeModelSize(''), { ok: true, modelSize: 'small' });
  assert.deepEqual(normalizeModelSize('large-v3'), { ok: true, modelSize: 'large-v3' });
  assert.equal(normalizeModelSize('../../../etc/passwd').ok, false);
  assert.equal(ALLOWED_WHISPER_MODELS.includes('small'), true);
});

test('isRecorderBusy detects active recorder or stop workflow', () => {
  assert.equal(isRecorderBusy({ pythonProcess: null, recordingStopPromise: null }), false);
  assert.equal(isRecorderBusy({ pythonProcess: {}, recordingStopPromise: null }), true);
  assert.equal(isRecorderBusy({ pythonProcess: null, recordingStopPromise: Promise.resolve() }), true);
});

test('buildRecorderBusyResponse returns structured busy error', () => {
  assert.deepEqual(buildRecorderBusyResponse(), {
    success: false,
    code: 'RECORDER_BUSY',
    message: 'Recorder is already active or finishing a previous recording.',
  });
});

test('appendCappedSpawnLogBuffer keeps the tail when stderr exceeds the cap', () => {
  const capped = appendCappedSpawnLogBuffer('0123456789', 'abcdef', 8);
  assert.equal(capped, '89abcdef');
});

test('appendSpawnJsonResultBuffer rejects growth beyond the JSON result cap', () => {
  const within = appendSpawnJsonResultBuffer('abc', 'def', 10);
  assert.equal(within.overflowed, false);
  assert.equal(within.buffer, 'abcdef');

  const overflow = appendSpawnJsonResultBuffer('0123456789', 'abc', 10);
  assert.equal(overflow.overflowed, true);
  assert.equal(overflow.buffer, '0123456789');
});


test('summarizeAiBackendError redacts sensitive values and local paths', () => {
  const summary = summarizeAiBackendError({
    errorOutput: [
      'Speaker diarization failed.',
      'ERROR: failed at /Users/tester/AppData/AvaNevis/ai-addons with Authorization: Bearer secret.token and https://user:pass@huggingface.co/model hf_secret_token',
    ].join('\n'),
    userDataDir: '/Users/tester/AppData/AvaNevis',
    homeDir: '/Users/tester',
    genericMessage: 'Speaker diarization failed.',
  });

  assert.equal(summary.includes('secret.token'), false);
  assert.equal(summary.includes('user:pass'), false);
  assert.equal(summary.includes('hf_secret_token'), false);
  assert.equal(summary.includes('/Users/tester'), false);
  assert.match(summary, /<userData>\/ai-addons/);
  assert.match(summary, /Bearer \[redacted-token]/);
});


test('summarizeAiBackendError ignores Python module execution warnings', () => {
  const summary = summarizeAiBackendError({
    errorOutput: [
      "<frozen runpy>:128: RuntimeWarning: 'summaries.summary_runner' found in sys.modules after import of package 'summaries', but prior to execution of 'summaries.summary_runner'; this may result in unpredictable behaviour",
      'ERROR: Local summary runtime validation failed: missing llama-cli',
    ].join('\n'),
    genericMessage: 'Local summary generation failed.',
  });

  assert.equal(summary, 'Local summary runtime validation failed: missing llama-cli');
});


test('summarizeAiBackendError preserves local runtime import failures', () => {
  const summary = summarizeAiBackendError({
    errorOutput: [
      '{"type":"progress","feature":"diarization","phase":"error","message":"Speaker diarization failed."}',
      "ERROR: partially initialized module 'torchvision' has no attribute 'extension' (most likely due to a circular import)",
    ].join('\n'),
    genericMessage: 'Speaker diarization failed.',
  });

  assert.equal(summary, "partially initialized module 'torchvision' has no attribute 'extension' (most likely due to a circular import)");
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
  assert.deepEqual(getMacMLXModelStorageDirs('small'), ['whisper-small-mlx']);
  assert.deepEqual(getMacMLXModelStorageDirs('medium'), ['whisper-medium-mlx']);
  assert.deepEqual(getMacMLXModelStorageDirs('large'), ['whisper-large-v3-mlx']);
});


test('getModelDownloadPatterns returns macOS Apple Silicon MLX patterns', () => {
  assert.deepEqual(getModelDownloadPatterns('darwin', 'arm64', 'small'), [
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


test('cacheContainsCompleteTranscriptionModel requires faster-whisper snapshot files', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-fw-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const snapshotDir = path.join(cacheDir, 'models--Systran--faster-whisper-small', 'snapshots', 'abc123');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(snapshotDir, 'model.bin'), 'weights');
  fs.writeFileSync(path.join(snapshotDir, 'tokenizer.json'), '{}');

  assert.equal(
    cacheContainsCompleteTranscriptionModel({
      cacheDir,
      modelPatterns: ['models--Systran--faster-whisper-small'],
      platform: 'win32',
      arch: 'x64',
    }),
    false,
  );

  fs.writeFileSync(path.join(snapshotDir, 'vocabulary.txt'), 'tokens');

  assert.equal(
    cacheContainsCompleteTranscriptionModel({
      cacheDir,
      modelPatterns: ['models--Systran--faster-whisper-small'],
      platform: 'win32',
      arch: 'x64',
    }),
    true,
  );
});


test('cacheContainsCompleteTranscriptionModel checks macOS MLX required files', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-mlx-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const modelDir = path.join(cacheDir, 'whisper-small-mlx');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'weights.npz'), 'weights');

  assert.equal(
    cacheContainsCompleteTranscriptionModel({
      cacheDir,
      modelPatterns: ['whisper-small-mlx'],
      platform: 'darwin',
      arch: 'arm64',
    }),
    false,
  );

  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');

  assert.equal(
    cacheContainsCompleteTranscriptionModel({
      cacheDir,
      modelPatterns: ['whisper-small-mlx'],
      platform: 'darwin',
      arch: 'arm64',
    }),
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


test('buildHuggingFaceOfflineEnv enables offline runtime model loading', () => {
  assert.deepEqual(
    buildHuggingFaceOfflineEnv({ PATH: 'existing-path' }),
    {
      PATH: 'existing-path',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_VERBOSITY: 'error',
    },
  );
});


test('buildTranscriptionRuntimeEnv preserves diarization cache and passes Whisper cache explicitly', () => {
  assert.deepEqual(
    buildTranscriptionRuntimeEnv({
      cacheDir: '/normal/whisper/hub',
      modelCached: true,
      baseEnv: {
        HF_HOME: '/diarization/cache',
        HF_HUB_CACHE: '/diarization/cache/hub',
        PATH: 'existing-path',
      },
    }),
    {
      HF_HOME: '/diarization/cache',
      HF_HUB_CACHE: '/diarization/cache/hub',
      PATH: 'existing-path',
      AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR: '/normal/whisper/hub',
      AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_VERBOSITY: 'error',
    },
  );
});


test('buildTranscriptionRuntimeEnv passes Whisper cache without offline mode for incomplete caches', () => {
  assert.deepEqual(
    buildTranscriptionRuntimeEnv({
      cacheDir: '/normal/whisper/hub',
      modelCached: false,
      baseEnv: { PATH: 'existing-path' },
    }),
    {
      PATH: 'existing-path',
      AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR: '/normal/whisper/hub',
    },
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


test('parsePythonVersion supports CUDA installer runtime checks', () => {
  assert.deepEqual(parsePythonVersion('Python 3.11.9'), {
    major: 3,
    minor: 11,
    patch: 9,
    version: '3.11.9',
  });
  assert.equal(parsePythonVersion('not python'), null);
  assert.equal(isSupportedCudaInstallPythonVersion(parsePythonVersion('Python 3.11.9')), true);
  assert.equal(isSupportedCudaInstallPythonVersion(parsePythonVersion('Python 3.13.2')), false);
  assert.match(
    buildUnsupportedCudaPythonMessage('Python 3.13.2'),
    /requires AvaNevis' supported Python 3\.11 runtime/,
  );
});


test('transcription CUDA installer only targets CTranslate2 runtime libraries', () => {
  assert.deepEqual(
    buildTranscriptionCudaInstallArgs(),
    ['-m', 'pip', 'install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', '--no-warn-script-location'],
  );
  assert.deepEqual(
    buildTranscriptionCudaUninstallArgs(),
    ['-m', 'pip', 'uninstall', '-y', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12', 'torch', 'torchvision', 'torchaudio'],
  );
});


test('PyTorch CUDA bin discovery includes managed dependency site-packages', () => {
  const sitePackages = [path.join('C:', 'AvaNevis', 'ai-addons', 'dependencies', 'diarization', 'site-packages')];
  const candidates = getPyTorchCudaBinCandidates(sitePackages);

  assert(candidates.includes(path.join(sitePackages[0], 'nvidia', 'cublas', 'bin')));
  assert(candidates.includes(path.join(sitePackages[0], 'nvidia', 'cuda_runtime', 'bin')));
  assert(candidates.includes(path.join(sitePackages[0], 'nvidia', 'cudnn', 'bin')));
});


test('Python site-packages candidates support Windows Python layouts', () => {
  assert.deepEqual(
    getPythonSitePackagesCandidates({
      pythonExe: path.join('C:', 'App', 'python', 'python.exe'),
      virtualEnv: path.join('C:', 'venv'),
      appData: path.join('C:', 'Users', 'Name', 'AppData', 'Roaming'),
      platform: 'win32',
    }),
    [
      path.join('C:', 'App', 'python', 'Lib', 'site-packages'),
      path.join('C:', 'venv', 'Lib', 'site-packages'),
      path.join('C:', 'Users', 'Name', 'AppData', 'Roaming', 'Python', 'Python311', 'site-packages'),
    ],
  );
  assert.deepEqual(getPythonSitePackagesCandidates({ platform: 'darwin' }), []);
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


test('parseRecorderMessageLine treats desktop diagnostics JSON as status', () => {
  const contentInfo = parseRecorderMessageLine(
    '{"type":"content_info","displayCount":1,"applicationCount":12,"windowCount":34}',
  );
  const streamConfig = parseRecorderMessageLine(
    '{"type":"stream_config","width":1728,"height":1117,"capturesAudio":true}',
  );

  assert.equal(contentInfo.kind, 'status');
  assert.equal(contentInfo.payload.displayCount, 1);
  assert.equal(streamConfig.kind, 'status');
  assert.equal(streamConfig.payload.width, 1728);
});


test('findRecorderResultPayload returns last recorder result among structured messages', () => {
  const output = [
    '{"type":"levels","mic":0.1,"desktop":0}',
    '{"type":"warning","code":"NO_DESKTOP_AUDIO_CAPTURED","message":"No desktop audio"}',
    '{"success":true,"outputPath":"/recordings/meeting.opus","duration":12.5,"desktopDiagnostics":{"bufferSamples":0}}',
  ].join('\n');

  assert.deepEqual(findRecorderResultPayload(output), {
    success: true,
    outputPath: '/recordings/meeting.opus',
    duration: 12.5,
    desktopDiagnostics: { bufferSamples: 0 },
  });
});


test('findRecorderResultPayload accepts Windows audioPath payloads', () => {
  const output = [
    '{"type":"levels","mic":0.1,"desktop":0}',
    '{"success":true,"audioPath":"C:\\\\Users\\\\me\\\\recordings\\\\meeting.opus","duration":8.25}',
  ].join('\n');

  assert.deepEqual(findRecorderResultPayload(output), {
    success: true,
    audioPath: 'C:\\Users\\me\\recordings\\meeting.opus',
    duration: 8.25,
  });
});


test('getRecorderResultAudioPath normalizes Windows and macOS recorder payloads', () => {
  assert.equal(
    getRecorderResultAudioPath({
      success: true,
      audioPath: 'C:\\recordings\\meeting.opus',
      duration: 8.25,
    }),
    'C:\\recordings\\meeting.opus',
  );
  assert.equal(
    getRecorderResultAudioPath({
      success: true,
      outputPath: '/Users/me/recordings/meeting.opus',
      duration: 12.5,
    }),
    '/Users/me/recordings/meeting.opus',
  );
  assert.equal(getRecorderResultAudioPath({ success: true, duration: 1 }), null);
});


test('findRecorderResultPayload ignores non-result JSON lines', () => {
  const output = [
    '{"type":"levels","mic":0.1,"desktop":0}',
    '{"type":"warning","code":"NO_DESKTOP_AUDIO_CAPTURED","message":"No desktop audio"}',
  ].join('\n');

  assert.equal(findRecorderResultPayload(output), null);
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


test('buildRecordingPreflightReport allows macOS start when proactive screen check is skipped', () => {
  const result = buildRecordingPreflightReport({
    platform: 'darwin',
    deviceCheck: { valid: true, errors: [], warnings: [] },
    diskCheck: { success: true, warning: null },
    audioOutputCheck: { supported: true, warning: null },
    permissionCheck: {
      all_granted: true,
      microphone: { granted: true },
      screen_recording: { granted: true },
      desktop_audio: { available: true, backend: 'swift' },
    },
  });

  assert.equal(result.canStart, true);
  assert.equal(result.permissionStatus.missingScreenRecording, false);
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
