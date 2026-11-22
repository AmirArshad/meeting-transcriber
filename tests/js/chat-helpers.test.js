'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const {
  buildAssistantNoticeView,
  buildModelMemoryPillView,
  buildStarterPrompts,
  filterChatThreads,
  formatAssistantTurnMeta,
  formatChatScopeLabel,
  formatScopeMeetingDate,
  formatScopeMeetingDateTooltip,
  groupThreadsByRecency,
  isCitedMeetingAvailable,
  isScopeFiltered,
  resolveNoticeActionScope,
  shouldShowChatProgressBanner,
} = require('../../src/renderer/chat-helpers');

function electronFixtureArgs(fixturePath) {
  const args = [fixturePath];
  if (process.platform === 'linux') {
    args.unshift('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  }
  return args;
}

function runChatMarkdownFixture({ signal = null, timeoutMs = 45000 } = {}) {
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'linux') {
    env.ELECTRON_DISABLE_SANDBOX = '1';
  }
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('Chat fixture aborted before launch.'));
      return;
    }

    const child = spawn(
      electron,
      electronFixtureArgs(path.join(__dirname, 'chat-markdown-renderer-fixture.js')),
      { env, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killChild = () => {
      try {
        child.kill('SIGKILL');
      } catch (_err) {
        // Best-effort cleanup.
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      reject(err);
    };

    const onAbort = () => {
      fail(new Error('Chat fixture aborted by test signal.'));
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutHandle = setTimeout(() => {
      fail(new Error(`Chat fixture timed out after ${timeoutMs}ms.\n${stderr}\n${stdout}`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const marker = stdout.lastIndexOf('CHAT_RENDER_RESULT ');
      if (marker === -1) {
        reject(new Error(`Chat fixture exited ${code} without output.\n${stderr}\n${stdout}`));
        return;
      }
      const result = JSON.parse(stdout.slice(marker + 'CHAT_RENDER_RESULT '.length));
      if (result.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result);
    });
  });
}

test('groupThreadsByRecency buckets threads accurately across Today, Yesterday, Week, Older', () => {
  const now = new Date(2026, 10, 20, 14, 0, 0);
  const groups = groupThreadsByRecency(
    [
      { id: 't1', updatedAt: new Date(2026, 10, 20, 9, 0, 0).toISOString() },
      { id: 't2', updatedAt: new Date(2026, 10, 19, 18, 0, 0).toISOString() },
      { id: 't3', updatedAt: new Date(2026, 10, 15, 10, 0, 0).toISOString() },
      { id: 't4', updatedAt: new Date(2026, 9, 1, 10, 0, 0).toISOString() },
    ],
    now,
  );

  assert.deepEqual(
    groups.map((g) => [g.label, g.threads.map((t) => t.id)]),
    [
      ['Today', ['t1']],
      ['Yesterday', ['t2']],
      ['Previous 7 Days', ['t3']],
      ['Older', ['t4']],
    ],
  );
});

test('filterChatThreads, formatChatScopeLabel, and buildModelMemoryPillView produce clean view models', () => {
  const filtered = filterChatThreads(
    [
      { id: '1', title: 'Q4 Budget', lastMessagePreview: 'discussed cap' },
      { id: '2', title: 'Standup', lastMessagePreview: 'shipped build' },
    ],
    'cap',
  );
  assert.deepEqual(filtered.map((t) => t.id), ['1']);

  const map = new Map([['m1', { id: 'm1', title: 'Architecture Sync' }]]);
  assert.equal(formatChatScopeLabel({ type: 'all' }, map), 'All recordings');
  assert.equal(
    formatChatScopeLabel({ type: 'selected_meetings', meetingIds: ['m1'], dateFrom: '2026-11-01' }, map),
    'Architecture Sync · From 2026-11-01',
  );
  assert.equal(
    formatChatScopeLabel({ type: 'selected_meetings', meetingIds: ['m1', 'm2'] }, map),
    '2 recordings',
  );

  assert.deepEqual(buildModelMemoryPillView({ status: 'unloaded' }), {
    status: 'unloaded',
    label: 'Not loaded',
    tone: 'unloaded',
    showUnload: false,
    busy: false,
  });
  assert.deepEqual(buildModelMemoryPillView({ status: 'loaded', modelName: 'Qwen3.5 9B' }), {
    status: 'loaded',
    label: 'Loaded · Qwen3.5 9B',
    tone: 'loaded',
    showUnload: true,
    busy: false,
  });
  assert.equal(buildModelMemoryPillView({ status: 'release_error' }).showUnload, true);

  const scopedPrompts = buildStarterPrompts(
    [{ id: 'm1', title: 'Q4 Launch' }],
    { type: 'selected_meetings', meetingIds: ['m1'] },
  );
  assert.equal(scopedPrompts.length, 3);
  assert.match(scopedPrompts[0], /Q4 Launch/);

  assert.equal(isCitedMeetingAvailable({ meetingId: 'm1' }, [{ id: 'm1' }]), true);
  assert.equal(isCitedMeetingAvailable({ meetingId: 'gone' }, [{ id: 'm1' }]), false);
});

test('real Chromium strict CSP loads bundled marked + DOMPurify, strips XSS & forged buttons, and builds verified citation pills', { timeout: 60000 }, async (t) => {
  const result = await runChatMarkdownFixture({ signal: t.signal });
  const r = result.render;

  assert.equal(r.hasMarked, true);
  assert.equal(r.hasDOMPurify, true);
  assert.equal(r.hasChatTabActive, true);
  assert.equal(r.modelPillText, 'Not loaded');
  assert.equal(r.modelUnloadHidden, true);

  assert.equal(r.xssTriggered, 0);
  assert.equal(r.scriptCount, 0);
  assert.equal(r.imgCount, 0);
  assert.equal(r.linkCount, 0);
  assert.equal(r.svgCount, 0);
  assert.equal(r.forgedPillExists, false);
  assert.equal(r.inlineCodeHasButton, false);
  assert.equal(r.preCodeHasButton, false);

  assert.equal(r.tableCount, 1);
  assert.equal(r.blockquoteCount, 1);
  assert.equal(r.pillCount, 1);
  assert.deepEqual(r.pillDatasetIds, ['meeting_real_1']);
  assert.deepEqual(r.pillTexts, ['Q4 Planning · 14:22']);
  assert.equal(r.clickedCount, 1);
  assert.equal(r.clickedFirstMeetingId, 'meeting_real_1');
  assert.equal(r.clickedFirstStartSec, 862);
  assert.deepEqual(r.copiedCode, ['const marker = "[E1]";\n']);
});

test('recency uses calendar dates across daylight saving changes', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/London';
  try {
    const groups = groupThreadsByRecency([{ id: 'before', updatedAt: '2026-03-29T12:00:00' }], new Date('2026-03-30T12:00:00'));
    assert.equal(groups[0].id, 'yesterday');
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});


test('isScopeFiltered and buildAssistantNoticeView produce honest recovery actions across all three failure states', () => {
  assert.equal(isScopeFiltered({ type: 'all' }), false);
  assert.equal(isScopeFiltered({ type: 'selected_meetings', meetingIds: ['m1'] }), true);
  assert.equal(isScopeFiltered({ type: 'all', dateFrom: '2026-09-05' }), true);

  assert.equal(buildAssistantNoticeView({ status: 'answered', content: 'Ok' }), null);

  const noMatch = buildAssistantNoticeView(
    { status: 'no_matching_excerpts', searchedMeetingCount: 2, detectedDateFilter: '2026-09-05' },
    { type: 'selected_meetings', meetingIds: ['m1', 'm2'], dateFrom: '2026-09-01' },
  );
  assert.equal(noMatch.variant, 'no_matching_excerpts');
  assert.match(noMatch.title, /2026-09-05/);
  assert.deepEqual(noMatch.actions.map((a) => a.id), ['search_all', 'reset_filters', 'ask_without_recordings']);
  assert.equal(noMatch.showInspectedSources, false);

  const insufficient = buildAssistantNoticeView(
    {
      status: 'insufficient_evidence',
      searchedMeetingCount: 3,
      evidenceCount: 4,
      content: 'The recordings mention Q4 milestones, but not the final ship date.',
      inspectedSources: [{ meetingId: 'm1' }],
    },
    { type: 'all' },
  );
  assert.equal(insufficient.variant, 'insufficient_evidence');
  assert.match(insufficient.title, /Found 4 matching passages/);
  assert.equal(insufficient.explanation, 'The recordings mention Q4 milestones, but not the final ship date.');
  assert.deepEqual(insufficient.actions.map((a) => a.id), ['ask_without_recordings', 'retry']);
  assert.equal(insufficient.showInspectedSources, true);

  const verFail = buildAssistantNoticeView(
    { status: 'verification_failed', inspectedSources: [{ meetingId: 'm1' }] },
    { type: 'selected_meetings', meetingIds: ['m1'] },
  );
  assert.equal(verFail.variant, 'verification_failed');
  assert.deepEqual(verFail.actions.map((a) => a.id), ['retry', 'search_all']);
  assert.equal(verFail.showInspectedSources, true);

  // Unfiltered "All recordings" notice copy stays accurate across all 3 no_matching_excerpts variants.
  const unfilteredDefault = buildAssistantNoticeView(
    { status: 'no_matching_excerpts', searchedMeetingCount: 5 },
    { type: 'all' },
  );
  assert.equal(unfilteredDefault.title, 'No matching passages found across your recordings.');

  const unfilteredDate = buildAssistantNoticeView(
    { status: 'no_matching_excerpts', searchedMeetingCount: 5, detectedDateFilter: '2026-09-05' },
    { type: 'all' },
  );
  assert.equal(unfilteredDate.title, 'No recordings matched "2026-09-05".');

  const unfilteredEmpty = buildAssistantNoticeView(
    { status: 'no_matching_excerpts', searchedMeetingCount: 0 },
    { type: 'all' },
  );
  assert.equal(unfilteredEmpty.title, 'No indexed recordings are available yet.');
});

test('shouldShowChatProgressBanner and resolveNoticeActionScope handle post-stream phases and empty selected reset', () => {
  assert.equal(shouldShowChatProgressBanner({ sendVisible: false, streamingDraft: '', progress: { phase: 'verifying' } }), false);
  assert.equal(shouldShowChatProgressBanner({ sendVisible: true, streamingDraft: 'Partial draft', progress: { phase: 'streaming' } }), false);
  assert.equal(shouldShowChatProgressBanner({ sendVisible: true, streamingDraft: 'Partial draft', progress: { phase: 'verifying' } }), true);
  assert.equal(shouldShowChatProgressBanner({ sendVisible: true, streamingDraft: 'Partial draft', progress: { phase: 'citation-repair' } }), true);
  assert.equal(shouldShowChatProgressBanner({ sendVisible: true, streamingDraft: 'Partial draft', progress: { phase: 'json-repair' } }), true);

  assert.deepEqual(
    resolveNoticeActionScope('reset_filters', { type: 'selected_meetings', meetingIds: [], dateFrom: '2026-09-01', dateTo: '2026-09-30', tags: ['call'] }),
    { type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] },
  );
  assert.deepEqual(
    resolveNoticeActionScope('reset_filters', { type: 'selected_meetings', meetingIds: ['m1'], dateFrom: '2026-09-01', tags: ['meeting'] }),
    { type: 'selected_meetings', meetingIds: ['m1'], dateFrom: null, dateTo: null, tags: [] },
  );
  assert.deepEqual(
    resolveNoticeActionScope('search_all', { type: 'selected_meetings', meetingIds: ['m1'], tags: ['call'] }),
    { type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] },
  );
  assert.equal(resolveNoticeActionScope('retry', { type: 'all' }), null);
});

test('formatChatScopeLabel, isScopeFiltered, and buildAssistantNoticeView support scope.tags', () => {
  assert.equal(formatChatScopeLabel({ type: 'all', tags: ['call'] }), 'All recordings · Phone / Support Call');
  assert.equal(
    formatChatScopeLabel({ type: 'all', tags: ['voice-note'] }, null, (slug) => `Custom:${slug}`),
    'All recordings · Custom:voice-note',
  );
  assert.equal(
    formatChatScopeLabel({ type: 'all', tags: ['call', 'interview'], dateFrom: '2026-11-01', dateTo: '2026-11-30' }),
    'All recordings · 2 tags · 2026-11-01 – 2026-11-30',
  );

  assert.equal(isScopeFiltered({ type: 'all', tags: ['call'] }), true);
  assert.equal(isScopeFiltered({ type: 'all', tags: [] }), false);

  const noMatchWithTag = buildAssistantNoticeView(
    { status: 'no_matching_excerpts', searchedMeetingCount: 2 },
    { type: 'all', tags: ['call'] },
  );
  assert.deepEqual(noMatchWithTag.actions.map((a) => a.id), ['reset_filters', 'ask_without_recordings']);
});

test('general chat mode (scope.type = none) formats scope, starters, notice actions, and turn footer cleanly', () => {
  assert.equal(formatChatScopeLabel({ type: 'none' }), 'General chat · No recordings');
  assert.equal(
    formatChatScopeLabel({ type: 'none', tags: ['call'], dateFrom: '2026-11-01' }),
    'General chat · No recordings',
  );
  assert.equal(isScopeFiltered({ type: 'none' }), false);

  const generalStarters = buildStarterPrompts([], { type: 'none' });
  assert.equal(generalStarters.length, 3);
  assert.ok(generalStarters.every((p) => !/Record or import audio first/i.test(p)));

  assert.deepEqual(
    resolveNoticeActionScope('ask_without_recordings', { type: 'selected_meetings', meetingIds: ['m1'], tags: ['call'] }),
    { type: 'none', meetingIds: [], dateFrom: null, dateTo: null, tags: [] },
  );

  const generalFooter = formatAssistantTurnMeta(
    { chatMode: 'general', modelName: 'Qwen3.5 9B', searchedMeetingCount: 0, evidenceCount: 0 },
  );
  assert.equal(generalFooter, 'Qwen3.5 9B · General chat (no recordings)');
  assert.doesNotMatch(generalFooter, /Searched/i);

  const generalFooterWithId = formatAssistantTurnMeta(
    { chatMode: 'general', modelId: 'qwen-9b', searchedMeetingCount: 5 },
    (id) => (id === 'qwen-9b' ? 'Qwen3.5 9B' : id),
  );
  assert.equal(generalFooterWithId, 'Qwen3.5 9B · General chat (no recordings)');

  const groundedFooter = formatAssistantTurnMeta(
    { chatMode: 'grounded', modelName: 'Qwen3.5 9B', searchedMeetingCount: 2, evidenceCount: 3 },
  );
  assert.equal(groundedFooter, 'Qwen3.5 9B · Searched 2 recordings · 3 matching excerpts');
  assert.equal(
    formatAssistantTurnMeta({ modelName: 'Qwen3.5 9B', searchedMeetingCount: 0 }),
    'Qwen3.5 9B',
  );
});

test('formatScopeMeetingDate and formatScopeMeetingDateTooltip format compact and full timestamps safely', () => {
  const now = new Date(2026, 10, 22, 16, 0, 0);
  const sameYear = new Date(2026, 10, 22, 14, 30, 0).toISOString();
  const priorYear = new Date(2025, 11, 18, 9, 5, 0).toISOString();

  const shortSameYear = formatScopeMeetingDate(sameYear, now);
  assert.match(shortSameYear, /^Nov 22, \d{1,2}:\d{2}\s[AP]M$/);
  assert.doesNotMatch(shortSameYear, /2026/);

  const shortPriorYear = formatScopeMeetingDate(priorYear, now);
  assert.equal(shortPriorYear, 'Dec 18, 2025');

  const tooltip = formatScopeMeetingDateTooltip(priorYear);
  assert.match(tooltip, /^Dec 18, 2025, \d{1,2}:\d{2}\s[AP]M$/);

  assert.equal(formatScopeMeetingDate('', now), '');
  assert.equal(formatScopeMeetingDate(null, now), '');
  assert.equal(formatScopeMeetingDate('not-a-date', now), '');
  assert.equal(formatScopeMeetingDateTooltip('not-a-date'), '');
});
