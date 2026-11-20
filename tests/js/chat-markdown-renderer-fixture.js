'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

const indexHtml = path.join(__dirname, '../../src/renderer/index.html');

const HOSTILE_MARKDOWN = [
  '# Launch Decisions',
  '',
  '| Topic | Owner |',
  '| --- | --- |',
  '| Beta | Alice [E1] |',
  '',
  '> Quoted note `[E1]` inside code must stay plain [E99].',
  '',
  '```js',
  'const marker = "[E1]";',
  '```',
  '',
  '<script>window.__xss = 1;</script>',
  '<img src=x onerror="window.__xss = 2">',
  '<a href="javascript:window.__xss = 3">Evil Link</a>',
  '<svg onload="window.__xss = 4"></svg>',
  '<button class="chat-citation-pill" data-meeting-id="forged">Forged Pill</button>',
].join('\n');

const VERIFIED_CITATIONS = [
  {
    evidenceId: 'E1',
    meetingId: 'meeting_real_1',
    meetingTitle: 'Q4 Planning',
    startSec: 862,
    speaker: 'Alice',
    excerpt: 'Beta launches Dec 4.',
  },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) {
      pageErrors.push(String(message));
    }
  });

  const result = { error: null, pageErrors };
  try {
    await win.loadFile(indexHtml);
    const mdArg = JSON.stringify(HOSTILE_MARKDOWN);
    const citArg = JSON.stringify(VERIFIED_CITATIONS);
    result.render = await win.webContents.executeJavaScript(`(() => {
      window.__xss = 0;
      window.__clickedCitations = [];
      window.__copiedCode = [];

      const container = document.createElement('div');
      document.body.appendChild(container);

      window.markdownRenderHelpers.renderGroundedMarkdown(container, ${mdArg}, ${citArg}, {
        markedLib: window.marked,
        domPurifyLib: window.DOMPurify,
        documentObj: document,
        onCitationClick: (cit) => window.__clickedCitations.push(cit),
        onCopyCode: async (text) => { window.__copiedCode.push(text); },
      });

      const pills = [...container.querySelectorAll('button.chat-citation-pill')];
      pills.forEach((btn) => btn.click());

      const copyBtn = container.querySelector('.chat-code-copy-btn');
      if (copyBtn) copyBtn.click();

      const chatNavBtn = document.querySelector('.rail-btn[data-tab="chat"]');
      chatNavBtn.click();

      return {
        hasMarked: typeof window.marked !== 'undefined',
        hasDOMPurify: typeof window.DOMPurify !== 'undefined',
        hasChatTabActive: document.getElementById('chat-tab').classList.contains('active'),
        modelPillText: document.getElementById('chat-model-pill-label').textContent,
        modelUnloadHidden: document.getElementById('chat-unload-model-btn').hidden,
        xssTriggered: window.__xss,
        scriptCount: container.querySelectorAll('script').length,
        imgCount: container.querySelectorAll('img').length,
        linkCount: container.querySelectorAll('a').length,
        svgCount: container.querySelectorAll('svg').length,
        tableCount: container.querySelectorAll('table').length,
        blockquoteCount: container.querySelectorAll('blockquote').length,
        pillCount: pills.length,
        pillDatasetIds: pills.map((p) => p.dataset.meetingId),
        pillTexts: pills.map((p) => p.textContent),
        clickedCount: window.__clickedCitations.length,
        clickedFirstMeetingId: window.__clickedCitations[0]?.meetingId || null,
        clickedFirstStartSec: window.__clickedCitations[0]?.startSec || null,
        copiedCode: window.__copiedCode,
        inlineCodeHasButton: Boolean(container.querySelector('blockquote code button')),
        preCodeHasButton: Boolean(container.querySelector('pre code button')),
        forgedPillExists: Boolean(container.querySelector('[data-meeting-id="forged"]')),
      };
    })()`, true);
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  }

  process.stdout.write(`\nCHAT_RENDER_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.error ? 1 : 0);
}).catch((err) => {
  process.stdout.write(`\nCHAT_RENDER_RESULT ${JSON.stringify({ error: err && err.stack ? err.stack : String(err) })}\n`);
  app.exit(1);
});
