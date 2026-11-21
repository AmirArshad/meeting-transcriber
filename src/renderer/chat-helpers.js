(function initChatHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.chatHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildChatHelpers() {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function toStartOfLocalDay(dateObj) {
    return Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
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
    let base = 'All recordings';
    if (normalized.type === 'selected_meetings' && Array.isArray(normalized.meetingIds)) {
      const ids = normalized.meetingIds.filter(Boolean);
      if (ids.length === 1) {
        const lookup = meetingsById instanceof Map
          ? meetingsById.get(String(ids[0]))
          : (meetingsById && typeof meetingsById === 'object' ? meetingsById[String(ids[0])] : null);
        const title = lookup && lookup.title ? String(lookup.title).trim() : '';
        base = title ? (title.length > 32 ? `${title.slice(0, 31).trimEnd()}…` : title) : '1 recording';
      } else if (ids.length > 1) {
        base = `${ids.length} recordings`;
      } else {
        base = 'No recordings selected';
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
        label: `Loaded · ${modelName}`,
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
      const label = target?.title ? `"${target.title.slice(0, 42)}"` : 'this recording';
      return [
        `Summarize the main points from ${label}.`,
        `What decisions, tasks, or follow-ups came up in ${label}?`,
        `What questions or issues were left open in ${label}?`,
      ];
    }
    if (list.length > 0) {
      return [
        'What key points or decisions came up in my recent recordings?',
        'List any follow-ups, tasks, or deadlines mentioned recently.',
        'What open questions or issues were raised recently?',
      ];
    }
    return [
      'Record or import audio first to ask questions here.',
    ];
  }

  function isCitedMeetingAvailable(citation, meetings) {
    if (!citation || !citation.meetingId) {
      return false;
    }
    const targetId = String(citation.meetingId);
    return (Array.isArray(meetings) ? meetings : []).some((m) => m && String(m.id) === targetId);
  }

  function isScopeFiltered(scope) {
    if (!scope || typeof scope !== 'object') {
      return false;
    }
    if (scope.type === 'selected_meetings') {
      return true;
    }
    if (scope.dateFrom || scope.dateTo) {
      return true;
    }
    if (Array.isArray(scope.tags) && scope.tags.length > 0) {
      return true;
    }
    return false;
  }

  function buildAssistantNoticeView(message, scope = null) {
    const status = String(message?.status || '').trim();
    if (!['no_matching_excerpts', 'insufficient_evidence', 'verification_failed'].includes(status)) {
      return null;
    }

    const searchedCount = Number.isFinite(Number(message?.searchedMeetingCount))
      ? Math.max(0, Math.floor(Number(message.searchedMeetingCount)))
      : 0;
    const evidenceCount = Number.isFinite(Number(message?.evidenceCount))
      ? Math.max(0, Math.floor(Number(message.evidenceCount)))
      : 0;
    const detectedDateFilter = String(message?.detectedDateFilter || '').trim();
    const filtered = isScopeFiltered(scope);
    const hasInspectedSources = Array.isArray(message?.inspectedSources) && message.inspectedSources.length > 0;
    const searchedLabel = `Searched ${searchedCount} recording${searchedCount === 1 ? '' : 's'}`;

    if (status === 'no_matching_excerpts') {
      let title = filtered
        ? 'No matching passages found in the selected recordings.'
        : 'No matching passages found across your recordings.';
      if (searchedCount === 0) {
        title = filtered
          ? 'No indexed recordings match the current filter.'
          : 'No indexed recordings are available yet.';
      } else if (detectedDateFilter) {
        title = filtered
          ? `No transcripts matched "${detectedDateFilter}" in the current filter.`
          : `No recordings matched "${detectedDateFilter}".`;
      }
      const detailParts = [searchedLabel];
      if (detectedDateFilter) {
        detailParts.push(`Date filter parsed: ${detectedDateFilter}`);
      }
      const actions = [];
      if (filtered && scope?.type === 'selected_meetings') {
        actions.push({ id: 'search_all', label: 'Search all recordings' });
      }
      if (filtered && (scope?.dateFrom || scope?.dateTo || (Array.isArray(scope?.tags) && scope.tags.length > 0))) {
        actions.push({ id: 'reset_filters', label: 'Reset filters' });
      }
      if (!filtered) {
        actions.push({ id: 'retry', label: 'Retry' });
      }
      return {
        variant: 'no_matching_excerpts',
        title,
        detail: detailParts.join(' · '),
        actions,
        showInspectedSources: false,
      };
    }

    if (status === 'verification_failed') {
      const actions = [{ id: 'retry', label: 'Retry' }];
      if (filtered) {
        actions.push({ id: 'search_all', label: 'Search all recordings' });
      }
      return {
        variant: 'verification_failed',
        title: 'The local model returned an unverified format.',
        detail: 'Citation checks rejected the output so ungrounded claims are never shown.',
        actions,
        showInspectedSources: hasInspectedSources,
      };
    }

    // insufficient_evidence
    const title = evidenceCount > 0
      ? `Found ${evidenceCount} matching passage${evidenceCount === 1 ? '' : 's'}, but they don't answer that specific question.`
      : (message?.content || 'Not enough matching information in the selected transcripts or summaries to answer that.');
    const detailParts = [];
    if (searchedCount > 0) {
      detailParts.push(searchedLabel);
    }
    if (detectedDateFilter) {
      detailParts.push(`Date filter parsed: ${detectedDateFilter}`);
    }
    const actions = [];
    if (filtered) {
      actions.push({ id: 'search_all', label: 'Search all recordings' });
    }
    actions.push({ id: 'retry', label: 'Retry' });
    return {
      variant: 'insufficient_evidence',
      title,
      detail: detailParts.join(' · '),
      actions,
      showInspectedSources: hasInspectedSources,
    };
  }

  const POST_STREAM_BANNER_PHASES = new Set(['verifying', 'citation-repair', 'json-repair']);

  function shouldShowChatProgressBanner({ sendVisible, streamingDraft, progress } = {}) {
    if (!sendVisible) {
      return false;
    }
    const phase = String(progress?.phase || '').trim().toLowerCase();
    if (POST_STREAM_BANNER_PHASES.has(phase)) {
      return true;
    }
    return !streamingDraft;
  }

  function resolveNoticeActionScope(actionId, currentScope = null) {
    if (actionId === 'search_all') {
      return { type: 'all', meetingIds: [], dateFrom: null, dateTo: null };
    }
    if (actionId === 'reset_filters') {
      const meetingIds = Array.isArray(currentScope?.meetingIds)
        ? currentScope.meetingIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
      const keepSelected = currentScope?.type === 'selected_meetings' && meetingIds.length > 0;
      return {
        type: keepSelected ? 'selected_meetings' : 'all',
        meetingIds: keepSelected ? meetingIds : [],
        dateFrom: null,
        dateTo: null,
      };
    }
    return null;
  }

  return {
    buildAssistantNoticeView,
    buildModelMemoryPillView,
    buildStarterPrompts,
    filterChatThreads,
    formatChatScopeLabel,
    groupThreadsByRecency,
    isCitedMeetingAvailable,
    isScopeFiltered,
    resolveNoticeActionScope,
    shouldShowChatProgressBanner,
  };
}));
