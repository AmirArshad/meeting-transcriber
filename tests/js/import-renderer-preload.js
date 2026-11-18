'use strict';
window.__importTest = { calls: [], progress: null, queue: null };
window.electronAPI = {
  buildFileUrl: () => '',
  selectImportAudio: async () => ({ success: true, name: 'Long meeting.wav' }),
  checkModelDownloaded: async () => ({ downloaded: true }),
  startImportAudio: async (options) => {
    window.__importTest.calls.push(options);
    if (window.__importTest.nextResult) { const result = window.__importTest.nextResult; window.__importTest.nextResult = null; return result; }
    window.__importTest.progress?.({ phase: 'saving' });
    return { success: true, meeting: { id: 'new', title: 'Long meeting', date: new Date().toISOString(), duration: '0:01', transcriptionStatus: 'pending' } };
  },
  cancelImportAudio: async () => ({ success: true }),
  onImportAudioProgress: (callback) => { window.__importTest.progress = callback; return () => {}; },
  onTranscriptionQueueState: (callback) => { window.__importTest.queue = callback; return () => {}; },
  listMeetings: async () => [{ id: 'new', title: 'Long meeting', date: new Date().toISOString(), duration: '0:01', transcriptionStatus: 'pending' }],
  getMeeting: async () => ({ id: 'new', title: 'Long meeting', transcriptionStatus: 'pending', transcript: window.__importTest.transcript || '' }),
};
