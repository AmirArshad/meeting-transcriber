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
    },
  });
  const result = { error: null };
  try {
    await win.loadFile(indexHtml);
    win.showInactive();
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
      undefined;
    `, true);
    await win.webContents.executeJavaScript('window.__showHistoryMeeting()', true);
    result.short = await win.webContents.executeJavaScript(`window.__measureHistory(${buttonIds})`, true);
    result.summary = await win.webContents.executeJavaScript('window.__prepareSummaryCancellation()', true);
    const center = await win.webContents.executeJavaScript("window.__buttonCenter('generate-summary-btn')", true);
    result.hit = await win.webContents.executeJavaScript(`window.__hitTargetAt(${center.x}, ${center.y})`, true);
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
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

    win.setContentSize(800, 900);
    result.tallViewport = await win.webContents.executeJavaScript('window.__settle()', true);
    result.tall = await win.webContents.executeJavaScript(`window.__measureHistory(${buttonIds})`, true);
  } catch (error) {
    result.error = error && error.stack ? error.stack : String(error);
  }
  process.stdout.write(`\nHISTORY_DETAIL_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.error ? 1 : 0);
}).catch((error) => {
  process.stdout.write(`\nHISTORY_DETAIL_RESULT ${JSON.stringify({ error: error.stack || String(error) })}\n`);
  app.exit(1);
});
