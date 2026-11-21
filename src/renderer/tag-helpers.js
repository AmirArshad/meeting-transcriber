(function initTagHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.tagHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildTagHelpers() {
  const RECORDING_TAGS = Object.freeze([
    Object.freeze({
      slug: 'meeting',
      label: 'Meeting',
      shortLabel: 'Meeting',
      tone: 'accent',
      dotColor: '#b8a8c9',
      formatPreview: 'Summary, Topics, Decisions, Action Items, Risks, Open Questions',
    }),
    Object.freeze({
      slug: 'appointment',
      label: 'Appointment',
      shortLabel: 'Appointment',
      tone: 'sky',
      dotColor: '#a8b0c8',
      formatPreview: 'Overview, Key Findings, Advice & Guidance, Next Steps, Prep, Questions',
    }),
    Object.freeze({
      slug: 'call',
      label: 'Phone / Support Call',
      shortLabel: 'Call',
      tone: 'steel',
      dotColor: '#8ba8c4',
      formatPreview: 'Overview, Call Details, Outcomes & Commitments, Next Steps, Unresolved Issues',
    }),
    Object.freeze({
      slug: 'interview',
      label: 'Interview',
      shortLabel: 'Interview',
      tone: 'teal',
      dotColor: '#7cb8b2',
      formatPreview: 'Overview, Background & Themes, Key Q&A, Notable Quotes, Signals, Follow-ups',
    }),
    Object.freeze({
      slug: 'lecture',
      label: 'Lecture / Study',
      shortLabel: 'Lecture',
      tone: 'violet',
      dotColor: '#c3b5db',
      formatPreview: 'Overview, Core Concepts, Examples & Cases, Key Takeaways, Study Questions',
    }),
    Object.freeze({
      slug: 'podcast',
      label: 'Podcast',
      shortLabel: 'Podcast',
      tone: 'plum',
      dotColor: '#c49eb8',
      formatPreview: 'Overview, Chapters & Segments, Key Insights, Notable Quotes, References',
    }),
    Object.freeze({
      slug: 'video',
      label: 'Video',
      shortLabel: 'Video',
      tone: 'indigo',
      dotColor: '#98a6d4',
      formatPreview: 'Overview, Sections, Key Takeaways, Demos / Steps, References',
    }),
    Object.freeze({
      slug: 'voice-note',
      label: 'Voice Note',
      shortLabel: 'Voice Note',
      tone: 'emerald',
      dotColor: '#65ad8a',
      formatPreview: 'Summary, Key Thoughts, Ideas, Reminders & To-Dos, Open Questions',
    }),
    Object.freeze({
      slug: 'brainstorm',
      label: 'Brainstorm',
      shortLabel: 'Brainstorm',
      tone: 'sage',
      dotColor: '#88b498',
      formatPreview: 'Overview, Problem / Goal, Ideas Explored, Standout Concepts, Tradeoffs, Experiments',
    }),
    Object.freeze({
      slug: 'music',
      label: 'Music',
      shortLabel: 'Music',
      tone: 'amber',
      dotColor: '#d2a85c',
      formatPreview: 'Session Overview, Musical Ideas, Lyrics & Themes, Mix & Arrangement, Next Takes',
    }),
    Object.freeze({
      slug: 'other',
      label: 'Other',
      shortLabel: 'Other',
      tone: 'neutral',
      dotColor: '#838b88',
      formatPreview: 'Summary, Key Points, Outcomes & Takeaways, Next Steps, Open Questions',
    }),
  ]);

  const VALID_RECORDING_TAGS = Object.freeze(RECORDING_TAGS.map((entry) => entry.slug));

  const TAG_META_BY_SLUG = Object.freeze(
    Object.fromEntries(RECORDING_TAGS.map((entry) => [entry.slug, entry])),
  );

  const TAG_ALIASES = Object.freeze({
    meeting: 'meeting',
    meetings: 'meeting',
    appointment: 'appointment',
    appointments: 'appointment',
    consultation: 'appointment',
    call: 'call',
    calls: 'call',
    'phone / support call': 'call',
    'phone/support call': 'call',
    'phone call': 'call',
    'support call': 'call',
    'phone-call': 'call',
    'support-call': 'call',
    interview: 'interview',
    interviews: 'interview',
    lecture: 'lecture',
    lectures: 'lecture',
    'lecture / study': 'lecture',
    'lecture/study': 'lecture',
    study: 'lecture',
    class: 'lecture',
    podcast: 'podcast',
    podcasts: 'podcast',
    video: 'video',
    videos: 'video',
    'voice-note': 'voice-note',
    'voice note': 'voice-note',
    voice_note: 'voice-note',
    voicenote: 'voice-note',
    'voice memo': 'voice-note',
    'voice-memo': 'voice-note',
    brainstorm: 'brainstorm',
    brainstorming: 'brainstorm',
    music: 'music',
    rehearsal: 'music',
    other: 'other',
  });

  function normalizeTag(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const collapsed = value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!collapsed) {
      return null;
    }
    if (Object.hasOwn(TAG_ALIASES, collapsed)) {
      return TAG_ALIASES[collapsed];
    }
    const hyphenated = collapsed.replace(/[_\s]+/g, '-');
    if (Object.hasOwn(TAG_ALIASES, hyphenated)) {
      return TAG_ALIASES[hyphenated];
    }
    return null;
  }

  function normalizeTagStrict(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new Error('Unsupported recording tag.');
    }
    if (!value.trim()) {
      return null;
    }
    const normalized = normalizeTag(value);
    if (!normalized) {
      throw new Error('Unsupported recording tag.');
    }
    return normalized;
  }

  function normalizeTagsFilter(rawTags) {
    if (rawTags === null || rawTags === undefined) {
      return [];
    }
    if (!Array.isArray(rawTags)) {
      throw new Error('Invalid recording tags filter.');
    }
    const out = [];
    const seen = new Set();
    for (const item of rawTags) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('Unsupported recording tag.');
      }
      const normalized = normalizeTagStrict(item);
      if (!normalized) {
        throw new Error('Unsupported recording tag.');
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }

  function getTagMeta(value) {
    const slug = normalizeTag(value);
    return slug ? TAG_META_BY_SLUG[slug] || null : null;
  }

  function getUsedRecordingTags(meetings) {
    const used = new Set();
    for (const meeting of Array.isArray(meetings) ? meetings : []) {
      const slug = normalizeTag(meeting && meeting.tag);
      if (slug) {
        used.add(slug);
      }
    }
    return RECORDING_TAGS.filter((entry) => used.has(entry.slug));
  }

  function filterMeetingsByTag(meetings, tag) {
    const list = Array.isArray(meetings) ? meetings : [];
    const normalized = normalizeTag(tag);
    if (!normalized) {
      return list;
    }
    return list.filter((meeting) => normalizeTag(meeting && meeting.tag) === normalized);
  }

  function getSummaryTagMismatch(meeting) {
    if (!meeting || typeof meeting !== 'object') {
      return null;
    }
    const summaryMeta = meeting.ai && meeting.ai.summary;
    const hasCompletedSummary = typeof meeting.summary === 'string'
      ? Boolean(meeting.summary.trim())
      : Boolean(summaryMeta && summaryMeta.status === 'completed');
    if (!hasCompletedSummary) {
      return null;
    }
    const currentTag = normalizeTag(meeting.tag);
    if (!currentTag) {
      return null;
    }
    const metaObj = summaryMeta && typeof summaryMeta === 'object' ? summaryMeta : {};
    const summaryTag = normalizeTag(metaObj.tag) || (metaObj.templateVersion ? 'other' : 'meeting');
    if (summaryTag === currentTag) {
      return null;
    }
    const currentMeta = getTagMeta(currentTag);
    const summaryTagMeta = getTagMeta(summaryTag);
    return {
      currentTag,
      currentLabel: currentMeta ? currentMeta.label : currentTag,
      summaryTag,
      summaryLabel: summaryTagMeta ? summaryTagMeta.label : summaryTag,
    };
  }

  return {
    RECORDING_TAGS,
    VALID_RECORDING_TAGS,
    filterMeetingsByTag,
    getSummaryTagMismatch,
    getTagMeta,
    getUsedRecordingTags,
    normalizeTag,
    normalizeTagStrict,
    normalizeTagsFilter,
  };
}));
