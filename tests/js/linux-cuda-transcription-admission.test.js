'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { createTranscriptionService } = require('../../src/main/transcription-service');

function withProcess({ platform = process.platform, arch = process.arch }, fn) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
      Object.defineProperty(process, 'arch', archDescriptor);
    });
}

function createFakeProcess({ stdoutText = '', stderrText = '', exitCode = 0, hang = false } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    queueMicrotask(() => proc.emit('close', 1));
  };
  if (!hang) {
    queueMicrotask(() => {
      if (stdoutText) {
        proc.stdout.emit('data', Buffer.from(stdoutText));
      }
      if (stderrText) {
        proc.stderr.emit('data', Buffer.from(stderrText));
      }
      proc.emit('close', exitCode);
    });
  }
  return proc;
}

function readyLinuxCudaStatus(overrides = {}) {
  return {
    statusCode: 'ready',
    installed: true,
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    matchedProfile: 'cuda12',
    ...overrides,
  };
}

function transcriptionJson(overrides = {}) {
  return JSON.stringify({
    text: 'hello',
    segments: [],
    device: 'cuda',
    computeType: 'float16',
    ...overrides,
  });
}

function createLinuxTranscriptionService(overrides = {}) {
  const spawnCalls = [];
  const service = createTranscriptionService({
    app: { getPath: () => '/tmp/avanevis-test', isPackaged: false },
    path,
    fs: {
      promises: {
        readFile: async () => '',
        writeFile: async () => {},
        rm: async () => {},
        mkdtemp: async (prefix) => `${prefix}test`,
        readdir: async () => [],
      },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python' },
    spawnTrackedPython: (args, options) => {
      spawnCalls.push({ args, env: options && options.env });
      if (typeof overrides.spawnTrackedPython === 'function') {
        return overrides.spawnTrackedPython(args, options);
      }
      return createFakeProcess({ stdoutText: transcriptionJson(), exitCode: 0 });
    },
    getBackendModuleArgs: (moduleName, extra = []) => ['-m', moduleName, ...extra],
    enqueueAiComputeAction: (action) => action(),
    getCachedCudaStatus: () => null,
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
    appendSpawnLogBuffer: (buffer, chunk) => `${buffer}${chunk}`,
    appendSpawnJsonStdout: (buffer, data) => `${buffer}${data}`,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: (proc) => { if (proc && typeof proc.kill === 'function') proc.kill(); },
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    listMeetings: async () => [],
    isQuitCommitted: () => false,
    getActiveWallClockComputeJobs: () => [],
    waitForGpuRuntimeIdle: async () => {},
    hasInFlightGpuRuntimeAction: () => false,
    resolveCudaStatusForTranscription: async () => readyLinuxCudaStatus(),
    ...overrides,
    spawnTrackedPython: (args, options) => {
      spawnCalls.push({ args, env: options && options.env });
      if (typeof overrides.spawnTrackedPython === 'function') {
        return overrides.spawnTrackedPython(args, options);
      }
      return createFakeProcess({ stdoutText: transcriptionJson(), exitCode: 0 });
    },
  });
  return { service, spawnCalls };
}

test('Linux guided admission preserves Speakrs integrity failure for fallback metadata', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service } = createLinuxTranscriptionService({
      resolveCudaStatusForTranscription: async () => readyLinuxCudaStatus(),
      getAiAddonRuntimeOptions: (extra = {}) => ({ ...extra }),
      checkAiAddonSetupStatus: async () => ({
        features: {
          diarization: {
            status: 'error',
            setupComplete: false,
            engine: 'speakrs',
            modelId: 'speakrs-community1-vbx',
            speakerCount: 'auto',
            error: null,
            runtimeCache: { valid: false, reason: 'Speakrs runtime integrity validation failed.' },
            packCache: { valid: false, reason: 'Speakrs model pack is not installed.' },
          },
        },
      }),
    });

    const status = await service.resolveGuidedDiarizationStatus();

    assert.deepEqual(status, {
      engine: 'speakrs',
      modelId: 'speakrs-community1-vbx',
      speakerCount: 'auto',
      modelRef: 'speakrs-community1-vbx',
      requiredDevice: 'cuda',
      error: 'Speakrs runtime integrity validation failed.',
    });
  });
});

// `packCache.reason` / `runtimeCache.reason` are NON-NULL whenever the Speakrs
// artifacts are merely absent — see `checkSpeakrsModelCache` (reason:
// 'Speakrs model pack is not installed.') and `checkSpeakrsRuntimeCache`
// (reason: 'Speakrs ONNX Runtime is not installed. Missing: ...') in
// src/ai-addon/manifest-store.js. A fresh manifest also defaults to
// `engine: 'speakrs'` (normalizeDiarizationSelection in src/ai-addon-state.js).
// Reading those reasons without checking the owning status/`valid` turns "user
// never enabled speaker identification" into a per-meeting failure.
function diarizationFeature(overrides = {}) {
  return {
    features: {
      diarization: {
        status: 'notConfigured',
        setupComplete: false,
        engine: 'speakrs',
        modelId: 'speakrs-community1-vbx',
        speakerCount: 'auto',
        error: null,
        packCache: { valid: false, installed: false, reason: 'Speakrs model pack is not installed.' },
        runtimeCache: { valid: false, installed: false, reason: 'Speakrs ONNX Runtime is not installed.' },
        ...overrides,
      },
    },
  };
}

for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'arm64']]) {
  for (const status of ['notConfigured', 'downloading', 'validating']) {
    test(`${platform}/${arch}: '${status}' speaker identification is not a per-meeting failure`, async () => {
      await withProcess({ platform, arch }, async () => {
        const progress = [];
        const { service } = createLinuxTranscriptionService({
          // macOS skips the extracted ORT runtime entirely (skipped/valid).
          checkAiAddonSetupStatus: async () => diarizationFeature({
            status,
            runtimeCache: platform === 'darwin'
              ? { valid: true, skipped: true, reason: null }
              : { valid: false, installed: false, reason: 'Speakrs ONNX Runtime is not installed.' },
          }),
          sendToRenderer: (channel, payload) => {
            if (channel === 'transcription-progress') progress.push(payload);
          },
        });

        assert.equal(await service.resolveGuidedDiarizationStatus(), null);
        assert.deepEqual(progress, []);
      });
    });
  }
}

test('Linux pyannote selection stays silently unavailable instead of erroring every meeting', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const progress = [];
    const { service } = createLinuxTranscriptionService({
      checkAiAddonSetupStatus: async () => diarizationFeature({
        engine: 'pyannote',
        modelId: 'pyannote-speaker-diarization-community-1',
      }),
      sendToRenderer: (channel, payload) => {
        if (channel === 'transcription-progress') progress.push(payload);
      },
    });

    // assertLinuxSpeakrsOnlyEngine throws LINUX_PYANNOTE_UNAVAILABLE; pyannote is
    // deliberately hidden on Linux, so that policy gate must not be reported as a
    // recording-level diarization failure.
    assert.equal(await service.resolveGuidedDiarizationStatus(), null);
    assert.deepEqual(progress, []);
  });
});

const ADMISSION_ARGS = {
  audioFile: '/tmp/avanevis-test/recordings/meeting.opus',
  language: 'en',
  modelSize: 'small',
};

test('Linux CUDA admission stays on CPU when the admission resolver is missing', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      resolveCudaStatusForTranscription: null,
      spawnTrackedPython: () => createFakeProcess({
        stdoutText: transcriptionJson({ device: 'cpu', computeType: 'int8' }),
        exitCode: 0,
      }),
    });
    const result = await service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS);
    assert.equal(result.transcriptionDevice, 'cpu');
    assert.ok(spawnCalls[0].args.includes('cpu'));
    assert.equal(spawnCalls[0].args.includes('cuda'), false);
  });
});

test('Linux CUDA admission stays on CPU when no managed runtime is installed', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      resolveCudaStatusForTranscription: async () => null,
      spawnTrackedPython: () => createFakeProcess({
        stdoutText: transcriptionJson({ device: 'cpu', computeType: 'int8' }),
        exitCode: 0,
      }),
    });
    const result = await service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS);
    assert.equal(result.transcriptionDevice, 'cpu');
    assert.ok(spawnCalls[0].args.includes('cpu'));
  });
});

test('Linux CUDA admission stays on CPU on arm64 even if a resolver claims ready', async () => {
  await withProcess({ platform: 'linux', arch: 'arm64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      resolveCudaStatusForTranscription: async () => readyLinuxCudaStatus(),
      spawnTrackedPython: () => createFakeProcess({
        stdoutText: transcriptionJson({ device: 'cpu', computeType: 'int8' }),
        exitCode: 0,
      }),
    });
    const result = await service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS);
    assert.equal(result.transcriptionDevice, 'cpu');
    assert.ok(spawnCalls[0].args.includes('cpu'));
  });
});

test('Linux CUDA non-ready statuses fail closed without a CPU fallback', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    for (const statusCode of [
      'missingLibraries',
      'runtimeIntegrityFailed',
      'deviceUnavailable',
      'unsupportedRuntimeMajor',
      'runtimeUnavailable',
      'probeError',
      'unsupportedPlatform',
    ]) {
      const { service, spawnCalls } = createLinuxTranscriptionService({
        resolveCudaStatusForTranscription: async () => ({ statusCode, error: statusCode }),
      });
      await assert.rejects(
        service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS),
        (error) => error && error.code === 'LINUX_CUDA_UNAVAILABLE',
        statusCode,
      );
      assert.equal(spawnCalls.length, 0, statusCode);
    }
  });
});

test('Linux CUDA statusCode ready without device/runtime invariants fails closed', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      resolveCudaStatusForTranscription: async () => ({ statusCode: 'ready' }),
    });
    await assert.rejects(
      service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS),
      (error) => error && error.code === 'LINUX_CUDA_UNAVAILABLE',
    );
    assert.equal(spawnCalls.length, 0);
  });
});

test('Linux CUDA result JSON that is not CUDA float16 is LINUX_CUDA_DEVICE_MISMATCH', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const cases = [
      { device: 'cpu', computeType: 'float16' },
      { device: '', computeType: 'float16' },
      { device: 'auto', computeType: 'float16' },
      { device: 'cuda', computeType: 'int8' },
      { device: 'cuda', computeType: 'float32' },
      { device: 'cuda', computeType: 'auto' },
      { device: 'cuda', computeType: '' },
      { device: 12, computeType: 'float16' },
    ];
    for (const payload of cases) {
      const { service } = createLinuxTranscriptionService({
        spawnTrackedPython: () => createFakeProcess({
          stdoutText: transcriptionJson(payload),
          exitCode: 0,
        }),
      });
      await assert.rejects(
        service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS),
        (error) => error && error.code === 'LINUX_CUDA_DEVICE_MISMATCH',
        JSON.stringify(payload),
      );
    }
  });
});

test('Linux CUDA admits float16 and int8_float16 CUDA result JSON', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    for (const computeType of ['float16', 'int8_float16']) {
      const { service, spawnCalls } = createLinuxTranscriptionService({
        spawnTrackedPython: () => createFakeProcess({
          stdoutText: transcriptionJson({ device: 'cuda', computeType }),
          exitCode: 0,
        }),
      });
      const result = await service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS);
      assert.equal(result.transcriptionDevice, 'cuda', computeType);
      assert.ok(spawnCalls[0].args.includes('cuda'));
    }
  });
});

test('Linux CUDA load failure does not retry on CPU', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      spawnTrackedPython: () => createFakeProcess({
        stderrText: 'libcublas.so.12 is not found or cannot be loaded',
        exitCode: 1,
      }),
    });
    await assert.rejects(
      service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS),
      /Transcription failed/,
    );
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].args.includes('cpu'), false);
  });
});

test('Linux CUDA cancel terminates the admitted child without a CPU retry', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    let child;
    const { service, spawnCalls } = createLinuxTranscriptionService({
      spawnTrackedPython: () => {
        child = createFakeProcess({ hang: true });
        return child;
      },
    });
    const promise = service.runNormalTranscriptionWithCudaFallback(ADMISSION_ARGS);
    await Promise.resolve();
    assert.equal(spawnCalls.length, 1);
    child.kill();
    await assert.rejects(promise, /Transcription failed/);
    assert.equal(spawnCalls.length, 1);
  });
});

test('Linux Speakrs pack failure persists diarization error metadata after ordinary CUDA fallback', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const meeting = {
      id: '20260903_112605',
      title: 'Task 5 fixed2 fallback fixture',
      audioPath: '/tmp/avanevis-test/recordings/meeting_20260903_112605.wav',
      transcriptPath: '/tmp/avanevis-test/recordings/meeting_20260903_112605.md',
      durationSeconds: 14,
    };
    const aiUpdates = [];
    const { service, spawnCalls } = createLinuxTranscriptionService({
      enqueueAiComputeAction: async (action) => action(),
      updateMeetingAiMetadata: async (meetingId, updates) => {
        aiUpdates.push({ meetingId, updates });
        return {
          ...meeting,
          transcriptionStatus: 'completed',
          transcriptionDevice: 'cuda',
          transcriptionComputeType: 'float16',
          ai: { diarization: updates.diarization },
        };
      },
      checkAiAddonSetupStatus: async () => ({
        features: {
          diarization: {
            status: 'error',
            setupComplete: false,
            engine: 'speakrs',
            modelId: 'speakrs-community1-vbx',
            speakerCount: 'auto',
            error: null,
            runtimeCache: { valid: false, reason: 'Speakrs runtime integrity validation failed.' },
            packCache: { valid: false, reason: 'Speakrs model pack is not installed.' },
          },
        },
      }),
      runWallClockComputeAction: async ({ label, action }) => {
        const text = String(label || '');
        if (text.startsWith('Meeting lookup')) {
          return meeting;
        }
        if (text.startsWith('Meeting status update')) {
          return {
            ...meeting,
            transcriptionStatus: 'completed',
            transcriptionDevice: 'cuda',
            transcriptionComputeType: 'float16',
          };
        }
        return action((proc) => proc);
      },
    });

    const result = await service.admitMeetingTranscriptionJob({
      meetingId: meeting.id,
      language: 'en',
      modelSize: 'tiny',
    });

    assert.equal(result.transcriptionDevice || result.device, 'cuda');
    assert.equal(result.diarizationError, 'Speakrs runtime integrity validation failed.');
    assert.equal(aiUpdates.length, 1);
    assert.equal(aiUpdates[0].meetingId, meeting.id);
    assert.equal(aiUpdates[0].updates.diarization.status, 'error');
    assert.equal(aiUpdates[0].updates.diarization.model, 'speakrs-community1-vbx');
    assert.equal(aiUpdates[0].updates.diarization.error, 'Speakrs runtime integrity validation failed.');
    assert.match(String(aiUpdates[0].updates.diarization.completedAt), /T/);
    assert.equal(result.meeting.ai.diarization.status, 'error');
    assert.equal(
      spawnCalls.some((call) => String((call.args || []).join(' ')).includes('guided')),
      false,
    );
  });
});

function speakrsIntegrityFailureFeature() {
  return diarizationFeature({
    status: 'error',
    runtimeCache: { valid: false, reason: 'Speakrs runtime integrity validation failed.' },
  });
}

function fallbackJobMeeting() {
  return {
    id: '20260903_112605',
    title: 'fallback fixture',
    audioPath: '/tmp/avanevis-test/recordings/meeting_20260903_112605.wav',
    transcriptPath: '/tmp/avanevis-test/recordings/meeting_20260903_112605.md',
    durationSeconds: 14,
  };
}

function fallbackJobOverrides(meeting, extra = {}) {
  return {
    enqueueAiComputeAction: async (action) => action(),
    runWallClockComputeAction: async ({ label, action }) => {
      const text = String(label || '');
      if (text.startsWith('Meeting lookup')) return meeting;
      if (text.startsWith('Meeting status update')) {
        return { ...meeting, transcriptionStatus: 'completed', transcriptionDevice: 'cuda' };
      }
      return action((proc) => proc);
    },
    ...extra,
  };
}

test('a terminal admission failure is not re-probed by the post-pass', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const meeting = fallbackJobMeeting();
    let admissionProbes = 0;
    const progress = [];
    const { service } = createLinuxTranscriptionService(fallbackJobOverrides(meeting, {
      updateMeetingAiMetadata: async (meetingId, updates) => ({
        ...meeting,
        ai: { diarization: updates.diarization },
      }),
      checkAiAddonSetupStatus: async () => {
        admissionProbes += 1;
        return speakrsIntegrityFailureFeature();
      },
      sendToRenderer: (channel, payload) => {
        if (channel === 'transcription-progress') progress.push(payload);
      },
    }));

    await service.admitMeetingTranscriptionJob({ meetingId: meeting.id, language: 'en', modelSize: 'tiny' });

    // Re-probing costs another CUDA probe child plus a full computeAdmission
    // status hash inside the held compute slot, and warns the user twice, for
    // an answer that cannot change within a single job.
    assert.equal(admissionProbes, 1);
    assert.equal(
      progress.filter((line) => line.includes('Speaker identification is unavailable')).length,
      1,
    );
  });
});

test('a concrete sidecar failure outranks the admission-level diarization error', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const meeting = fallbackJobMeeting();
    const aiUpdates = [];
    const { service } = createLinuxTranscriptionService(fallbackJobOverrides(meeting, {
      checkAiAddonSetupStatus: async () => speakrsIntegrityFailureFeature(),
      updateMeetingAiMetadata: async (meetingId, updates) => {
        aiUpdates.push(updates.diarization);
        if (aiUpdates.length === 1) {
          throw new Error('meetings.json is locked by another process.');
        }
        return { ...meeting, ai: { diarization: updates.diarization } };
      },
    }));

    const result = await service.admitMeetingTranscriptionJob({
      meetingId: meeting.id,
      language: 'en',
      modelSize: 'tiny',
    });

    // The admission error is the least informative failure available; the real
    // persistence fault must not be masked by it.
    assert.equal(aiUpdates[0].error, 'Speakrs runtime integrity validation failed.');
    assert.equal(aiUpdates[1].error, 'meetings.json is locked by another process.');
    assert.equal(result.diarizationError, 'meetings.json is locked by another process.');
  });
});

test('an unconfigured Speakrs install writes no diarization metadata for a completed job', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const meeting = fallbackJobMeeting();
    const aiUpdates = [];
    const progress = [];
    const { service } = createLinuxTranscriptionService(fallbackJobOverrides(meeting, {
      checkAiAddonSetupStatus: async () => diarizationFeature(),
      updateMeetingAiMetadata: async (meetingId, updates) => {
        aiUpdates.push(updates);
        return meeting;
      },
      sendToRenderer: (channel, payload) => {
        if (channel === 'transcription-progress') progress.push(payload);
      },
    }));

    const result = await service.admitMeetingTranscriptionJob({
      meetingId: meeting.id,
      language: 'en',
      modelSize: 'tiny',
    });

    assert.equal(result.transcriptionDevice || result.device, 'cuda');
    assert.equal(result.diarizationError, null);
    assert.deepEqual(aiUpdates, []);
    assert.deepEqual(progress.filter((line) => line.includes('Speaker identification')), []);
  });
});

test('Linux CUDA transcription is skipped when quit is already committed at job start', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls } = createLinuxTranscriptionService({
      isQuitCommitted: () => true,
      enqueueAiComputeAction: async (action) => action(),
    });
    const job = service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_linux_cuda_quit',
      language: 'en',
      modelSize: 'small',
    });
    await assert.rejects(job, (error) => error && error.code === 'TRANSCRIPTION_QUIT_SKIPPED');
    assert.equal(spawnCalls.length, 0);
  });
});
