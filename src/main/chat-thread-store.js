'use strict';

/**
 * Atomic, serialized JSON thread store for local History Chat (`userData/chat/threads.json`).
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_THREAD_TITLE = 'New chat';
const VALID_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sanitizeOptionalIsoDate(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !VALID_ISO_DATE_RE.test(raw)) {
    return null;
  }
  return raw;
}

function sanitizeThreadTitle(value, fallback = DEFAULT_THREAD_TITLE) {
  const cleaned = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function autoTitleFromQuestion(question) {
  const cleaned = String(question || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return DEFAULT_THREAD_TITLE;
  }
  if (cleaned.length <= 64) {
    return cleaned;
  }
  const slice = cleaned.slice(0, 64);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= 24 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

function sanitizeScope(rawScope) {
  if (rawScope != null && (typeof rawScope !== 'object' || Array.isArray(rawScope))) {
    throw new Error('Invalid chat scope.');
  }
  const raw = rawScope || {};
  if (raw.type === undefined && (raw.meetingIds !== undefined || raw.meetingId !== undefined)) {
    throw new Error('Missing chat scope type.');
  }
  const rawType = raw.type === undefined ? 'all' : raw.type;
  if (typeof rawType !== 'string' || !['all', 'selected_meetings', 'single_meeting'].includes(rawType.trim().toLowerCase())) {
    throw new Error('Invalid chat scope type.');
  }
  for (const key of ['dateFrom', 'dateTo']) {
    if (raw[key] != null && (typeof raw[key] !== 'string' || (raw[key].trim() && !sanitizeOptionalIsoDate(raw[key])))) {
      throw new Error('Invalid chat scope date.');
    }
  }
  if (raw.meetingIds != null && (!Array.isArray(raw.meetingIds) || raw.meetingIds.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error('Invalid chat scope meeting IDs.');
  }
  if (raw.meetingId != null && (typeof raw.meetingId !== 'string' || !raw.meetingId.trim())) {
    throw new Error('Invalid chat scope meeting ID.');
  }
  const type = rawType.trim().toLowerCase() === 'all' ? 'all' : 'selected_meetings';
  let meetingIds = [];
  if (type === 'selected_meetings') {
    const candidates = Array.isArray(raw.meetingIds) ? [...raw.meetingIds] : [];
    if (raw.meetingId != null && String(raw.meetingId).trim()) {
      candidates.push(raw.meetingId);
    }
    meetingIds = [
      ...new Set(
        candidates
          .map((item) => String(item == null ? '' : item).trim().slice(0, 120))
          .filter(Boolean),
      ),
    ].slice(0, 200);
  }

  return {
    type,
    meetingIds,
    dateFrom: sanitizeOptionalIsoDate(raw.dateFrom),
    dateTo: sanitizeOptionalIsoDate(raw.dateTo),
  };
}

function sanitizeCitation(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const evidenceId = String(raw.evidenceId || '').trim().slice(0, 16);
  const meetingId = String(raw.meetingId || '').trim().slice(0, 120);
  if (!evidenceId || !meetingId) {
    return null;
  }
  const startSecNum = raw.startSec === null || raw.startSec === undefined || raw.startSec === ''
    ? null
    : Number(raw.startSec);
  const endSecNum = raw.endSec === null || raw.endSec === undefined || raw.endSec === ''
    ? null
    : Number(raw.endSec);

  return {
    evidenceId,
    meetingId,
    meetingTitle: String(raw.meetingTitle || 'Untitled Meeting').slice(0, 160),
    meetingDate: String(raw.meetingDate || '').slice(0, 64),
    startSec: Number.isFinite(startSecNum) && startSecNum >= 0 ? startSecNum : null,
    endSec: Number.isFinite(endSecNum) && endSecNum >= 0 ? endSecNum : null,
    speaker: String(raw.speaker || '').slice(0, 120),
    excerpt: String(raw.excerpt || '').slice(0, 500),
    sourceTranscriptHash: String(raw.sourceTranscriptHash || '').slice(0, 128),
  };
}

function sanitizeMessage(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const role = raw.role === 'assistant' ? 'assistant' : 'user';
  const entry = {
    id: String(raw.id || makeId('msg')).slice(0, 80),
    role,
    content: String(raw.content || ''),
    createdAt: sanitizeOptionalIsoDate(raw.createdAt) || nowIso(),
  };
  if (role === 'assistant') {
    const allowedStatuses = new Set(['answered', 'insufficient_evidence', 'error', 'cancelled']);
    entry.status = allowedStatuses.has(raw.status) ? raw.status : 'answered';
    entry.citations = Array.isArray(raw.citations)
      ? raw.citations.map(sanitizeCitation).filter(Boolean)
      : [];
    entry.searchedMeetingCount = Number.isFinite(Number(raw.searchedMeetingCount))
      ? Math.max(0, Math.floor(Number(raw.searchedMeetingCount)))
      : 0;
    entry.evidenceCount = Number.isFinite(Number(raw.evidenceCount))
      ? Math.max(0, Math.floor(Number(raw.evidenceCount)))
      : 0;
  }
  return entry;
}

function sanitizeSavedScope(scope) {
  try {
    return sanitizeScope(scope);
  } catch (_error) {
    // Preserve old chat history while making an invalid saved scope match nothing.
    return sanitizeScope({ type: 'selected_meetings', meetingIds: [] });
  }
}

function sanitizeThreadRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const id = String(raw.id || '').trim().slice(0, 80);
  if (!id) {
    return null;
  }
  const createdAt = sanitizeOptionalIsoDate(raw.createdAt) || nowIso();
  const updatedAt = sanitizeOptionalIsoDate(raw.updatedAt) || createdAt;
  return {
    id,
    title: sanitizeThreadTitle(raw.title, DEFAULT_THREAD_TITLE),
    createdAt,
    updatedAt,
    scope: sanitizeSavedScope(raw.scope),
    messages: Array.isArray(raw.messages)
      ? raw.messages.map(sanitizeMessage).filter(Boolean)
      : [],
  };
}

function summarizeThread(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const preview = lastMsg
    ? String(lastMsg.content || '').replace(/\s+/g, ' ').trim().slice(0, 110)
    : '';
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    scope: sanitizeScope(thread.scope),
    messageCount: messages.length,
    lastMessagePreview: preview,
  };
}

function sortThreadsNewestFirst(threads) {
  return [...threads].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 */
function createChatThreadStore(deps) {
  const { app, path, fs } = deps;
  let queueTail = Promise.resolve();

  function getChatDir() {
    return path.join(app.getPath('userData'), 'chat');
  }

  function getThreadsPath() {
    return path.join(getChatDir(), 'threads.json');
  }

  function enqueueMutation(action) {
    const run = queueTail.catch(() => {}).then(action);
    queueTail = run.catch(() => {});
    return run;
  }

  async function writeStoreAtomic(payload, beforeCommit = null) {
    const chatDir = getChatDir();
    const targetPath = getThreadsPath();
    await fs.promises.mkdir(chatDir, { recursive: true });
    const tmpPath = path.join(chatDir, `.threads.${process.pid}.${Date.now()}.tmp`);
    const body = JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        threads: payload.threads,
      },
      null,
      2,
    );
    const handle = await fs.promises.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (beforeCommit) {
        beforeCommit();
        // No event-loop turn may interleave invalidation and the commit.
        fs.renameSync(tmpPath, targetPath);
      } else {
        await fs.promises.rename(tmpPath, targetPath);
      }
    } catch (error) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  async function readStoreUnsafe() {
    const targetPath = getThreadsPath();
    let rawText;
    try {
      rawText = await fs.promises.readFile(targetPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, threads: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.threads)) {
        throw new Error('Invalid chat thread store structure.');
      }
    } catch (_error) {
      const backupPath = path.join(getChatDir(), `threads.corrupt.${Date.now()}.json`);
      // Never replace the original unless the corrupt file was safely moved.
      await fs.promises.rename(targetPath, backupPath);
      const empty = { schemaVersion: SCHEMA_VERSION, threads: [] };
      await writeStoreAtomic(empty);
      return empty;
    }
    const threads = parsed.threads.map(sanitizeThreadRecord).filter(Boolean);
    return { schemaVersion: SCHEMA_VERSION, threads };
  }

  function listThreads() {
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      return sortThreadsNewestFirst(store.threads).map(summarizeThread);
    });
  }

  function getThread(threadId) {
    const targetId = String(threadId || '').trim();
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const found = store.threads.find((t) => t.id === targetId);
      if (!found) {
        throw new Error('Chat thread not found.');
      }
      return structuredClone(found);
    });
  }

  function createThread({ title = DEFAULT_THREAD_TITLE, scope = null } = {}) {
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const now = nowIso();
      const thread = {
        id: makeId('thread'),
        title: sanitizeThreadTitle(title, DEFAULT_THREAD_TITLE),
        createdAt: now,
        updatedAt: now,
        scope: sanitizeScope(scope),
        messages: [],
      };
      store.threads.unshift(thread);
      await writeStoreAtomic(store);
      return structuredClone(thread);
    });
  }

  function renameThread(threadId, newTitle) {
    const targetId = String(threadId || '').trim();
    const cleaned = sanitizeThreadTitle(newTitle, '');
    if (!cleaned) {
      return Promise.reject(new Error('Chat thread title cannot be empty.'));
    }
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const thread = store.threads.find((t) => t.id === targetId);
      if (!thread) {
        throw new Error('Chat thread not found.');
      }
      thread.title = cleaned;
      thread.updatedAt = nowIso();
      await writeStoreAtomic(store);
      return structuredClone(thread);
    });
  }

  function deleteThread(threadId) {
    const targetId = String(threadId || '').trim();
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const before = store.threads.length;
      store.threads = store.threads.filter((t) => t.id !== targetId);
      const deleted = store.threads.length < before;
      if (deleted) {
        await writeStoreAtomic(store);
      }
      return { success: true, deleted, threadId: targetId };
    });
  }

  function updateThreadScope(threadId, scope) {
    const targetId = String(threadId || '').trim();
    const sanitized = sanitizeScope(scope);
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const thread = store.threads.find((t) => t.id === targetId);
      if (!thread) {
        throw new Error('Chat thread not found.');
      }
      thread.scope = sanitized;
      thread.updatedAt = nowIso();
      await writeStoreAtomic(store);
      return structuredClone(thread);
    });
  }

  function appendTurn(
    threadId,
    {
      question,
      status = 'answered',
      answerMarkdown,
      citations = [],
      searchedMeetingCount = 0,
      evidenceCount = 0,
      scope = null,
    },
    { beforeCommit = null } = {},
  ) {
    const targetId = String(threadId || '').trim();
    return enqueueMutation(async () => {
      const store = await readStoreUnsafe();
      const thread = store.threads.find((t) => t.id === targetId);
      if (!thread) {
        throw new Error('Chat thread not found.');
      }
      const userTime = nowIso();
      const assistantTime = nowIso();
      const userMessage = sanitizeMessage({
        id: makeId('msg'),
        role: 'user',
        content: String(question || '').trim(),
        createdAt: userTime,
      });
      const assistantMessage = sanitizeMessage({
        id: makeId('msg'),
        role: 'assistant',
        content: String(answerMarkdown || ''),
        createdAt: assistantTime,
        status,
        citations,
        searchedMeetingCount,
        evidenceCount,
      });
      thread.messages.push(userMessage, assistantMessage);
      if (thread.title === DEFAULT_THREAD_TITLE && userMessage.content) {
        thread.title = autoTitleFromQuestion(userMessage.content);
      }
      if (scope && typeof scope === 'object') {
        thread.scope = sanitizeScope(scope);
      }
      thread.updatedAt = assistantTime;
      await writeStoreAtomic(store, beforeCommit);
      return {
        thread: structuredClone(thread),
        userMessage: structuredClone(userMessage),
        assistantMessage: structuredClone(assistantMessage),
      };
    });
  }

  return {
    getChatDir,
    getThreadsPath,
    listThreads,
    getThread,
    createThread,
    renameThread,
    deleteThread,
    updateThreadScope,
    appendTurn,
    sanitizeScope,
  };
}

module.exports = {
  createChatThreadStore,
  DEFAULT_THREAD_TITLE,
  autoTitleFromQuestion,
  sanitizeScope,
};
