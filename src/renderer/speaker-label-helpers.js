(function initSpeakerLabelHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.speakerLabelHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSpeakerLabelHelpers() {
  const SPEAKER_KEY = /^(?:Speaker (?:[1-9]|[1-9]\d)|SPEAKER_\d{2})$/;

  function isCanonicalSpeakerKey(value) {
    return typeof value === 'string' && SPEAKER_KEY.test(value);
  }

  function normalizeSpeakerName(value) {
    let clean = String(value == null ? '' : value).replace(/[\p{C}\p{Zl}\p{Zp}*]/gu, '');
    while (clean.includes('-->')) clean = clean.replace(/-->/g, '');
    return Array.from(clean.trim()).slice(0, 64).join('').trim();
  }

  function seconds(segment, key) {
    const ms = segment[`${key}Ms`];
    if (ms != null && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms) / 1000;
    const value = segment[`${key}Sec`] != null ? segment[`${key}Sec`] : segment[key];
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;
    const parts = value.trim().split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  function extractSpeakerSamples(segments) {
    const samples = new Map();
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (!segment || !SPEAKER_KEY.test(segment.speaker || '')) continue;
      const speaker = segment.speaker;
      const excerpt = String(segment.text || '').replace(/\s+/g, ' ').trim();
      if (!samples.has(speaker)) samples.set(speaker, { speaker, excerpt: '', startSec: null, endSec: null });
      const sample = samples.get(speaker);
      if (!sample.excerpt && excerpt) {
        sample.excerpt = excerpt;
        sample.startSec = seconds(segment, 'start');
        sample.endSec = seconds(segment, 'end');
      }
    }
    return Array.from(samples.values());
  }

  function applySpeakerNameMapToSegments(segments, names) {
    return (Array.isArray(segments) ? segments : []).map((segment) => {
      if (!segment || typeof segment !== 'object') return segment;
      const name = SPEAKER_KEY.test(segment.speaker || '') && normalizeSpeakerName(names && names[segment.speaker]);
      return name ? { ...segment, speaker: name } : { ...segment };
    });
  }

  function hasUnnamedSpeakers(meeting, samples) {
    const names = meeting && meeting.ai && meeting.ai.diarization && meeting.ai.diarization.speakerNames;
    return (Array.isArray(samples) ? samples : []).some((sample) => sample && SPEAKER_KEY.test(sample.speaker || '') && !normalizeSpeakerName(names && names[sample.speaker]));
  }

  function diffSpeakerNames(previous, edited) {
    const patch = {};
    const before = previous && typeof previous === 'object' ? previous : {};
    const after = edited && typeof edited === 'object' ? edited : {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!SPEAKER_KEY.test(key)) continue;
      const next = normalizeSpeakerName(after[key]);
      if (normalizeSpeakerName(before[key]) !== next) patch[key] = next;
    }
    return patch;
  }

  return { isCanonicalSpeakerKey, extractSpeakerSamples, applySpeakerNameMapToSegments, hasUnnamedSpeakers, normalizeSpeakerName, diffSpeakerNames };
}));
