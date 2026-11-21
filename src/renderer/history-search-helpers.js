(function initHistorySearchHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tag-helpers').normalizeTag);
    return;
  }

  root.historySearchHelpers = factory(root.tagHelpers.normalizeTag);
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildHistorySearchHelpers(normalizeTag) {
  function toFiniteNonNegativeNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
      return null;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    return num;
  }

  function normalizeHistorySearchQuery(rawQuery) {
    return String(rawQuery || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  function parseTimestampStringToSeconds(value) {
    const raw = String(value || '').trim();
    if (!/^\d{1,3}(?::\d{2}){1,2}(?:\.\d+)?$/.test(raw)) {
      return null;
    }
    const parts = raw.split(':').map((part) => Number(part));
    if (parts.some((num) => !Number.isFinite(num) || num < 0)) {
      return null;
    }
    if (parts.length === 2) {
      return (parts[0] * 60) + parts[1];
    }
    if (parts.length === 3) {
      return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    }
    return null;
  }

  function formatJumpTimestamp(seconds) {
    const num = toFiniteNonNegativeNumber(seconds);
    if (num === null) {
      return '';
    }
    const total = Math.floor(num);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function buildHighlightSegmentsFromParts(parts) {
    if (!Array.isArray(parts)) {
      return [];
    }
    const safe = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const text = String(part.text == null ? '' : part.text);
      if (!text) {
        continue;
      }
      safe.push({
        text,
        match: Boolean(part.match),
      });
    }
    return safe;
  }

  function matchesMeetingTag(meeting, tag) {
    if (!String(tag || '').trim()) {
      return true;
    }
    const canonicalTag = normalizeTag(tag);
    return canonicalTag !== null && normalizeTag(meeting?.tag) === canonicalTag;
  }

  function mergeSearchResultsWithMeetings(meetings, searchResponse, options = {}) {
    const activeTag = options?.tag;
    const byId = new Map();
    for (const meeting of Array.isArray(meetings) ? meetings : []) {
      if (meeting && meeting.id != null) {
        byId.set(String(meeting.id), meeting);
      }
    }

    const hits = Array.isArray(searchResponse && searchResponse.meetings)
      ? searchResponse.meetings
      : [];
    const results = [];
    const seen = new Set();

    for (const hit of hits) {
      if (!hit || hit.meetingId == null) {
        continue;
      }
      const id = String(hit.meetingId);
      if (seen.has(id)) {
        continue;
      }
      const liveMeeting = byId.get(id);
      if (!liveMeeting || !matchesMeetingTag(liveMeeting, activeTag)) {
        continue;
      }
      seen.add(id);
      results.push({
        ...liveMeeting,
        searchMeta: {
          bestPassage: hit.bestPassage || null,
          matches: Array.isArray(hit.matches) ? hit.matches : [],
          score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : 0,
        },
      });
    }

    return results;
  }

  function fallbackFilterMeetingsByTitle(meetings, rawQuery, options = {}) {
    const activeTag = options?.tag;
    const normalized = normalizeHistorySearchQuery(rawQuery).toLowerCase();
    const list = (Array.isArray(meetings) ? meetings : []).filter((m) => matchesMeetingTag(m, activeTag));
    if (!normalized) {
      return list;
    }
    return list.filter((meeting) => String(meeting && meeting.title ? meeting.title : '').toLowerCase().includes(normalized));
  }

  function resolveSegmentBounds(segment) {
    if (!segment || typeof segment !== 'object') {
      return null;
    }
    const explicitStart = toFiniteNonNegativeNumber(segment.startSec);
    const startSec = explicitStart !== null
      ? explicitStart
      : parseTimestampStringToSeconds(segment.start);
    const explicitEnd = toFiniteNonNegativeNumber(segment.endSec);
    let endSec = explicitEnd !== null
      ? explicitEnd
      : parseTimestampStringToSeconds(segment.end);

    if (startSec === null) {
      return null;
    }
    if (endSec === null || endSec < startSec) {
      endSec = startSec;
    }
    return { startSec, endSec };
  }

  function findClosestTranscriptSegmentIndex(segments, targetSec) {
    const target = toFiniteNonNegativeNumber(targetSec);
    if (!Array.isArray(segments) || segments.length === 0 || target === null) {
      return -1;
    }

    let containingIndex = -1;
    let containingSpanDist = Infinity;
    let nearestIndex = -1;
    let nearestDist = Infinity;

    for (let index = 0; index < segments.length; index += 1) {
      const bounds = resolveSegmentBounds(segments[index]);
      if (!bounds) {
        continue;
      }
      if (target >= bounds.startSec && target <= bounds.endSec) {
        const midpoint = (bounds.startSec + bounds.endSec) / 2;
        const dist = Math.abs(target - midpoint);
        if (dist < containingSpanDist) {
          containingSpanDist = dist;
          containingIndex = index;
        }
      }
      const startDist = Math.abs(bounds.startSec - target);
      if (startDist < nearestDist) {
        nearestDist = startDist;
        nearestIndex = index;
      }
    }

    return containingIndex !== -1 ? containingIndex : nearestIndex;
  }

  return {
    buildHighlightSegmentsFromParts,
    fallbackFilterMeetingsByTitle,
    findClosestTranscriptSegmentIndex,
    formatJumpTimestamp,
    mergeSearchResultsWithMeetings,
    normalizeHistorySearchQuery,
    parseTimestampStringToSeconds,
  };
}));
