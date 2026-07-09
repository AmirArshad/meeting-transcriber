'use strict';

const path = require('path');
const { getGuidedTranscriptionTimeoutMinutes } = require('./compute-timeout-helpers');
const {
  appendSpawnJsonResultBuffer,
  appendCappedSpawnLogBuffer,
  SPAWN_JSON_RESULT_BUFFER_MAX_CHARS,
} = require('./recorder-output-helpers');

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

function buildTranscriptionCliArgs({
  platform,
  arch,
  audioFile,
  language = 'en',
  modelSize,
  device = 'auto',
} = {}) {
  const extraArgs = [
    '--file', audioFile,
    '--language', language,
    '--model', modelSize,
  ];
  if (!(platform === 'darwin' && arch === 'arm64')) {
    extraArgs.push('--device', device);
  }
  extraArgs.push('--json');
  return buildTranscriberArgs({ platform, arch, extraArgs });
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

function buildDiarizationOutputPath({ audioPath } = {}) {
  const sourcePath = String(audioPath || '');
  const parsedPath = path.parse(sourcePath);
  return path.join(parsedPath.dir || '.', `${parsedPath.name || 'meeting'}.speakers.json`);
}

function buildGuidedTranscriptTempPath({ finalTranscriptPath, now = Date.now() } = {}) {
  const parsedPath = path.parse(String(finalTranscriptPath || 'meeting.md'));
  return path.join(parsedPath.dir || '.', `.${parsedPath.name || 'meeting'}.guided.${now}.tmp.md`);
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
  registerProcess,
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
    if (typeof registerProcess === 'function') {
      registerProcess(python);
    }
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

module.exports = {
  getTranscriberModule,
  buildPythonModuleArgs,
  buildTranscriptionCliArgs,
  buildTranscriberArgs,
  buildGuidedTranscriptTempPath,
  runGuidedTranscriptionProcess,
  buildHuggingFaceOfflineEnv,
  buildTranscriptionRuntimeEnv,
  buildDiarizationOutputPath,
};
