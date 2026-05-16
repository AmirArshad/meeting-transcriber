/**
 * Preload script - Security bridge between Electron and renderer.
 *
 * This exposes safe APIs to the UI without giving full Node.js access.
 */

const { contextBridge, ipcRenderer } = require('electron');

function buildFileUrl(filePath) {
  const normalizedPath = String(filePath || '').trim();

  if (!normalizedPath) {
    return '';
  }

  if (normalizedPath.startsWith('file://')) {
    return normalizedPath;
  }

  let slashPath = normalizedPath.replace(/\\/g, '/');

  if (/^[A-Za-z]:\//.test(slashPath)) {
    slashPath = `/${slashPath}`;
  }

  const encodedPath = slashPath
    .split('/')
    .map((part, index) => {
      if (!part || (index === 1 && /^[A-Za-z]:$/.test(part))) {
        return part;
      }

      return encodeURIComponent(part);
    })
    .join('/');

  if (encodedPath.startsWith('//')) {
    return `file:${encodedPath}`;
  }

  return `file://${encodedPath.startsWith('/') ? '' : '/'}${encodedPath}`;
}

function addListener(channel, callback) {
  const wrappedCallback = (_event, data) => callback(data);
  ipcRenderer.on(channel, wrappedCallback);
  return () => ipcRenderer.removeListener(channel, wrappedCallback);
}

function addOnceListener(channel, callback) {
  const wrappedCallback = (_event, data) => callback(data);
  ipcRenderer.once(channel, wrappedCallback);
  return () => ipcRenderer.removeListener(channel, wrappedCallback);
}

function removeAllListeners(channel) {
  ipcRenderer.removeAllListeners(channel);
}

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get audio devices
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),

  // Audio system initialization
  warmUpAudioSystem: () => ipcRenderer.invoke('warm-up-audio-system'),
  checkModelDownloaded: (modelSize) => ipcRenderer.invoke('check-model-downloaded', modelSize),
  downloadModel: (modelSize) => ipcRenderer.invoke('download-model', modelSize),

  // Pre-recording safety checks
  validateDevices: (options) => ipcRenderer.invoke('validate-devices', options),
  checkDiskSpace: () => ipcRenderer.invoke('check-disk-space'),
  checkAudioOutput: () => ipcRenderer.invoke('check-audio-output'),
  runRecordingPreflight: (options) => ipcRenderer.invoke('run-recording-preflight', options),

  // Recording controls
  startRecording: (options) => ipcRenderer.invoke('start-recording', options),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),

  // Transcription
  transcribeAudio: (options) => ipcRenderer.invoke('transcribe-audio', options),
  diarizeTranscript: (options) => ipcRenderer.invoke('diarize-transcript', options),

  // Meeting history
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  getMeeting: (meetingId) => ipcRenderer.invoke('get-meeting', meetingId),
  deleteMeeting: (meetingId) => ipcRenderer.invoke('delete-meeting', meetingId),
  addMeeting: (meetingData) => ipcRenderer.invoke('add-meeting', meetingData),
  updateMeeting: (meetingId, updates) => ipcRenderer.invoke('update-meeting', { meetingId, updates }),
  updateMeetingAi: (meetingId, updates) => ipcRenderer.invoke('update-meeting-ai', { meetingId, updates }),
  saveTranscriptAs: (options) => ipcRenderer.invoke('save-transcript-as', options),
  scanRecordings: () => ipcRenderer.invoke('scan-recordings'),

  // GPU acceleration
  checkGPU: () => ipcRenderer.invoke('check-gpu'),
  checkCUDA: () => ipcRenderer.invoke('check-cuda'),
  installGPU: () => ipcRenderer.invoke('install-gpu'),
  uninstallGPU: () => ipcRenderer.invoke('uninstall-gpu'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Platform detection
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getArch: () => ipcRenderer.invoke('get-arch'),
  getMacOSPermissionStatus: () => ipcRenderer.invoke('get-macos-permission-status'),
  openSystemSettings: (type) => ipcRenderer.invoke('open-system-settings', type),
  buildFileUrl,

  // Updates
  downloadUpdate: (downloadUrl) => ipcRenderer.invoke('download-update', downloadUrl),
  getPendingUpdateInfo: () => ipcRenderer.invoke('get-pending-update-info'),

  // Local AI add-ons
  getAiAddonStatus: () => ipcRenderer.invoke('get-ai-addon-status'),
  storeDiarizationToken: (token) => ipcRenderer.invoke('store-diarization-token', token),
  getDiarizationTokenStatus: () => ipcRenderer.invoke('get-diarization-token-status'),
  deleteDiarizationToken: () => ipcRenderer.invoke('delete-diarization-token'),
  setupDiarization: (options) => ipcRenderer.invoke('setup-diarization', options),
  validateDiarizationSetup: () => ipcRenderer.invoke('validate-diarization-setup'),
  removeDiarizationSetup: () => ipcRenderer.invoke('remove-diarization-setup'),
  setupSummaryModel: (options) => ipcRenderer.invoke('setup-summary-model', options),
  validateSummaryModel: (options) => ipcRenderer.invoke('validate-summary-model', options),
  removeSummaryModel: (options) => ipcRenderer.invoke('remove-summary-model', options),

  // Event listeners
  onRecordingProgress: (callback) => addListener('recording-progress', callback),
  onRecordingInitProgress: (callback) => addListener('recording-init-progress', callback),
  onTranscriptionProgress: (callback) => addListener('transcription-progress', callback),
  onGPUInstallProgress: (callback) => addListener('gpu-install-progress', callback),
  onModelDownloadProgress: (callback) => addListener('model-download-progress', callback),
  onAiAddonProgress: (callback) => addListener('ai-addon-progress', callback),
  onDiarizationProgress: (callback) => addListener('diarization-progress', callback),
  onAudioLevels: (callback) => addListener('audio-levels', callback),
  onRecordingWarning: (callback) => addListener('recording-warning', callback),
  onRecordingFailed: (callback) => addListener('recording-failed', callback),
  onUpdateAvailable: (callback) => addListener('update-available', callback),
  offUpdateAvailable: () => removeAllListeners('update-available')
});

console.log('Preload script loaded - API bridge ready');
