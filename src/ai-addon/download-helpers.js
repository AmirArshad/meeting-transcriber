'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const { AI_MODEL_CATALOG, getAiAddonPaths } = require('../ai-addon-state');
const {
  TOKEN_KEYS,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
} = require('../ai-addon-token-store');
const {
  forceKillChildProcess,
  isAiAddonCancelError,
  onAiAddonCancel,
  throwIfAiAddonCanceled,
} = require('./progress-events');

// Local copy avoids a download-helpers ↔ manifest-store require cycle.
function bindFsMethod(fsModule, methodName) {
  const method = fsModule && fsModule[methodName];
  return typeof method === 'function' ? method.bind(fsModule) : undefined;
}

const DOWNLOAD_TIMEOUT_MS = 300000;

const DOWNLOAD_PROGRESS_INTERVAL_MS = 250;

const MAX_DOWNLOAD_REDIRECTS = 5;

const LATE_DOWNLOAD_ABORT_CODES = new Set(['ECONNABORTED', 'ECONNRESET']);

// Explicit redirect/CDN hosts for JS downloadFile fallbacks. HF summary models
// normally use bundled Python huggingface_hub/hf_xet (bypassing this list) and
// remain SHA-256 pinned. When HF/Xet rotates CDN subdomains, add the new host
// here — do not reintroduce *.hf.co / *.huggingface.co wildcards.
const DOWNLOAD_REDIRECT_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'files.pythonhosted.org',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cas-bridge.xethub.hf.co',
  'cas-server.xethub.hf.co',
  'cas-server.xethub.huggingface.co',
  'cas-bridge.xethub.huggingface.co',
  'transfer.xethub.hf.co',
  'transfer.xethub.huggingface.co',
]);

function collectConfiguredDownloadHosts(value, hosts = new Set()) {
  if (!value) {
    return hosts;
  }

  if (typeof value === 'string') {
    if (value.startsWith('https://')) {
      try {
        hosts.add(new URL(value).hostname.toLowerCase());
      } catch (error) {
        // Validation below reports malformed configured URLs at their call sites.
      }
    }
    return hosts;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectConfiguredDownloadHosts(item, hosts);
    }
    return hosts;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectConfiguredDownloadHosts(item, hosts);
    }
  }

  return hosts;
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  ...collectConfiguredDownloadHosts(AI_MODEL_CATALOG),
  ...DOWNLOAD_REDIRECT_HOSTS,
]);

function isLikelyHuggingFaceToken(token) {
  return /^hf_[A-Za-z0-9_-]{8,}$/.test(String(token || '').trim());
}

function getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule = fs, checkEncryptionAvailability = true } = {}) {
  return {
    hasToken: hasAiAddonToken({
      userDataDir,
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      fsModule,
    }),
    encryptionAvailable: isTokenEncryptionAvailable({ safeStorage, checkAvailability: checkEncryptionAvailability }),
  };
}

function isAllowedDownloadUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ''));
    return parsedUrl.protocol === 'https:' && isAllowedDownloadHost(parsedUrl.hostname);
  } catch (error) {
    return false;
  }
}

function isAllowedDownloadHost(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase();
  // Explicit allowlist only (catalog hosts + known HF/Xet/GitHub redirect hosts).
  // Do not wildcard *.hf.co — pin mistakes should not expand blast radius.
  return ALLOWED_DOWNLOAD_HOSTS.has(normalizedHostname);
}

function getDownloadHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (error) {
    return 'unknown';
  }
}

function isHuggingFaceSummaryArtifact(artifact) {
  return Boolean(artifact && artifact.source && artifact.source.provider === 'huggingface' && artifact.source.repo && artifact.source.revision && artifact.source.fileName);
}

function buildPythonEnvForBackend({ backendPath, extra = {} } = {}) {
  const separator = process.platform === 'win32' ? ';' : ':';
  const existingPythonPath = process.env.PYTHONPATH || '';
  const pythonPathParts = [backendPath, existingPythonPath].filter(Boolean);
  return {
    ...process.env,
    ...extra,
    PYTHONPATH: pythonPathParts.join(separator),
  };
}

async function downloadHuggingFaceSummaryArtifact({ artifact, destinationPath, expectedSizeBytes, userDataDir, pythonExe, backendPath, onProgress, cancelSignal, fsModule = fs }) {
  const spawnProcess = fsModule.__spawn || spawn;
  if (!isHuggingFaceSummaryArtifact(artifact)) {
    throw new Error('Summary model artifact is not a pinned Hugging Face source.');
  }
  if (!pythonExe || !backendPath) {
    throw new Error('Bundled Python is not available for Hugging Face summary model downloads.');
  }

  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const source = artifact.source;
  const cacheRoot = path.join(getAiAddonPaths(userDataDir).rootDir, 'huggingface-cache');
  const destinationRoot = path.dirname(path.resolve(destinationPath));
  const args = [
    '-m', 'summaries.hf_model_downloader',
    '--repo', source.repo,
    '--revision', source.revision,
    '--filename', source.fileName,
    '--destination', destinationPath,
    '--destination-root', destinationRoot,
    '--expected-size', String(expectedSizeBytes || source.sizeBytes || 0),
    '--expected-sha256', artifact.sha256,
    '--cache-root', cacheRoot,
  ];

  await new Promise((resolve, reject) => {
    let settled = false;
    let cancelError = null;
    let cancelFallbackTimer = null;
    let stdoutBuffer = '';
    let stderrOutput = '';
    const child = spawnProcess(pythonExe, args, {
      cwd: backendPath,
      windowsHide: true,
      env: buildPythonEnvForBackend({
        backendPath,
        extra: {
          HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_PROGRESS_BARS: '1',
        },
      }),
    });
    const cleanupCancel = onAiAddonCancel(cancelSignal, (abortError) => {
      if (settled || cancelError) {
        return;
      }
      cancelError = abortError;
      forceKillChildProcess(child);
      cleanupCancel?.();
      cancelFallbackTimer = setTimeout(() => {
        finish(reject, cancelError);
      }, 5000);
      cancelFallbackTimer.unref?.();
    });
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
      }
      cleanupCancel?.();
      callback(value);
    };
    const handleStdoutLine = (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line);
        if ((event.type === 'progress' || event.type === 'result') && typeof onProgress === 'function') {
          onProgress({
            downloaded: event.downloadedBytes,
            total: event.totalBytes || expectedSizeBytes,
            percent: event.percent,
          });
        }
      } catch (error) {
        // Ignore non-JSON helper output; stderr is summarized on failure.
      }
    };
    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleStdoutLine(line);
      }
    });
    child.stderr.on('data', (data) => { stderrOutput += data.toString(); });
    child.on('error', (error) => finish(reject, cancelError || error));
    child.on('close', (code) => {
      if (stdoutBuffer) {
        handleStdoutLine(stdoutBuffer);
      }
      if (cancelError) {
        finish(reject, cancelError);
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      const reason = stderrOutput.trim().split(/\r?\n/).filter(Boolean).pop() || `Hugging Face downloader exited with code ${code}.`;
      finish(reject, new Error(reason.replace(/^ERROR:\s*/i, '')));
    });
  });

  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!existsSync || !existsSync(destinationPath)) {
    throw new Error('Hugging Face summary model download did not produce the expected artifact.');
  }
}

async function downloadFile({ url, destinationPath, expectedSizeBytes, onProgress, redirectCount = 0, timeoutMs = DOWNLOAD_TIMEOUT_MS, cancelSignal }) {
  throwIfAiAddonCanceled(cancelSignal, 'Download was canceled.');
  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : null;
  if (!client) {
    throw new Error('Summary setup artifact downloads require HTTPS.');
  }
  if (!isAllowedDownloadUrl(parsedUrl.toString())) {
    throw new Error(`Summary setup artifact download host is not allowed: ${getDownloadHost(parsedUrl.toString())}.`);
  }
  if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    throw new Error('Summary setup artifact download followed too many redirects.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    let responseStream = null;
    let file = null;
    let lastProgressEmitMs = 0;
    let lastProgress = null;
    let fileFinished = false;
    let completingLateAbort = false;
    let downloaded = 0;
    let total = Number(expectedSizeBytes) || 0;
    const emitDownloadProgress = (progress, force = false) => {
      if (typeof onProgress !== 'function') {
        return;
      }
      const downloaded = Math.max(0, Math.floor(Number(progress.downloaded) || 0));
      const total = Math.max(0, Math.floor(Number(progress.total) || 0));
      const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : undefined;
      const nowMs = Date.now();
      const complete = total > 0 && downloaded >= total;
      if (!force && lastProgress && lastProgress.downloaded === downloaded && lastProgress.total === total) {
        return;
      }
      if (!force && lastProgressEmitMs && nowMs - lastProgressEmitMs < DOWNLOAD_PROGRESS_INTERVAL_MS && !complete) {
        return;
      }

      lastProgressEmitMs = nowMs;
      lastProgress = { downloaded, total };
      onProgress({ downloaded, total, percent });
    };
    const removePartialFile = () => {
      try {
        if (destinationPath && fs.existsSync(destinationPath)) {
          fs.unlinkSync(destinationPath);
        }
      } catch (cleanupError) {}
    };
    const closeAndRemovePartialFile = (done = () => {}) => {
      if (!file) {
        removePartialFile();
        done();
        return;
      }
      let cleanupDone = false;
      const finishCleanup = () => {
        if (cleanupDone) {
          return;
        }
        cleanupDone = true;
        removePartialFile();
        setTimeout(removePartialFile, 1000).unref?.();
        done();
      };
      file.once('close', finishCleanup);
      try {
        file.destroy();
      } catch (cleanupError) {}
      setTimeout(finishCleanup, 250).unref?.();
    };
    const destroyActiveTransfer = (error) => {
      if (responseStream) {
        try {
          if (file) {
            responseStream.unpipe(file);
          }
        } catch (cleanupError) {}
        try {
          responseStream.destroy(error);
        } catch (cleanupError) {}
      }
      if (request) {
        try {
          request.destroy(error);
        } catch (cleanupError) {}
      }
    };
    const cleanupCancel = onAiAddonCancel(cancelSignal, (cancelError) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      destroyActiveTransfer(cancelError);
      closeAndRemovePartialFile(() => reject(cancelError));
    });
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      destroyActiveTransfer(error);
      closeAndRemovePartialFile(() => reject(error));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      resolve();
    };
    const hasCompleteDownload = () => Boolean(fileFinished || (total > 0 && downloaded >= total));
    const isLateDownloadAbort = (error) => Boolean(error && LATE_DOWNLOAD_ABORT_CODES.has(error.code) && hasCompleteDownload());
    const completeAfterLateDownloadAbort = (error) => {
      if (!isLateDownloadAbort(error)) {
        return false;
      }
      if (!file || fileFinished || completingLateAbort) {
        return true;
      }
      completingLateAbort = true;
      try {
        responseStream?.unpipe(file);
      } catch (cleanupError) {}
      if (total > 0) {
        emitDownloadProgress({ downloaded, total, percent: 100 }, true);
      }
      try {
        file.end();
      } catch (endError) {
        fail(endError);
      }
      return true;
    };

    request = client.get(parsedUrl, (response) => {
      responseStream = response;
      if (settled) {
        response.resume();
        return;
      }
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadFile({ url: nextUrl, destinationPath, expectedSizeBytes, onProgress, redirectCount: redirectCount + 1, timeoutMs, cancelSignal }).then(succeed, fail);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Summary setup artifact download failed with HTTP ${response.statusCode}.`));
        return;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      file = fs.createWriteStream(destinationPath);
      total = Number(response.headers['content-length']) || Number(expectedSizeBytes) || 0;

      if (expectedSizeBytes && total && total > expectedSizeBytes * 1.1) {
        response.resume();
        fail(new Error('Summary setup artifact is larger than the pinned expected size.'));
        return;
      }

      response.on('data', (chunk) => {
        if (settled) {
          return;
        }
        downloaded += chunk.length;
        if (expectedSizeBytes && downloaded > expectedSizeBytes * 1.1) {
          const sizeError = new Error('Summary setup artifact exceeded the pinned expected size.');
          fail(sizeError);
          return;
        }
        if (total > 0) {
          emitDownloadProgress({ downloaded, total, percent: Math.min((downloaded / total) * 100, 100) });
        }
      });

      response.on('error', (error) => {
        if (completeAfterLateDownloadAbort(error)) {
          return;
        }
        fail(isAiAddonCancelError(error) ? error : new Error(`Summary setup artifact download stream failed: ${error.message}`));
      });
      file.on('error', (error) => fail(isAiAddonCancelError(error) ? error : new Error(`Could not write summary setup artifact: ${error.message}`)));
      file.on('finish', () => {
        if (settled) {
          return;
        }
        fileFinished = true;
        if (total > 0) {
          emitDownloadProgress({ downloaded, total, percent: Math.min((downloaded / total) * 100, 100) }, true);
        }
        file.close(succeed);
      });
      response.pipe(file);
    });

    request.setTimeout(timeoutMs, () => {
      // Preserve the host-qualified request error message from the error handler.
      request.destroy(new Error('Summary setup artifact download timed out.'));
    });
    request.on('error', (error) => {
      if (isAiAddonCancelError(error)) {
        fail(error);
        return;
      }
      if (completeAfterLateDownloadAbort(error)) {
        return;
      }
      fail(new Error(`Summary setup artifact download failed from ${getDownloadHost(parsedUrl.toString())}: ${error.message}`));
    });
  });
}

module.exports = {
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  isAllowedDownloadUrl,
  isLikelyHuggingFaceToken,
  getDiarizationTokenStatus,
  // Private helpers used by setup flows / other ai-addon modules
  isHuggingFaceSummaryArtifact,
  isAllowedDownloadHost,
  getDownloadHost,
};
