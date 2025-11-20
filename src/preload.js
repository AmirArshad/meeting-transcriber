/**
 * Preload script - Security bridge between Electron and renderer.
 *
 * This exposes safe APIs to the UI without giving full Node.js access.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get audio devices
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),

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

  // GPU acceleration
  checkGPU: () => ipcRenderer.invoke('check-gpu'),
  checkCUDA: () => ipcRenderer.invoke('check-cuda'),
  installGPU: () => ipcRenderer.invoke('install-gpu'),
  uninstallGPU: () => ipcRenderer.invoke('uninstall-gpu'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Event listeners
  onRecordingProgress: (callback) => {
    ipcRenderer.on('recording-progress', (event, data) => callback(data));
  },
  onTranscriptionProgress: (callback) => {
    ipcRenderer.on('transcription-progress', (event, data) => callback(data));
  },
  onGPUInstallProgress: (callback) => {
    ipcRenderer.on('gpu-install-progress', (event, data) => callback(data));
  },
  onAudioLevels: (callback) => {
    ipcRenderer.on('audio-levels', (event, data) => callback(data));
  }
});

console.log('Preload script loaded - API bridge ready');
