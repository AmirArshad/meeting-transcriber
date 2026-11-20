(function initChatHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.chatHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildChatHelpers() {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function toStartOfLocalDay(dateObj) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()).getTime();
  }

  function groupThreadsByRecency(threads, now = Date.now()) {
    const buckets = [
      { id: 'today', label: 'Today', threads: [] },
      { id: 'yesterday', label: 'Yesterday', threads: [] },
      { id: 'week', label: 'Previous 7 Days', threads: [] },
      { id: 'older', label: 'Older', threads: [] },
    ];
    const nowDate = now instanceof Date ? now : new Date(now);
    const todayStart = toStartOfLocalDay(nowDate);

    for (const thread of Array.isArray(threads) ? threads : []) {
      if (!thread || !thread.id) {
        continue;
      }
      const parsed = new Date(thread.updatedAt || thread.createdAt || 0);
      if (Number.isNaN(parsed.getTime())) {
        buckets[3].threads.push(thread);
        continue;
      }
      const itemDayStart = toStartOfLocalDay(parsed);
      const dayDiff = Math.floor((todayStart - itemDayStart) / DAY_MS);
      if (dayDiff <= 0) {
        buckets[0].threads.push(thread);
      } else if (dayDiff === 1) {
        buckets[1].threads.push(thread);
      } else if (dayDiff <= 7) {
        buckets[2].threads.push(thread);
      } else {
        buckets[3].threads.push(thread);
      }
    }

    return buckets.filter((bucket) => bucket.threads.length > 0);
  }

  function filterChatThreads(threads, rawQuery) {
    const list = Array.isArray(threads) ? threads : [];
    const query = String(rawQuery || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!query) {
      return list;
    }
    return list.filter((thread) => {
      const title = String(thread?.title || '').toLowerCase();
      const preview = String(thread?.lastMessagePreview || '').toLowerCase();
      return title.includes(query) || preview.includes(query);
    });
  }

  function formatDateWindowSuffix(scope) {
    const from = scope?.dateFrom ? String(scope.dateFrom).slice(0, 10) : '';
    const to = scope?.dateTo ? String(scope.dateTo).slice(0, 10) : '';
    if (from && to) {
      return `${from} – ${to}`;
    }
    if (from) {
      return `From ${from}`;
    }
    if (to) {
      return `Until ${to}`;
    }
    return '';
  }

  function formatChatScopeLabel(scope, meetingsById = null) {
    const normalized = scope && typeof scope === 'object' ? scope : { type: 'all' };
    const dateSuffix = formatDateWindowSuffix(normalized);
    let base = 'All History';
    if (normalized.type === 'selected_meetings' && Array.isArray(normalized.meetingIds)) {
      const ids = normalized.meetingIds.filter(Boolean);
      if (ids.length === 1) {
        const lookup = meetingsById instanceof Map
          ? meetingsById.get(String(ids[0]))
          : (meetingsById && typeof meetingsById === 'object' ? meetingsById[String(ids[0])] : null);
        const title = lookup && lookup.title ? String(lookup.title).trim() : '';
        base = title ? (title.length > 32 ? `${title.slice(0, 31).trimEnd()}…` : title) : '1 meeting';
      } else if (ids.length > 1) {
        base = `${ids.length} meetings`;
      } else {
        base = 'No meetings selected';
      }
    }
    return dateSuffix ? `${base} · ${dateSuffix}` : base;
  }

  function buildModelMemoryPillView(modelState) {
    const status = String(modelState?.status || 'unloaded').trim().toLowerCase();
    const modelName = String(modelState?.modelName || modelState?.modelId || 'Local Model').trim();
    if (status === 'loading') {
      return {
        status: 'loading',
        label: `Loading ${modelName}…`,
        tone: 'loading',
        showUnload: false,
        busy: true,
      };
    }
    if (status === 'loaded') {
      return {
        status: 'loaded',
        label: `Loaded in memory · ${modelName}`,
        tone: 'loaded',
        showUnload: true,
        busy: false,
      };
    }
    if (status === 'unloading') {
      return {
        status: 'unloading',
        label: 'Unloading…',
        tone: 'unloading',
        showUnload: false,
        busy: true,
      };
    }
    return {
      status: 'unloaded',
      label: 'Not loaded',
      tone: 'unloaded',
      showUnload: false,
      busy: false,
    };
  }

  function buildStarterPrompts(meetings, scope = null) {
    const scopedIds = Array.isArray(scope?.meetingIds) ? scope.meetingIds.filter(Boolean) : [];
    const list = Array.isArray(meetings) ? meetings : [];
    if (scope?.type === 'selected_meetings' && scopedIds.length === 1) {
      const target = list.find((m) => String(m?.id) === String(scopedIds[0]));
      const label = target?.title ? `"${target.title.slice(0, 42)}"` : 'this meeting';
      return [
        `What key decisions were made in ${label}?`,
        `List the main action items or owners discussed in ${label}.`,
        `What open questions, blockers, or risks came up in ${label}?`,
      ];
    }
    if (list.length > 0) {
      return [
        'What decisions or commitments were finalized across recent meetings?',
        'Summarize action items and deadlines discussed recently.',
        'Which risks, blockers, or disagreements came up in recent meetings?',
      ];
    }
    return [
      'Record or import a meeting first to ask grounded questions here.',
    ];
  }

  function isCitedMeetingAvailable(citation, meetings) {
    if (!citation || !citation.meetingId) {
      return false;
    }
    const targetId = String(citation.meetingId);
    return (Array.isArray(meetings) ? meetings : []).some((m) => m && String(m.id) === targetId);
  }

  return {
    buildModelMemoryPillView,
    buildStarterPrompts,
    filterChatThreads,
    formatChatScopeLabel,
    groupThreadsByRecency,
    isCitedMeetingAvailable,
  };
}));
