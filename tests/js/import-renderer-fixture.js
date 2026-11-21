'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, preload: path.join(__dirname, 'import-renderer-preload.js') } });
  let result;
  try {
    await win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
    result = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('loading-screen')?.remove();
      activateTab('record');
      const button = document.getElementById('import-audio-button');
      const railButton = document.getElementById('import-audio-rail-button');
      railButton.focus(); railButton.click();
      const railHistory = document.querySelector('.rail-btn[data-tab="history"]');
      const historyOpened = document.getElementById('history-tab').classList.contains('active') && railHistory.getAttribute('aria-current') === 'page';
      await new Promise(resolve => setTimeout(resolve, 30));
      const modal = document.getElementById('import-audio-modal');
      const opened = !modal.classList.contains('hidden');
      const name = document.getElementById('import-audio-name').textContent;
      const focus = document.activeElement.id;
      const inert = document.getElementById('history-tab').closest('body > *')?.inert;
      const resultActionsHidden = ['import-audio-open', 'import-audio-retry'].every((id) =>
        getComputedStyle(document.getElementById(id)).display === 'none');
      document.getElementById('import-audio-submit').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const resultTitle = document.getElementById('import-audio-title').textContent;
      const resultFocus = document.activeElement.id;
      window.__importTest.queue({ seq: 10, jobs: [{ meetingId: 'new', status: 'active', phase: 'transcribing' }] });
      const activeStatus = document.getElementById('import-audio-status').textContent;
      window.__importTest.queue({ seq: 11, jobs: [{ meetingId: 'new', status: 'active', phase: 'completed' }] });
      const readyStatus = document.getElementById('import-audio-status').textContent;
      window.__importTest.queue({ seq: 10, jobs: [{ meetingId: 'new', status: 'active', phase: 'transcribing' }] });
      const staleStatus = document.getElementById('import-audio-status').textContent;
      const call = window.__importTest.calls[0];
      document.getElementById('import-audio-cancel').click();
      const closed = modal.classList.contains('hidden'); const restored = document.activeElement.id;
      await loadMeetingHistory();
      window.__importTest.transcript = '# Recording Awaiting Transcription\\n\\nThe recording was saved successfully, but a transcript is not available yet.';
      await selectMeeting('new');
      const placeholderText = document.getElementById('meeting-transcript').textContent;
      const hasActivity = [...document.querySelectorAll('#meeting-transcript button')].some(button => button.textContent === 'View in Activity');
      window.__importTest.transcript = 'A previous transcript';
      currentMeetingId = null; await selectMeeting('new');
      const previousText = document.getElementById('meeting-transcript').textContent;
      activateTab('record');
      transcriptionQueueState = { jobs: [{ meetingId: 'new', title: 'Long meeting', status: 'active', phase: 'transcribing' }], seq: 20 };
      renderActivityList();
      const cancelAction = [...document.querySelectorAll('.activity-row button')].find(button => button.textContent === 'Cancel');
      cancelAction.focus();
      transcriptionQueueState = { jobs: [{ meetingId: 'new', title: 'Long meeting', status: 'failed', phase: 'cancelled' }], seq: 21 };
      renderActivityList();
      const cancelChip = document.querySelector('.activity-row .activity-chip').textContent;
      const rowFocus = document.activeElement.closest('.activity-row')?.dataset.meetingId;
      activateTab('history');
      document.getElementById('meeting-title-edit').click();
      const titleInput = document.getElementById('meeting-title-input');
      titleInput.value = 'Draft title'; titleInput.focus(); railButton.focus(); railButton.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const draftPreserved = document.getElementById('meeting-title-edit-form').style.display === 'flex' && titleInput.value === 'Draft title';
      document.getElementById('import-audio-submit').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('import-audio-open').click();
      const returnedToEdit = document.activeElement.id === 'meeting-title-input';
      document.getElementById('meeting-title-cancel').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const finalFocus = document.activeElement.id;
      button.click(); await new Promise(resolve => setTimeout(resolve, 30));
      window.__importTest.nextResult = { success: false, code: 'ENOSPC' };
      document.getElementById('import-audio-submit').click(); await new Promise(resolve => setTimeout(resolve, 30));
      const diskMessage = document.getElementById('import-audio-status').textContent;
      const diskRetry = document.getElementById('import-audio-retry').textContent;
      document.getElementById('import-audio-retry').click(); await new Promise(resolve => setTimeout(resolve, 30));
      const retryResult = document.getElementById('import-audio-title').textContent;
      document.getElementById('import-audio-cancel').click();
      window.__importTest.status = 'failed';
      window.__importTest.queue({ seq: 100, jobs: [{ meetingId: 'new', status: 'failed' }] });
      await new Promise(resolve => setTimeout(resolve, 30));
      const failedRetryVisible = document.getElementById('retry-transcription-btn').style.display !== 'none';
      const failedText = document.getElementById('meeting-transcript').textContent;
      window.__importTest.status = 'completed';
      window.__importTest.transcript = 'Finished transcript';
      window.__importTest.queue({ seq: 101, jobs: [{ meetingId: 'new', status: 'ready' }] });
      await new Promise(resolve => setTimeout(resolve, 30));
      const readyText = document.getElementById('meeting-transcript').textContent;
      const readyRetryHidden = document.getElementById('retry-transcription-btn').style.display === 'none';
      let releaseList;
      window.__importTest.listGate = new Promise(resolve => { releaseList = resolve; });
      button.click(); await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('import-audio-submit').click(); await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('import-audio-cancel').click();
      releaseList(); window.__importTest.listGate = null;
      await new Promise(resolve => setTimeout(resolve, 30));
      const focusAfterDismiss = document.activeElement.id;
      let pickerMessage = '';
      window.alert = message => { pickerMessage = message; };
      window.__importTest.pickerFails = true;
      button.click(); await new Promise(resolve => setTimeout(resolve, 30));
      window.__importTest.pickerFails = false;
      let releaseOpenList;
      window.__importTest.listGate = new Promise(resolve => { releaseOpenList = resolve; });
      window.__importTest.nextResult = { success: true, meeting: { id: 'fresh', title: 'Fresh', date: new Date().toISOString(), duration: '0:01', transcriptionStatus: 'pending' } };
      button.click(); await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('import-audio-submit').click(); await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('import-audio-open').click(); await new Promise(resolve => setTimeout(resolve, 30));
      const immediateOpenId = currentMeetingId;
      releaseOpenList(); window.__importTest.listGate = null;
      await new Promise(resolve => setTimeout(resolve, 30));
      const immediateOpenFocus = document.activeElement.id;
      return { historyOpened, opened, name, focus, inert, resultActionsHidden, resultTitle, resultFocus, activeStatus, readyStatus, staleStatus, call, closed, restored, draftPreserved, returnedToEdit, finalFocus, diskMessage, diskRetry, retryResult, placeholderText, hasActivity, previousText, cancelChip, rowFocus, failedRetryVisible, failedText, readyText, readyRetryHidden, focusAfterDismiss, pickerMessage, immediateOpenId, immediateOpenFocus };
    })()`, true);
    win.setContentSize(420, 360);
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: 420, height: 360 },
      viewSize: { width: 420, height: 360 },
    });
    result.shortWindowLayout = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('import-audio-button').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const dialog = document.querySelector('#import-audio-modal .modal-content');
      document.getElementById('import-audio-name').textContent = 'QuarterlyPlanningSession'.repeat(10) + '.wav';
      dialog.getAnimations().forEach(animation => animation.finish());
      const footer = dialog.querySelector('.modal-actions');
      const formBody = dialog.querySelector('.modal-body');
      const model = document.getElementById('import-audio-model');
      const initialFooterTop = footer.getBoundingClientRect().top;
      formBody.scrollTop = formBody.scrollHeight;
      const dialogBounds = dialog.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      return {
        dialogFits: dialogBounds.top >= 0 && dialogBounds.bottom <= innerHeight,
        bodyScrolls: formBody.scrollHeight > formBody.clientHeight && formBody.scrollTop > 0,
        bodyFitsWidth: formBody.scrollWidth <= formBody.clientWidth,
        footerVisible: footerBounds.bottom <= dialogBounds.bottom &&
          footerBounds.top > model.getBoundingClientRect().bottom,
        footerStaysPut: footerBounds.top === initialFooterTop
      };
    })()`, true);
  } catch (error) { result = { error: error.stack || String(error) }; }
  process.stdout.write('IMPORT_RENDERER_RESULT ' + JSON.stringify(result) + '\n');
  app.exit(result.error ? 1 : 0);
});
