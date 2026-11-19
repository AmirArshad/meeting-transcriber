'use strict';
window.__importTest = { calls: [], progress: null, queueListeners: [] };
window.__importTest.queue = payload => window.__importTest.queueListeners.forEach(callback => callback(payload));
window.electronAPI = {
  buildFileUrl: () => '',
  selectImportAudio: async () => {
    if (window.__importTest.pickerFails) throw new Error('Picker failed');
    return { success: true, name: 'Long meeting.wav' };
  },
  checkModelDownloaded: async () => ({ downloaded: true }),
  startImportAudio: async (options) => {
    window.__importTest.calls.push(options);
    if (window.__importTest.nextResult) { const result = window.__importTest.nextResult; window.__importTest.nextResult = null; return result; }
    window.__importTest.progress?.({ phase: 'saving' });
    return { success: true, meeting: { id: 'new', title: 'Long meeting', date: new Date().toISOString(), duration: '0:01', transcriptionStatus: 'pending' } };
  },
  cancelImportAudio: async () => ({ success: true }),
  onImportAudioProgress: (callback) => { window.__importTest.progress = callback; return () => {}; },
  onTranscriptionQueueState: (callback) => { window.__importTest.queueListeners.push(callback); return () => {}; },
  listMeetings: async () => {
    if (window.__importTest.listGate) await window.__importTest.listGate;
    return [{ id: 'new', title: 'Long meeting', date: new Date().toISOString(), duration: '0:01', transcriptionStatus: window.__importTest.status || 'pending' }];
  },
  getMeeting: async (id) => ({ id, title: 'Long meeting', transcriptionStatus: window.__importTest.status || 'pending', transcript: window.__importTest.transcript || '' }),
};
window.electronAPI = new Proxy(window.electronAPI, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {};
    return undefined;
  },
});
