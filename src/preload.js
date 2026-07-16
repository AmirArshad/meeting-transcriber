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

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get audio devices
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),

  // Audio system initialization
  warmUpAudioSystem: () => ipcRenderer.invoke('warm-up-audio-system'),
  checkModelDownloaded: (modelSize) => ipcRenderer.invoke('check-model-downloaded', modelSize),
  downloadModel: (modelSize) => ipcRenderer.invoke('download-model', modelSize),
  cancelDownloadModel: () => ipcRenderer.invoke('cancel-download-model'),

  // Pre-recording safety checks
  validateDevices: (options) => ipcRenderer.invoke('validate-devices', options),
  checkDiskSpace: () => ipcRenderer.invoke('check-disk-space'),
  checkAudioOutput: () => ipcRenderer.invoke('check-audio-output'),
  runRecordingPreflight: (options) => ipcRenderer.invoke('run-recording-preflight', options),

  // Recording controls
  startRecording: (options) => ipcRenderer.invoke('start-recording', options),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  cancelRecording: (options = {}) => ipcRenderer.invoke('cancel-recording', options),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  getRecordingRecoveryState: () => ipcRenderer.invoke('get-recording-recovery-state'),
  recoverRecording: () => ipcRenderer.invoke('recover-recording'),
  deferRecordingRecovery: () => ipcRenderer.invoke('defer-recording-recovery'),

  // Transcription
  transcribeAudio: (options) => ipcRenderer.invoke('transcribe-audio', options),
  retryTranscription: (options) => ipcRenderer.invoke('retry-transcription', options),
  finalizeRecordingTranscription: (options) => ipcRenderer.invoke('finalize-recording-transcription', options),
  cancelPendingTranscription: (options) => ipcRenderer.invoke('cancel-pending-transcription', options),
  resumePendingTranscriptions: (options) => ipcRenderer.invoke('resume-pending-transcriptions', options),
  getTranscriptionQueueState: () => ipcRenderer.invoke('get-transcription-queue-state'),
  transcribeAudioWithSpeakers: (options) => ipcRenderer.invoke('transcribe-audio-with-speakers', options),
  diarizeTranscript: (options) => ipcRenderer.invoke('diarize-transcript', options),
  generateSummary: (options) => ipcRenderer.invoke('generate-summary', options),
  cancelSummaryGeneration: (options) => ipcRenderer.invoke('cancel-summary-generation', options),

  // Meeting history
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  getMeeting: (meetingId) => ipcRenderer.invoke('get-meeting', meetingId),
  deleteMeeting: (meetingId) => ipcRenderer.invoke('delete-meeting', meetingId),
  addMeeting: (meetingData) => ipcRenderer.invoke('add-meeting', meetingData),
  updateMeeting: (meetingId, updates) => ipcRenderer.invoke('update-meeting', { meetingId, updates }),
  updateMeetingAi: (meetingId, updates) => ipcRenderer.invoke('update-meeting-ai', { meetingId, updates }),
  saveTranscriptFile: (options) => ipcRenderer.invoke('save-transcript-file', options),
  saveSpeakerSegmentsFile: (options) => ipcRenderer.invoke('save-speaker-segments-file', options),
  saveTranscriptAs: (options) => ipcRenderer.invoke('save-transcript-as', options),
  scanRecordings: () => ipcRenderer.invoke('scan-recordings'),

  // GPU acceleration
  checkGPU: () => ipcRenderer.invoke('check-gpu'),
  checkCUDA: () => ipcRenderer.invoke('check-cuda'),
  installGPU: (options) => ipcRenderer.invoke('install-gpu', options),
  ensureCompatibleGpuRuntime: (options) => ipcRenderer.invoke('ensure-compatible-gpu-runtime', options),
  uninstallGPU: () => ipcRenderer.invoke('uninstall-gpu'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  openLegalNotices: () => ipcRenderer.invoke('open-legal-notices'),

  // Platform detection
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getArch: () => ipcRenderer.invoke('get-arch'),
  getMacOSPermissionStatus: () => ipcRenderer.invoke('get-macos-permission-status'),
  openSystemSettings: (type) => ipcRenderer.invoke('open-system-settings', type),
  buildFileUrl,

  // Updates
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  getPendingUpdateInfo: () => ipcRenderer.invoke('get-pending-update-info'),

  // Local AI add-ons
  getAiAddonStatus: (options) => ipcRenderer.invoke('get-ai-addon-status', options),
  storeDiarizationToken: (token) => ipcRenderer.invoke('store-diarization-token', token),
  getDiarizationTokenStatus: () => ipcRenderer.invoke('get-diarization-token-status'),
  deleteDiarizationToken: () => ipcRenderer.invoke('delete-diarization-token'),
  setupDiarization: (options) => ipcRenderer.invoke('setup-diarization', options),
  cancelDiarizationSetup: () => ipcRenderer.invoke('cancel-diarization-setup'),
  validateDiarizationSetup: () => ipcRenderer.invoke('validate-diarization-setup'),
  removeDiarizationSetup: () => ipcRenderer.invoke('remove-diarization-setup'),
  setupSummaryModel: (options) => ipcRenderer.invoke('setup-summary-model', options),
  cancelSummaryModelSetup: () => ipcRenderer.invoke('cancel-summary-model-setup'),
  validateSummaryModel: (options) => ipcRenderer.invoke('validate-summary-model', options),
  removeSummaryModel: (options) => ipcRenderer.invoke('remove-summary-model', options),

  // Event listeners
  onRecordingProgress: (callback) => addListener('recording-progress', callback),
  onRecordingInitProgress: (callback) => addListener('recording-init-progress', callback),
  onRecordingSavedDuringQuit: (callback) => addListener('recording-saved-during-quit', callback),
  onAppQuitProgress: (callback) => addListener('app-quit-progress', callback),
  onTranscriptionProgress: (callback) => addListener('transcription-progress', callback),
  onTranscriptionQueueState: (callback) => addListener('transcription-queue-state', callback),
  onGPUInstallProgress: (callback) => addListener('gpu-install-progress', callback),
  onModelDownloadProgress: (callback) => addListener('model-download-progress', callback),
  onAiAddonProgress: (callback) => addListener('ai-addon-progress', callback),
  onDiarizationProgress: (callback) => addListener('diarization-progress', callback),
  onSummaryProgress: (callback) => addListener('summary-progress', callback),
  onAudioLevels: (callback) => addListener('audio-levels', callback),
  onRecordingWarning: (callback) => addListener('recording-warning', callback),
  onRecordingFailed: (callback) => addListener('recording-failed', callback),
  onRecordingRecoveryStateChanged: (callback) => addListener('recording-recovery-state-changed', callback),
  onUpdateAvailable: (callback) => addListener('update-available', callback),
});
