'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const indexHtml = path.join(__dirname, '../../src/renderer/index.html');

function clippedBy(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return 'zero-box';
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
    const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
    if (!clipsY && !clipsX) continue;
    const host = node.getBoundingClientRect();
    const name = node.id || node.className || node.tagName;
    if (clipsY && (rect.top < host.top - 1 || rect.bottom > host.bottom + 1)) return String(name);
    if (clipsX && (rect.left < host.left - 1 || rect.right > host.right + 1)) return String(name);
  }
  return null;
}

function fullyReachable(element) {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  const verticallyVisible = rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
  const horizontallyVisible = rect.left >= -1 && rect.right <= window.innerWidth + 24;
  return verticallyVisible && horizontallyVisible && !clippedBy(element);
}

function measureHistory(ids) {
  const pane = document.querySelector('.history-content');
  const transcript = document.getElementById('meeting-transcript');
  const transcriptStyle = getComputedStyle(transcript);
  const transcriptContentHeight = transcript.clientHeight
    - parseFloat(transcriptStyle.paddingTop)
    - parseFloat(transcriptStyle.paddingBottom);
  const buttons = ids.map((id) => {
    const element = document.getElementById(id);
    const rect = element.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    return {
      id,
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      clippedBy: clippedBy(element),
      insidePane: rect.top >= paneRect.top - 1
        && rect.bottom <= paneRect.bottom + 1
        && rect.left >= paneRect.left - 1
        && rect.right <= paneRect.right + 1,
    };
  });
  const reachable = ids.map((id) => fullyReachable(document.getElementById(id)));
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    transcriptClientHeight: transcript.clientHeight,
    transcriptContentHeight,
    paneHeight: pane.clientHeight,
    buttons: buttons.map((button, index) => ({ ...button, reachable: reachable[index] })),
  };
}

function showHistoryMeeting() {
  const loading = document.getElementById('loading-screen');
  if (loading) loading.remove();
  document.getElementById('record-tab').classList.remove('active');
  document.getElementById('history-tab').classList.add('active');
  document.getElementById('meeting-details-empty').style.display = 'none';
  const details = document.getElementById('meeting-details');
  details.style.display = 'flex';
  const transcript = document.getElementById('meeting-transcript');
  transcript.textContent = 'A readable transcript line.\n'.repeat(30);
}

async function prepareSummaryCancellation() {
  currentMeetingId = 'meeting-1';
  summaryGenerationMeetingId = 'meeting-1';
  summaryGenerationCancelling = false;
  window.__cancelCalls = 0;
  window.electronAPI = {
    cancelSummaryGeneration: async () => {
      window.__cancelCalls += 1;
      return { canceled: true };
    },
  };
  updateSummaryGenerationButtons();
  const button = document.getElementById('generate-summary-btn');
  button.addEventListener('click', () => handleSummaryGenerationButtonClick(currentMeetingId, button));
  return {
    disabled: button.disabled,
    className: button.className,
    hoverLabel: button.dataset.hoverLabel || '',
    pointerEvents: getComputedStyle(button).pointerEvents,
    color: getComputedStyle(button).color,
    afterContent: getComputedStyle(button, '::after').content,
  };
}

function buttonCenter(id) {
  const button = document.getElementById(id);
  button.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = button.getBoundingClientRect();
  return {
    x: Math.round(rect.left + (rect.width / 2)),
    y: Math.round(rect.top + (rect.height / 2)),
    id: button.id,
  };
}

function hitTargetAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  return {
    id: hit && hit.id ? hit.id : '',
    className: hit && hit.className ? String(hit.className) : '',
    tag: hit ? hit.tagName : '',
  };
}

function hoverLabelContent() {
  const button = document.getElementById('generate-summary-btn');
  return getComputedStyle(button, '::after').content;
}

function cancellingStyle() {
  const button = document.getElementById('generate-summary-btn');
  return {
    pointerEvents: getComputedStyle(button).pointerEvents,
    disabled: button.disabled,
    className: button.className,
  };
}

function installLoadingStyle() {
  const probe = document.createElement('button');
  probe.type = 'button';
  probe.className = 'btn btn-primary is-loading';
  probe.textContent = 'Enable summaries';
  document.querySelector('.history-toolbar-actions').appendChild(probe);
  const style = getComputedStyle(probe);
  return {
    pointerEvents: style.pointerEvents,
    color: style.color,
    afterContent: getComputedStyle(probe, '::after').content,
  };
}

async function exerciseSpeakerSave() {
  const meeting = {
    id: 'meeting-1', title: 'Calibration', date: '2026-11-20', duration: '0:04',
    transcript: '[00:00 - 00:02] **Speaker 1:** Approved calibration.\n[00:02 - 00:04] **Speaker 2:** Next steps.',
    language: 'en', transcriptionStatus: 'completed',
    ai: { diarization: { status: 'completed', speakerNames: {} } },
  };
  const next = { ...meeting, id: 'meeting-2', title: 'Next recording', transcript: '' };
  const model = {
    modelId: 'available', modelName: 'Available', installed: true, setupComplete: true, status: 'ready',
    languagePolicy: { languages: ['en'], names: { en: 'English' } },
  };
  const library = { defaultModelId: model.modelId, models: [model] };
  meetings = [meeting, next];
  currentMeetingId = meeting.id;
  summaryGenerationMeetingId = null;
  summaryGenerationCancelling = false;
  let saveStarted;
  let releaseSave;
  let reads = [];
  const prepareSave = () => {
    const started = new Promise((resolve) => { saveStarted = resolve; });
    const saving = new Promise((resolve) => { releaseSave = resolve; });
    window.electronAPI.updateMeeting = async (_id, updates) => {
      saveStarted();
      await saving;
      Object.assign(meeting.ai.diarization.speakerNames, updates.speakerNames);
      return meeting;
    };
    return started;
  };
  window.electronAPI = {
    getAiAddonStatus: async () => ({ features: { summary: model }, summaryLibrary: library }),
    getMeeting: async (id) => {
      reads.push(id);
      return id === meeting.id ? meeting : next;
    },
  };
  renderHistorySpeakers(meeting, parseTranscriptMarkdownSegments(meeting.transcript));
  const nameField = document.getElementById('history-speaker-name-Speaker-1');
  const started = prepareSave();
  nameField.focus();
  nameField.value = 'Maya Chen';
  nameField.blur();
  await started;
  const generating = generateSummaryForMeeting(meeting.id);
  await settle();
  const readBeforeSummarySave = reads.length;
  releaseSave();

  const modal = document.getElementById('summary-language-modal');
  const deadline = performance.now() + 2000;
  while (modal.classList.contains('hidden')) {
    if (performance.now() > deadline) throw new Error('Prepare summary did not open');
    await settle();
  }
  const preparedName = document.getElementById('summary-speaker-name-Speaker-1').value;
  const labelStyle = (selector) => {
    const style = getComputedStyle(modal.querySelector(selector));
    return [style.fontFamily, style.fontSize, style.fontWeight, style.color, style.letterSpacing, style.textTransform];
  };
  const sectionStyles = [
    '#summary-model-field label', 'label[for="summary-transcript-language"]',
    '#summary-speaker-fieldset legend', '#summary-recording-type > label',
  ].map(labelStyle);
  document.getElementById('summary-language-cancel').click();
  await generating;

  reads = [];
  const nextSave = prepareSave();
  const refreshedField = document.getElementById('history-speaker-name-Speaker-1');
  refreshedField.focus();
  refreshedField.value = 'Maya Patel';
  refreshedField.blur();
  await nextSave;
  const switching = selectMeeting(next.id);
  await settle();
  const selectionBeforeSave = currentMeetingId;
  const readBeforeSwitchSave = reads.length;
  releaseSave();
  await switching;
  return { readBeforeSummarySave, preparedName, sectionStyles, selectionBeforeSave, readBeforeSwitchSave, selected: currentMeetingId, reads };
}

function exerciseChatAndTagControls() {
  meetings = Array.from({ length: 24 }, (_, i) => ({ id: String(i), title: `Recording ${i}`, tag: 'meeting' }));
  renderHistoryTagFilterBar();
  const historyTag = () => document.querySelector('#history-tag-filter-bar [data-tag="meeting"]');
  if (!historyTag()) throw new Error('History tag was not rendered');
  historyTag().focus();
  historyTag().click();
  const historyFocusRestored = historyTag() === document.activeElement && historyTag().getAttribute('aria-pressed') === 'true';

  document.getElementById('history-tab').classList.remove('active');
  document.getElementById('chat-tab').classList.add('active');
  const scopeBtn = document.getElementById('chat-scope-btn');
  scopeBtn.click();
  document.getElementById('chat-scope-selected-btn').click();
  document.getElementById('chat-scope-tags-toggle-btn').click();
  const scopeTag = () => document.querySelector('#chat-scope-tags-row [data-tag="meeting"]');
  if (!scopeTag()) throw new Error(`Scope tag was not rendered. Popover open: ${chatState.popoverOpen}`);
  scopeTag().focus();
  scopeTag().click();
  const scopeFocusRestored = scopeTag() === document.activeElement && scopeTag().getAttribute('aria-pressed') === 'true';
  const popover = document.getElementById('chat-scope-popover');
  const popoverStyle = getComputedStyle(popover);
  const overflow = {
    maxHeight: popoverStyle.maxHeight,
    overflowY: popoverStyle.overflowY,
    topClipped: Boolean(clippedBy(popover)),
  };
  scopeTag().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const escapeClosesScope = popover.hidden && scopeBtn === document.activeElement && scopeBtn.getAttribute('aria-expanded') === 'false';

  const ready = { modelId: 'ready', modelName: 'Ready', installed: true, setupComplete: true, status: 'ready' };
  const unavailable = { modelId: 'unavailable', modelName: 'Unavailable', installed: true, status: 'error' };
  const library = { defaultModelId: ready.modelId, models: [ready, unavailable] };
  aiAddonStatusSnapshot = { summaryLibrary: library };
  chatState.eligibility = { eligible: true };
  chatState.pendingModelId = unavailable.modelId;
  renderChatOnboardingAndComposer();
  renderChatStream();
  const checkEligibility = () => ({
    sendDisabled: document.getElementById('chat-send-btn').disabled,
    starterDisabled: [...document.querySelectorAll('.chat-starter-btn')].map((btn) => btn.disabled),
  });
  const unavailableControls = checkEligibility();
  chatState.pendingModelId = ready.modelId;
  renderChatOnboardingAndComposer();
  const availableControls = checkEligibility();

  const recoveryCards = [null, 'missing', 'unavailable'].map((modelId) => {
    chatState.modelState = { status: 'release_error', modelId };
    renderSummaryModelLibrary(library);
    const button = [...document.querySelectorAll('#summary-model-library button')].find((el) => el.textContent === 'Free memory');
    return button?.closest('[data-model-id]')?.dataset.modelId || null;
  });
  const chip = document.createElement('span');
  chip.className = 'chat-source-tag-chip';
  document.getElementById('chat-messages').appendChild(chip);
  const chipStyle = getComputedStyle(chip);
  const sourceChip = { marginRight: chipStyle.marginRight, textTransform: chipStyle.textTransform };
  return { historyFocusRestored, scopeFocusRestored, escapeClosesScope, overflow, unavailableControls, availableControls, recoveryCards, sourceChip };
}

function settle() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      width: window.innerWidth,
      height: window.innerHeight,
    })));
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'history-detail-renderer-preload.js'),
    },
  });
  const result = { error: null };
  try {
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') process.stderr.write(`Renderer error: ${details.message}\n`);
    });
    await win.loadFile(indexHtml);
    win.showInactive();
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const setViewport = (width, height) => dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await setViewport(600, 400);
    const buttonIds = JSON.stringify(['generate-summary-btn', 'copy-transcript-btn', 'save-meeting-transcript-btn']);
    await win.webContents.executeJavaScript(`
      ${clippedBy.toString()}
      ${fullyReachable.toString()}
      ${measureHistory.toString()}
      window.__measureHistory = measureHistory;
      window.__showHistoryMeeting = ${showHistoryMeeting.toString()};
      window.__prepareSummaryCancellation = ${prepareSummaryCancellation.toString()};
      window.__buttonCenter = ${buttonCenter.toString()};
      window.__hitTargetAt = ${hitTargetAt.toString()};
      window.__hoverLabelContent = ${hoverLabelContent.toString()};
      window.__cancellingStyle = ${cancellingStyle.toString()};
      window.__installLoadingStyle = ${installLoadingStyle.toString()};
      window.__settle = ${settle.toString()};
      ${settle.toString()}
      window.__exerciseSpeakerSave = ${exerciseSpeakerSave.toString()};
      window.__exerciseChatAndTagControls = ${exerciseChatAndTagControls.toString()};
      undefined;
    `, true);
    await win.webContents.executeJavaScript('window.__showHistoryMeeting()', true);
    // Explicitly park the synthetic pointer before measuring the unhovered state.
    // Its initial location can otherwise coincide with the button in a hidden window.
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0, button: 'none' });
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      function check() {
        if (!document.getElementById('generate-summary-btn').matches(':hover')) return resolve();
        if (performance.now() >= deadline) return reject(new Error('Pointer did not leave summary button'));
        requestAnimationFrame(check);
      }
      check();
    })`, true);
    result.short = await win.webContents.executeJavaScript(`window.__measureHistory(${buttonIds})`, true);
    result.summary = await win.webContents.executeJavaScript('window.__prepareSummaryCancellation()', true);
    const center = await win.webContents.executeJavaScript("window.__buttonCenter('generate-summary-btn')", true);
    result.hit = await win.webContents.executeJavaScript(`window.__hitTargetAt(${center.x}, ${center.y})`, true);
    const pointerAt = async (type, point, clickCount = 0) => {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount,
      });
    };
    await pointerAt('mouseMoved', center);
    // CDP dispatch completion precedes Chromium's hover/style update on some runs.
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      function check() {
        if (document.getElementById('generate-summary-btn').matches(':hover')) return resolve();
        if (performance.now() >= deadline) return reject(new Error('Pointer did not enter summary button'));
        requestAnimationFrame(check);
      }
      check();
    })`, true);
    result.hoverAfter = await win.webContents.executeJavaScript('window.__hoverLabelContent()', true);
    await pointerAt('mousePressed', center, 1);
    await pointerAt('mouseReleased', center, 1);
    result.cancelCalls = await win.webContents.executeJavaScript('window.__cancelCalls', true);
    result.cancelling = await win.webContents.executeJavaScript('window.__cancellingStyle()', true);
    const cancellingCenter = await win.webContents.executeJavaScript("window.__buttonCenter('generate-summary-btn')", true);
    await pointerAt('mousePressed', cancellingCenter, 1);
    await pointerAt('mouseReleased', cancellingCenter, 1);
    result.cancelCallsAfterBlockedClick = await win.webContents.executeJavaScript('window.__cancelCalls', true);
    result.install = await win.webContents.executeJavaScript('window.__installLoadingStyle()', true);

    await setViewport(800, 900);
    result.tallViewport = await win.webContents.executeJavaScript('window.__settle()', true);
    result.tall = await win.webContents.executeJavaScript(`window.__measureHistory(${buttonIds})`, true);
    const exercise = async (name) => {
      const result = await win.webContents.executeJavaScript(`
        Promise.resolve().then(() => window[${JSON.stringify(name)}]()).catch((error) => ({ error: error.stack }))
      `, true);
      if (result.error) throw new Error(result.error);
      return result;
    };
    result.speakerSave = await exercise('__exerciseSpeakerSave');
    await setViewport(1050, 800);
    await win.webContents.executeJavaScript('window.__settle()', true);
    result.chatAndTags = await exercise('__exerciseChatAndTagControls');
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
  }
  process.stdout.write(`\nHISTORY_DETAIL_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.error ? 1 : 0);
}).catch((error) => {
  process.stdout.write(`\nHISTORY_DETAIL_RESULT ${JSON.stringify({ error: error.stack || String(error) })}\n`);
  app.exit(1);
});
