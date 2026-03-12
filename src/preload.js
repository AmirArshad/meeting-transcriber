/**
 * Preload script - Security bridge between Electron and renderer.
 *
 * This exposes safe APIs to the UI without giving full Node.js access.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { buildFileUrl } = require('./main-process-helpers');

function addListener(channel, callback) {
  const wrappedCallback = (_event, data) => callback(data);
  ipcRenderer.on(channel, wrappedCallback);
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

  // Meeting history
  listMeetings: () => ipcRenderer.invoke('list-meetings'),
  getMeeting: (meetingId) => ipcRenderer.invoke('get-meeting', meetingId),
  deleteMeeting: (meetingId) => ipcRenderer.invoke('delete-meeting', meetingId),
  addMeeting: (meetingData) => ipcRenderer.invoke('add-meeting', meetingData),
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

  // Event listeners
  onRecordingProgress: (callback) => addListener('recording-progress', callback),
  onRecordingInitProgress: (callback) => addListener('recording-init-progress', callback),
  onTranscriptionProgress: (callback) => addListener('transcription-progress', callback),
  onGPUInstallProgress: (callback) => addListener('gpu-install-progress', callback),
  onModelDownloadProgress: (callback) => addListener('model-download-progress', callback),
  onAudioLevels: (callback) => addListener('audio-levels', callback),
  onRecordingWarning: (callback) => addListener('recording-warning', callback),
  onUpdateAvailable: (callback) => addListener('update-available', callback)
});

console.log('Preload script loaded - API bridge ready');
