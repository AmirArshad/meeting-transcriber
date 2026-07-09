(function initMeetingHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.meetingHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildMeetingHelpers() {
  function meetingIdsEqual(left, right) {
    if (left == null || right == null) {
      return false;
    }
    return String(left) === String(right);
  }

  return {
    meetingIdsEqual,
  };
}));
