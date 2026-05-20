const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { redactSensitiveText, createLineChunkRedactor, SENSITIVE_PROGRESS_KEY_SET } = require('./ai-progress-sanitizer');

const ALLOWED_WHISPER_MODELS = Object.freeze(['tiny', 'base', 'small', 'medium', 'large', 'large-v3']);
const SPAWN_LOG_BUFFER_MAX_CHARS = 512 * 1024;
const SPAWN_JSON_RESULT_BUFFER_MAX_CHARS = 32 * 1024 * 1024;
const UPDATER_HTTP_RESPONSE_MAX_CHARS = 1024 * 1024;

const TRUSTED_GITHUB_PATH_PREFIX = '/AmirArshad/meeting-transcriber';
const TRUSTED_HUGGING_FACE_PATHS = new Set([
  '/pyannote/speaker-diarization-community-1',
  '/settings/tokens',
]);
const MACOS_PERMISSION_CHECK_TIMEOUT_MS = 8000;
// Transcription cache completeness (keep aligned with backend/transcription/faster_whisper_transcriber.py
// and MLX _required_model_files_cached in mlx_whisper_transcriber.py; see AGENTS.md).
const FASTER_WHISPER_REQUIRED_CACHE_FILES = ['config.json', 'model.bin', 'tokenizer.json'];
const FASTER_WHISPER_VOCABULARY_CACHE_FILES = ['vocabulary.txt', 'vocabulary.json'];
const MLX_REQUIRED_CACHE_FILES = ['weights.npz', 'config.json'];

function buildFileUrl(filePath) {
  const normalizedPath = String(filePath || '').trim();

  if (!normalizedPath) {
    return '';
  }

  if (normalizedPath.startsWith('file://')) {
    return normalizedPath;
  }

  return pathToFileURL(path.resolve(normalizedPath)).toString();
}

function isTrustedExternalUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ''));

    if (parsedUrl.protocol === 'x-apple.systempreferences:') {
      return true;
    }

    if (parsedUrl.protocol !== 'https:') {
      return false;
    }

    if (parsedUrl.hostname === 'github.com') {
      return parsedUrl.pathname === TRUSTED_GITHUB_PATH_PREFIX ||
        parsedUrl.pathname.startsWith(`${TRUSTED_GITHUB_PATH_PREFIX}/`);
    }

    return parsedUrl.hostname === 'huggingface.co' &&
      TRUSTED_HUGGING_FACE_PATHS.has(parsedUrl.pathname);
  } catch (error) {
    return false;
  }
}

function resolveExternalUrl(url) {
  if (!isTrustedExternalUrl(url)) {
    return null;
  }

  return new URL(String(url)).toString();
}

function getLegalNoticesPath(options = {}) {
  const devRoot = options.devRoot || path.join(__dirname, '..');
  const resourcesPath = options.resourcesPath ? String(options.resourcesPath) : '';

  if (resourcesPath) {
    const packagedPath = path.join(resourcesPath, 'legal', 'THIRD_PARTY_NOTICES.md');
    if (fs.existsSync(packagedPath)) {
      return packagedPath;
    }
  }

  const devPath = path.join(devRoot, 'THIRD_PARTY_NOTICES.md');
  return fs.existsSync(devPath) ? devPath : null;
}

function appendCappedSpawnLogBuffer(buffer, chunk, maxChars = SPAWN_LOG_BUFFER_MAX_CHARS) {
  const combined = `${buffer || ''}${String(chunk || '')}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

function appendSpawnJsonResultBuffer(buffer, chunk, maxChars = SPAWN_JSON_RESULT_BUFFER_MAX_CHARS) {
  const current = buffer || '';
  const nextChunk = String(chunk || '');
  const nextLength = current.length + nextChunk.length;
  if (nextLength > maxChars) {
    return {
      buffer: current,
      overflowed: true,
    };
  }
  return {
    buffer: current + nextChunk,
    overflowed: false,
  };
}

function normalizeModelSize(modelSize, { defaultSize = 'small' } = {}) {
  const normalized = String(modelSize || '').trim().toLowerCase();
  if (!normalized) {
    return { ok: true, modelSize: defaultSize };
  }
  if (ALLOWED_WHISPER_MODELS.includes(normalized)) {
    return { ok: true, modelSize: normalized };
  }
  return {
    ok: false,
    modelSize: null,
    error: `Unsupported Whisper model size: ${modelSize}`,
  };
}

function isRecorderBusy({ pythonProcess = null, recordingStopPromise = null } = {}) {
  return Boolean(pythonProcess || recordingStopPromise);
}

function buildRecorderBusyResponse() {
  return {
    success: false,
    code: 'RECORDER_BUSY',
    message: 'Recorder is already active or finishing a previous recording.',
  };
}

function getModelDownloadCacheDir(homeDir) {
  return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

function getMacMLXCacheDir(homeDir) {
  return path.join(homeDir, 'Library', 'Caches', 'avanevis', 'mlx_models');
}

function getMacMLXModelStorageDirs(modelSize = 'small') {
  const size = modelSize || 'small';

  switch (size) {
    case 'tiny':
      return ['whisper-tiny-mlx'];
    case 'base':
      return ['whisper-base-mlx'];
    case 'small':
      return ['whisper-small-mlx'];
    case 'medium':
      return ['whisper-medium-mlx'];
    case 'large':
    case 'large-v3':
      return ['whisper-large-v3-mlx'];
    default:
      return [`distil-${size}.en`, `whisper-${size}-mlx`, `whisper-${size}`];
  }
}

function getModelDownloadPatterns(platform, arch, modelSize = 'small') {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  if (isMacArm) {
    return getMacMLXModelStorageDirs(size);
  }

  return [
    `models--Systran--faster-whisper-${size}`,
    `models--guillaumekln--faster-whisper-${size}`,
  ];
}

function buildModelDownloadCheck({ platform, arch, homeDir, modelSize }) {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  return {
    cacheDir: isMacArm ? getMacMLXCacheDir(homeDir) : getModelDownloadCacheDir(homeDir),
    modelPatterns: getModelDownloadPatterns(platform, arch, size),
    modelSize: size
  };
}

function getTranscriberModule(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') {
    return 'transcription.mlx_whisper_transcriber';
  }

  return 'transcription.faster_whisper_transcriber';
}

function buildPythonModuleArgs(moduleName, extraArgs = []) {
  return [
    '-m',
    moduleName,
    ...extraArgs,
  ];
}

function buildTranscriberArgs({ platform, arch, extraArgs = [] } = {}) {
  return buildPythonModuleArgs(getTranscriberModule(platform, arch), extraArgs);
}

function buildHuggingFaceOfflineEnv(extra = {}) {
  return {
    ...extra,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_VERBOSITY: 'error',
  };
}

function buildTranscriptionRuntimeEnv({ cacheDir, modelCached = false, baseEnv = {} } = {}) {
  const env = {
    ...baseEnv,
    ...(cacheDir ? { AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR: cacheDir } : {}),
  };

  return modelCached
    ? buildHuggingFaceOfflineEnv({
      ...env,
      AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY: '1',
    })
    : env;
}

function parsePythonVersion(output) {
  const match = String(output || '').match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function isSupportedCudaInstallPythonVersion(versionInfo) {
  return Boolean(versionInfo && versionInfo.major === 3 && versionInfo.minor === 11);
}

function buildUnsupportedCudaPythonMessage(versionOutput) {
  const versionInfo = parsePythonVersion(versionOutput);
  const version = versionInfo ? versionInfo.version : String(versionOutput || '').trim() || 'unknown';
  return [
    `GPU acceleration setup requires AvaNevis' supported Python 3.11 runtime, but the current runtime is Python ${version}.`,
    'Start dev mode from a Python 3.11 virtual environment, set AVANEVIS_PYTHON to a Python 3.11 executable, or install Python 3.11 so the Windows py launcher can resolve py -3.11.',
  ].join(' ');
}

const TRANSCRIPTION_CUDA_PACKAGES = Object.freeze(['nvidia-cublas-cu12', 'nvidia-cudnn-cu12']);
const LEGACY_TRANSCRIPTION_CUDA_PACKAGES = Object.freeze(['torch', 'torchvision', 'torchaudio']);
const PYTORCH_CUDA_BIN_DIRS = Object.freeze([
  ['nvidia', 'cublas', 'bin'],
  ['nvidia', 'cudnn', 'bin'],
  ['nvidia', 'cuda_runtime', 'bin'],
  ['nvidia', 'cufft', 'bin'],
  ['nvidia', 'curand', 'bin'],
  ['nvidia', 'cusolver', 'bin'],
  ['nvidia', 'cusparse', 'bin'],
  ['nvidia', 'nccl', 'bin'],
  ['nvidia', 'nvjitlink', 'bin'],
  ['nvidia', 'nvtx', 'bin'],
]);

function getPythonSitePackagesCandidates({ pythonExe = '', virtualEnv = '', appData = '', platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return [];
  }

  const pythonExeDir = pythonExe ? path.dirname(pythonExe) : '';
  const pythonRootDir = path.basename(pythonExeDir).toLowerCase() === 'scripts'
    ? path.dirname(pythonExeDir)
    : pythonExeDir;

  return [
    pythonRootDir ? path.join(pythonRootDir, 'Lib', 'site-packages') : null,
    virtualEnv ? path.join(virtualEnv, 'Lib', 'site-packages') : null,
    appData ? path.join(appData, 'Python', 'Python311', 'site-packages') : null,
  ].filter(Boolean);
}

function getPyTorchCudaBinCandidates(sitePackagesDirs = []) {
  const candidates = [];
  for (const sitePackagesDir of sitePackagesDirs || []) {
    for (const parts of PYTORCH_CUDA_BIN_DIRS) {
      candidates.push(path.join(sitePackagesDir, ...parts));
    }
  }
  return candidates;
}

function buildTranscriptionCudaInstallArgs(packages = TRANSCRIPTION_CUDA_PACKAGES) {
  return [
    '-m',
    'pip',
    'install',
    ...packages,
    '--no-warn-script-location',
  ];
}

function buildTranscriptionCudaUninstallArgs(packages = TRANSCRIPTION_CUDA_PACKAGES) {
  return [
    '-m',
    'pip',
    'uninstall',
    '-y',
    ...packages,
    ...LEGACY_TRANSCRIPTION_CUDA_PACKAGES,
  ];
}

function sanitizeAiProgressMessage(message) {
  return redactSensitiveText(message)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function summarizeAiBackendError({ errorOutput, userDataDir = '', homeDir = '', genericMessage = '' } = {}) {
  const lines = String(errorOutput || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    let cleaned = redactSensitiveText(line)
      .replace(/^ERROR:\s*/i, '')
      .trim();
    if (userDataDir) {
      cleaned = cleaned.replaceAll(userDataDir, '<userData>');
    }
    if (homeDir) {
      cleaned = cleaned.replaceAll(homeDir, '<home>');
    }
    cleaned = cleaned.trim();
    if (!cleaned
      || cleaned === genericMessage
      || /RuntimeWarning:.*found in sys\.modules.*prior to execution/.test(cleaned)) {
      continue;
    }
    return cleaned;
  }
  return '';
}

function parseAiBackendProgressLine(line, expectedFeature = null) {
  let parsed;
  try {
    parsed = JSON.parse(String(line || '').trim());
  } catch (error) {
    return null;
  }

  if (!parsed || parsed.type !== 'progress') {
    return null;
  }

  const feature = String(parsed.feature || '').trim();
  if (!feature || (expectedFeature && feature !== expectedFeature)) {
    return null;
  }

  const event = {
    feature,
    phase: String(parsed.phase || 'status').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    message: sanitizeAiProgressMessage(parsed.message),
  };

  if (Number.isFinite(parsed.percent)) {
    event.percent = Math.max(0, Math.min(100, Number(parsed.percent)));
  }
  if (Number.isFinite(parsed.downloadedBytes) && parsed.downloadedBytes >= 0) {
    event.downloadedBytes = Math.floor(parsed.downloadedBytes);
  }
  if (Number.isFinite(parsed.totalBytes) && parsed.totalBytes > 0) {
    event.totalBytes = Math.floor(parsed.totalBytes);
  }
  if (event.totalBytes && event.downloadedBytes > event.totalBytes) {
    event.downloadedBytes = event.totalBytes;
  }
  if (Number.isInteger(parsed.chunkIndex)) {
    event.chunkIndex = parsed.chunkIndex;
  }
  if (Number.isInteger(parsed.chunkTotal)) {
    event.chunkTotal = parsed.chunkTotal;
  }
  if (typeof parsed.status === 'string' && parsed.status.trim()) {
    event.status = parsed.status.trim().slice(0, 80);
  }

  for (const key of Object.keys(parsed)) {
    if (SENSITIVE_PROGRESS_KEY_SET.has(key)) {
      delete event[key];
    }
  }

  return event;
}

function buildDiarizationOutputPath({ audioPath } = {}) {
  const sourcePath = String(audioPath || '');
  const parsedPath = path.parse(sourcePath);
  return path.join(parsedPath.dir || '.', `${parsedPath.name || 'meeting'}.speakers.json`);
}

function buildGuidedTranscriptTempPath({ finalTranscriptPath, now = Date.now() } = {}) {
  const parsedPath = path.parse(String(finalTranscriptPath || 'meeting.md'));
  return path.join(parsedPath.dir || '.', `.${parsedPath.name || 'meeting'}.guided.${now}.tmp.md`);
}

function getGuidedTranscriptionTimeoutMinutes(modelSize) {
  const modelTimeouts = { tiny: 45, base: 60, small: 90, medium: 135, large: 180, 'large-v3': 180 };
  return modelTimeouts[modelSize] || 90;
}

function runGuidedTranscriptionProcess({
  spawnProcess,
  args,
  cwd,
  env,
  finalTranscriptPath,
  tempTranscriptPath,
  modelSize,
  fsPromises,
  terminateProcess,
  summarizeError,
  onProgressLine,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof spawnProcess !== 'function') {
    return Promise.reject(new Error('Guided transcription requires a process spawner.'));
  }

  const files = fsPromises;
  const timeoutMinutes = getGuidedTranscriptionTimeoutMinutes(modelSize);
  return new Promise((resolve, reject) => {
    const python = spawnProcess(args, { cwd, env });
    let output = '';
    let errorOutput = '';
    let stdoutOverflowed = false;
    let hasCompleted = false;

    const cleanupTemp = () => {
      if (files && typeof files.rm === 'function' && tempTranscriptPath) {
        files.rm(tempTranscriptPath, { force: true }).catch(() => {});
      }
    };
    const finish = (callback, value) => {
      if (hasCompleted) {
        return;
      }
      hasCompleted = true;
      clearTimer(guidedTimeout);
      callback(value);
    };
    const guidedTimeout = setTimer(() => {
      if (hasCompleted) {
        return;
      }
      hasCompleted = true;
      if (typeof terminateProcess === 'function') {
        terminateProcess(python);
      }
      cleanupTemp();
      reject(new Error(`Speaker-guided transcription timeout after ${timeoutMinutes} minutes. The process may have stalled.`));
    }, timeoutMinutes * 60 * 1000);

    python.stdout.on('data', (data) => {
      const result = appendSpawnJsonResultBuffer(output, data, SPAWN_JSON_RESULT_BUFFER_MAX_CHARS);
      output = result.buffer;
      stdoutOverflowed = stdoutOverflowed || result.overflowed;
    });

    python.stderr.on('data', (data) => {
      const stderrChunk = data.toString();
      errorOutput = appendCappedSpawnLogBuffer(errorOutput, stderrChunk);
      if (typeof onProgressLine === 'function') {
        for (const line of stderrChunk.split(/\r?\n/)) {
          if (line.trim()) {
            onProgressLine(line);
          }
        }
      }
    });

    python.on('close', async (code) => {
      if (hasCompleted) return;
      if (stdoutOverflowed) {
        cleanupTemp();
        finish(reject, new Error('Speaker-guided transcription output exceeded the maximum allowed size.'));
        return;
      }
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          await files.rename(tempTranscriptPath, finalTranscriptPath);
          const transcriptContent = await files.readFile(finalTranscriptPath, 'utf8');
          finish(resolve, {
            ...result,
            output_file: finalTranscriptPath,
            transcriptContent,
          });
        } catch (error) {
          cleanupTemp();
          finish(reject, new Error(`Failed to parse speaker-guided transcription result: ${error.message}`));
        }
        return;
      }

      cleanupTemp();
      const reason = typeof summarizeError === 'function' ? summarizeError(errorOutput) : '';
      finish(reject, new Error(reason || 'Speaker-guided transcription failed.'));
    });

    python.on('error', (error) => {
      cleanupTemp();
      finish(reject, error);
    });
  });
}

function resolveExistingRealPath(filePath, fsImpl = fs) {
  if (!filePath) {
    return null;
  }

  try {
    const realpathSync = fsImpl.realpathSync.native || fsImpl.realpathSync;
    return realpathSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isPathInsideDirectory(filePath, directoryPath, fsImpl = fs) {
  if (!filePath || !directoryPath) {
    return false;
  }

  const resolvedDirectory = resolveExistingRealPath(directoryPath, fsImpl);
  const resolvedPath = resolveExistingRealPath(filePath, fsImpl);

  if (resolvedDirectory && resolvedPath) {
    return resolvedPath === resolvedDirectory || resolvedPath.startsWith(resolvedDirectory + path.sep);
  }

  if (resolvedDirectory && !resolvedPath) {
    const lexicalPath = path.resolve(filePath);
    if (!(lexicalPath === resolvedDirectory || lexicalPath.startsWith(resolvedDirectory + path.sep))) {
      return false;
    }

    const parentRealPath = resolveExistingRealPath(path.dirname(filePath), fsImpl);
    return Boolean(
      parentRealPath
      && (parentRealPath === resolvedDirectory || parentRealPath.startsWith(resolvedDirectory + path.sep))
    );
  }

  const lexicalPath = path.resolve(filePath);
  const lexicalDirectory = path.resolve(directoryPath);
  return lexicalPath === lexicalDirectory || lexicalPath.startsWith(lexicalDirectory + path.sep);
}

function isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions = [] } = {}) {
  if (!isPathInsideDirectory(filePath, recordingsDir)) {
    return false;
  }

  if (!allowedExtensions.length) {
    return true;
  }

  const extension = path.extname(path.resolve(filePath)).toLowerCase();
  return allowedExtensions.map((item) => String(item).toLowerCase()).includes(extension);
}

function isSafeRecordingsMarkdownPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.md'] });
}

function isSafeRecordingsAudioPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.opus', '.wav', '.m4a', '.mp3', '.flac'] });
}

function isSafeRecordingsJsonPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.json'] });
}

function resolveTranscriptionAudioFile({ audioFile, recordingsDir, existsSync }) {
  const fileExists = existsSync || (() => false);
  let resolvedAudioFile = String(audioFile || '');

  if (!resolvedAudioFile) {
    return resolvedAudioFile;
  }

  if (!path.isAbsolute(resolvedAudioFile) && !resolvedAudioFile.includes(path.sep) && !resolvedAudioFile.includes('/')) {
    resolvedAudioFile = path.join(recordingsDir, path.basename(resolvedAudioFile));
  }

  if (path.extname(resolvedAudioFile).toLowerCase() !== '.wav') {
    return resolvedAudioFile;
  }

  if (fileExists(resolvedAudioFile)) {
    return resolvedAudioFile;
  }

  const opusSibling = resolvedAudioFile.replace(/\.wav$/i, '.opus');
  if (fileExists(opusSibling)) {
    return opusSibling;
  }

  return resolvedAudioFile;
}

function cacheContainsModel(items, modelPatterns) {
  return modelPatterns.some((pattern) => items.some((item) => item.includes(pattern)));
}

function safeReadDir(dirPath, fsImpl = fs) {
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

function hasReadableFile(filePath, fsImpl = fs) {
  try {
    const stats = fsImpl.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (error) {
    return false;
  }
}

function directoryHasRequiredFiles(dirPath, requiredFiles, alternateFiles = [], fsImpl = fs) {
  return requiredFiles.every((fileName) => hasReadableFile(path.join(dirPath, fileName), fsImpl)) &&
    (!alternateFiles.length || alternateFiles.some((fileName) => hasReadableFile(path.join(dirPath, fileName), fsImpl)));
}

function cacheContainsCompleteFasterWhisperModel({ cacheDir, modelPatterns, fsImpl = fs } = {}) {
  if (!cacheDir || !Array.isArray(modelPatterns) || !modelPatterns.length) {
    return false;
  }

  return safeReadDir(cacheDir, fsImpl).some((entry) => {
    const entryName = entry && entry.name ? entry.name : String(entry || '');
    if (!modelPatterns.some((pattern) => entryName.includes(pattern))) {
      return false;
    }

    const snapshotsDir = path.join(cacheDir, entryName, 'snapshots');
    return safeReadDir(snapshotsDir, fsImpl).some((snapshot) => {
      if (snapshot && typeof snapshot.isDirectory === 'function' && !snapshot.isDirectory()) {
        return false;
      }

      const snapshotName = snapshot && snapshot.name ? snapshot.name : String(snapshot || '');
      return directoryHasRequiredFiles(
        path.join(snapshotsDir, snapshotName),
        FASTER_WHISPER_REQUIRED_CACHE_FILES,
        FASTER_WHISPER_VOCABULARY_CACHE_FILES,
        fsImpl,
      );
    });
  });
}

function cacheContainsCompleteMacMLXModel({ cacheDir, modelPatterns, fsImpl = fs } = {}) {
  if (!cacheDir || !Array.isArray(modelPatterns) || !modelPatterns.length) {
    return false;
  }

  return modelPatterns.some((modelDir) => directoryHasRequiredFiles(
    path.join(cacheDir, modelDir),
    MLX_REQUIRED_CACHE_FILES,
    [],
    fsImpl,
  ));
}

function cacheContainsCompleteTranscriptionModel({ cacheDir, modelPatterns, platform, arch, fsImpl = fs } = {}) {
  if (platform === 'darwin' && arch === 'arm64') {
    return cacheContainsCompleteMacMLXModel({ cacheDir, modelPatterns, fsImpl });
  }

  return cacheContainsCompleteFasterWhisperModel({ cacheDir, modelPatterns, fsImpl });
}

function splitBufferedLines(output, pendingBuffer = '') {
  const combined = `${pendingBuffer}${output}`;
  const normalized = combined.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');

  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) || ''
  };
}

function normalizeRecorderLevels(levels) {
  return {
    type: 'levels',
    mic: Number(levels.mic ?? levels.micLevel ?? 0),
    desktop: Number(levels.desktop ?? levels.desktopLevel ?? 0)
  };
}

function parseRecorderMessageLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'text', payload: { message: trimmed } };
    }

    if (parsed.type === 'levels') {
      return { kind: 'levels', payload: normalizeRecorderLevels(parsed), raw: parsed };
    }

    if (parsed.type === 'warning') {
      return { kind: 'warning', payload: parsed };
    }

    if (parsed.type === 'error') {
      return { kind: 'error', payload: parsed };
    }

    if (parsed.type === 'event') {
      return { kind: 'event', payload: parsed };
    }

    if (
      parsed.type === 'status' ||
      parsed.type === 'ready' ||
      parsed.type === 'progress' ||
      parsed.type === 'content_info' ||
      parsed.type === 'stream_config' ||
      parsed.type === 'audio_format'
    ) {
      return { kind: 'status', payload: parsed };
    }

    if (parsed.outputPath || parsed.audioPath) {
      return { kind: 'result', payload: parsed };
    }

    return { kind: 'json', payload: parsed };
  } catch (error) {
    return { kind: 'text', payload: { message: trimmed } };
  }
}

function parseRecorderStdoutChunk(output, pendingBuffer = '') {
  const { lines, remainder } = splitBufferedLines(output, pendingBuffer);
  const messages = [];

  for (const line of lines) {
    const parsed = parseRecorderMessageLine(line);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return { messages, remainder };
}

function findRecorderResultPayload(stdoutData) {
  const lines = String(stdoutData || '').split(/\r?\n/).filter((line) => line.trim());

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && getRecorderResultAudioPath(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Ignore progress text and malformed partial lines.
    }
  }

  return null;
}

function getRecorderResultAudioPath(recordingInfo) {
  if (!recordingInfo || typeof recordingInfo !== 'object') {
    return null;
  }

  const audioPath = recordingInfo.audioPath || recordingInfo.outputPath;
  return audioPath ? String(audioPath) : null;
}

function getRecorderEventAction(eventPayload = {}) {
  const eventName = eventPayload.event;
  const eventMessage = eventPayload.message;

  switch (eventName) {
    case 'configuring_devices':
      return {
        initProgress: {
          stage: 'configuring',
          message: eventMessage || 'Configuring audio devices...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'mic_stream_opened':
      return {
        initProgress: {
          stage: 'mic_opened',
          message: eventMessage || 'Microphone ready...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'desktop_stream_opened':
      return {
        initProgress: {
          stage: 'desktop_opened',
          message: eventMessage || 'Desktop audio ready...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'desktop_capture_disabled':
      return {
        initProgress: {
          stage: 'desktop_disabled',
          message: eventMessage || 'Desktop audio capture unavailable',
        },
        warning: {
          code: eventPayload.code || 'NO_DESKTOP_AUDIO',
          message: eventMessage || 'Desktop audio capture is disabled.',
          help: eventPayload.help,
          type: 'desktop_capture_disabled',
        },
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'recording_started':
      return {
        initProgress: null,
        warning: null,
        recordingStartedMessage: eventMessage || 'Recording started!',
        progressMessage: null,
      };

    default:
      return {
        initProgress: null,
        warning: null,
        recordingStartedMessage: null,
        progressMessage: eventMessage || null,
      };
  }
}

function getRecorderCloseAction({
  recordingStarted,
  stopInProgress,
  startupSettled,
  startupFailureMessage,
  progressStage,
  exitCode,
} = {}) {
  if (stopInProgress) {
    return { type: 'stop_in_progress', errorMessage: null, warning: null };
  }

  if (!recordingStarted && startupSettled) {
    return { type: 'startup_already_settled', errorMessage: null, warning: null };
  }

  if (recordingStarted) {
    const message = exitCode === 0
      ? 'Recorder exited unexpectedly after startup.'
      : `Recorder exited unexpectedly after startup with code ${exitCode}.`;

    return {
      type: 'unexpected_exit',
      errorMessage: null,
      warning: {
        type: 'recorder_exited',
        code: 'RECORDER_EXITED',
        level: 'error',
        message,
        help: 'The recording process stopped unexpectedly. Start a new recording when ready.',
      },
    };
  }

  const codeDetail = exitCode === null || typeof exitCode === 'undefined'
    ? 'without an exit code'
    : `with code ${exitCode}`;
  let errorMessage = startupFailureMessage || `Recording failed to start. Process exited ${codeDetail}.`;

  if (!startupFailureMessage && progressStage === 'initializing') {
    errorMessage += '\n\nTip: Try refreshing your audio devices or restarting the app.';
  } else if (!startupFailureMessage && progressStage === 'configuring') {
    errorMessage += '\n\nTip: Check that your selected audio devices are not in use by another application.';
  }

  return { type: 'startup_failed', errorMessage, warning: null };
}

function classifyRecorderStdoutChunk(output) {
  const { messages } = parseRecorderStdoutChunk(`${output}\n`);
  const firstMessage = messages[0];

  if (!firstMessage) {
    return { type: 'progress', output };
  }

  if (firstMessage.kind === 'levels') {
    return { type: 'levels', levels: firstMessage.payload };
  }

  return {
    type: 'progress',
    output: firstMessage.payload?.message || output
  };
}

function isModelDownloadErrorOutput(output) {
  return output.toLowerCase().includes('error') && !output.includes('non-critical');
}

function getRecordingStopTimeout(recordingStartTime, now = Date.now()) {
  if (!Number.isFinite(recordingStartTime)) {
    return 30000;
  }

  const recordingDurationSeconds = Math.max(0, (now - recordingStartTime) / 1000);
  const recordingMinutes = Math.ceil(recordingDurationSeconds / 60);

  return Math.max(30000, 30000 + (recordingMinutes * 10000));
}

function resolveStopTimeoutAction({ forceKillOnTimeout, errorMessage, timeoutMessage, hasRecordingProcess }) {
  const timedOut = errorMessage === timeoutMessage;

  return {
    timedOut,
    shouldKillProcess: Boolean(timedOut && forceKillOnTimeout && hasRecordingProcess),
    shouldKeepStopPromise: timedOut,
  };
}

function getQuitInterceptState({ hasRecordingProcess, recordingStartTime, stopInProgress = false }) {
  if (!hasRecordingProcess) {
    return {
      interceptQuit: false,
      state: 'idle',
      progressMessage: null,
    };
  }

  if (stopInProgress) {
    return {
      interceptQuit: true,
      state: 'stopping',
      progressMessage: 'Finishing the current recording before quitting...',
    };
  }

  if (recordingStartTime) {
    return {
      interceptQuit: true,
      state: 'recording',
      progressMessage: 'Stopping and saving the current recording before quitting...',
    };
  }

  return {
    interceptQuit: true,
    state: 'starting',
    progressMessage: 'Stopping the recorder before quitting...',
  };
}

function buildQuitRecordingDialogOptions({ quitState, stopErrorMessage }) {
  const errorDetail = stopErrorMessage && stopErrorMessage.trim()
    ? `${stopErrorMessage.trim()}\n\n`
    : '';

  let title = 'Recorder Still Busy';
  let message = 'AvaNevis could not stop the recorder cleanly.';
  let detail = 'Quitting now may interrupt recorder startup or discard any audio already captured. Keep the app open and try stopping again, or quit anyway and risk losing the recording.';

  if (quitState === 'recording') {
    title = 'Recording Still In Progress';
    message = 'AvaNevis could not stop and save the current recording cleanly.';
    detail = 'Quitting now may discard the in-progress recording. Keep the app open to stop it manually and wait for saving to finish, or quit anyway and risk losing the recording.';
  } else if (quitState === 'stopping') {
    title = 'Recording Save Still Running';
    message = 'AvaNevis is still finishing the current recording.';
    detail = 'Quitting now may interrupt post-processing before the recording is fully saved. Keep the app open and let it finish, or quit anyway and risk losing the recording.';
  }

  return {
    type: 'warning',
    title,
    message,
    detail: `${errorDetail}${detail}`,
    buttons: ['Keep App Open', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  const unique = [];

  for (const message of messages) {
    const normalized = String(message || '').trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function buildPermissionErrorMessage(label, permissionCheck = {}) {
  const parts = [`${label} permission is not granted.`];

  if (permissionCheck.error) {
    parts.push(String(permissionCheck.error).trim());
  }

  if (permissionCheck.help) {
    parts.push(String(permissionCheck.help).trim());
  }

  return parts.join(' ');
}

function buildDesktopAudioAvailabilityError(desktopAudioCheck = {}) {
  const parts = ['Desktop audio capture is unavailable.'];

  if (desktopAudioCheck.error) {
    parts.push(String(desktopAudioCheck.error).trim());
  }

  if (desktopAudioCheck.help) {
    parts.push(String(desktopAudioCheck.help).trim());
  }

  return parts.join(' ');
}

function buildMacOSPermissionCheckFailureStatus(warning) {
  return {
    platform: 'darwin',
    all_granted: false,
    warning,
    microphone: { granted: true },
    screen_recording: { granted: true },
    desktop_audio: {
      available: false,
      error: 'macOS recording permission and desktop-audio preflight could not be verified.',
      help: 'Restart AvaNevis. If this persists, reinstall the app or rebuild the macOS package.',
    },
  };
}

function buildRecordingPreflightReport({
  platform,
  deviceCheck = {},
  diskCheck = {},
  audioOutputCheck = {},
  permissionCheck = null,
}) {
  const errors = Array.isArray(deviceCheck.errors) ? [...deviceCheck.errors] : [];
  const warnings = Array.isArray(deviceCheck.warnings) ? [...deviceCheck.warnings] : [];
  let permissionStatus = null;

  if (deviceCheck.valid === false && errors.length === 0) {
    errors.push('Selected audio devices failed validation.');
  }

  if (diskCheck.warning) {
    warnings.push(
      diskCheck.availableGB
        ? `Only ${diskCheck.availableGB} GB free in the recordings folder. Recording and saving may fail.`
        : 'Low disk space in the recordings folder. Recording and saving may fail.'
    );
  }

  if (audioOutputCheck.warning) {
    warnings.push(audioOutputCheck.warning);
  }

  if (audioOutputCheck.suggestion) {
    warnings.push(`Suggestion: ${audioOutputCheck.suggestion}`);
  }

  if (platform === 'darwin' && permissionCheck) {
    const missingMicrophone = permissionCheck.microphone?.granted === false;
    const missingScreenRecording = permissionCheck.screen_recording?.granted === false;
    const missingDesktopAudio = permissionCheck.desktop_audio?.available === false;

    if (missingMicrophone) {
      errors.push(buildPermissionErrorMessage('Microphone', permissionCheck.microphone));
    }

    if (missingScreenRecording) {
      errors.push(buildPermissionErrorMessage('Screen Recording', permissionCheck.screen_recording));
    }

    if (missingDesktopAudio) {
      errors.push(buildDesktopAudioAvailabilityError(permissionCheck.desktop_audio));
    }

    if (permissionCheck.warning) {
      warnings.push(permissionCheck.warning);
    }

    permissionStatus = {
      missingMicrophone,
      missingScreenRecording,
      missingDesktopAudio,
      settingsTarget: missingMicrophone && missingScreenRecording
        ? 'privacy'
        : (missingMicrophone ? 'microphone' : (missingScreenRecording ? 'screen' : null)),
    };
  }

  const normalizedErrors = dedupeMessages(errors);
  const normalizedWarnings = dedupeMessages(warnings);
  const isMac = platform === 'darwin';

  const guidance = isMac
    ? [
      'Refresh your audio devices and try again.',
      'If the microphone is missing, check System Settings > Privacy & Security > Microphone.',
      'For desktop audio on macOS, keep System Audio (ScreenCaptureKit) selected.',
    ]
    : [
      'Refresh your audio devices and try again.',
      'Reconnect the selected microphone or desktop audio device if it was unplugged.',
    ];

  const errorMessage = normalizedErrors.length
    ? [
      'Recording checks failed:',
      ...normalizedErrors.map((message) => `- ${message}`),
      '',
      ...guidance,
    ].join('\n')
    : null;

  const warningMessage = normalizedWarnings.length
    ? [
      'Recording checks found warnings:',
      ...normalizedWarnings.map((message) => `- ${message}`),
      '',
      'Continue anyway?',
    ].join('\n')
    : null;

  return {
    canStart: normalizedErrors.length === 0,
    errors: normalizedErrors,
    warnings: normalizedWarnings,
    errorMessage,
    permissionStatus,
    warningMessage,
  };
}

module.exports = {
  ALLOWED_WHISPER_MODELS,
  appendCappedSpawnLogBuffer,
  appendSpawnJsonResultBuffer,
  buildRecorderBusyResponse,
  createLineChunkRedactor,
  isRecorderBusy,
  normalizeModelSize,
  SPAWN_LOG_BUFFER_MAX_CHARS,
  SPAWN_JSON_RESULT_BUFFER_MAX_CHARS,
  UPDATER_HTTP_RESPONSE_MAX_CHARS,
  buildFileUrl,
  buildDesktopAudioAvailabilityError,
  buildMacOSPermissionCheckFailureStatus,
  isTrustedExternalUrl,
  resolveExternalUrl,
  getLegalNoticesPath,
  buildPermissionErrorMessage,
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  buildModelDownloadCheck,
  buildPythonModuleArgs,
  buildGuidedTranscriptTempPath,
  runGuidedTranscriptionProcess,
  buildTranscriberArgs,
  buildHuggingFaceOfflineEnv,
  buildTranscriptionRuntimeEnv,
  buildTranscriptionCudaInstallArgs,
  buildTranscriptionCudaUninstallArgs,
  buildUnsupportedCudaPythonMessage,
  getPythonSitePackagesCandidates,
  getPyTorchCudaBinCandidates,
  buildDiarizationOutputPath,
  cacheContainsModel,
  cacheContainsCompleteFasterWhisperModel,
  cacheContainsCompleteMacMLXModel,
  cacheContainsCompleteTranscriptionModel,
  classifyRecorderStdoutChunk,
  dedupeMessages,
  getQuitInterceptState,
  getRecorderCloseAction,
  getRecorderEventAction,
  findRecorderResultPayload,
  getRecorderResultAudioPath,
  getGuidedTranscriptionTimeoutMinutes,
  getMacMLXModelStorageDirs,
  getTranscriberModule,
  getModelDownloadCacheDir,
  getMacMLXCacheDir,
  getModelDownloadPatterns,
  getRecordingStopTimeout,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  isPathInsideDirectory,
  resolveExistingRealPath,
  isSafeRecordingsAudioPath,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  isSafeRecordingsPath,
  isSupportedCudaInstallPythonVersion,
  normalizeRecorderLevels,
  parsePythonVersion,
  parseRecorderMessageLine,
  parseAiBackendProgressLine,
  parseRecorderStdoutChunk,
  summarizeAiBackendError,
  resolveTranscriptionAudioFile,
  splitBufferedLines,
  TRANSCRIPTION_CUDA_PACKAGES,
  PYTORCH_CUDA_BIN_DIRS,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
  redactSensitiveText,
};
