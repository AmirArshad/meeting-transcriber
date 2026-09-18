(function initKeyboardShortcutHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.keyboardShortcutHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildKeyboardShortcutHelpers() {
  const ACTIONS = [
    'goto-record',
    'goto-history',
    'goto-settings',
    'start-recording',
    'stop-recording',
  ];

  function isMacPlatform(platform) {
    return platform === 'darwin';
  }

  function getKeyboardShortcutDisplay(action, { platform } = {}) {
    const mac = isMacPlatform(platform);
    const mod = mac ? 'Command' : 'Ctrl';
    switch (action) {
      case 'goto-record':
        return `${mod}+Shift+1`;
      case 'goto-history':
        return `${mod}+Shift+2`;
      case 'goto-settings':
        return `${mod}+Shift+3`;
      case 'start-recording':
        return `${mod}+Shift+R`;
      case 'stop-recording':
        return `${mod}+Shift+S`;
      default:
        return '';
    }
  }

  function getKeyboardShortcutAria(action, { platform } = {}) {
    const mac = isMacPlatform(platform);
    const mod = mac ? 'Meta' : 'Control';
    switch (action) {
      case 'goto-record':
        return `${mod}+Shift+1`;
      case 'goto-history':
        return `${mod}+Shift+2`;
      case 'goto-settings':
        return `${mod}+Shift+3`;
      case 'start-recording':
        return `${mod}+Shift+R`;
      case 'stop-recording':
        return `${mod}+Shift+S`;
      default:
        return '';
    }
  }

  function getKeyboardShortcutBindings({ platform } = {}) {
    return [
      { action: 'goto-record', label: 'Record page', display: getKeyboardShortcutDisplay('goto-record', { platform }) },
      { action: 'goto-history', label: 'History', display: getKeyboardShortcutDisplay('goto-history', { platform }) },
      { action: 'goto-settings', label: 'Settings', display: getKeyboardShortcutDisplay('goto-settings', { platform }) },
      { action: 'start-recording', label: 'Start recording (Mic + Desktop)', display: getKeyboardShortcutDisplay('start-recording', { platform }) },
      { action: 'stop-recording', label: 'Stop and save recording', display: getKeyboardShortcutDisplay('stop-recording', { platform }) },
    ];
  }

  function normalizeShortcutKey(event) {
    if (event && typeof event.code === 'string' && event.code) {
      return event.code;
    }
    const key = event && typeof event.key === 'string' ? event.key : '';
    const lower = key.toLowerCase();
    if (key === '!' || key === '1') {
      return 'Digit1';
    }
    if (key === '@' || key === '2') {
      return 'Digit2';
    }
    if (key === '#' || key === '3') {
      return 'Digit3';
    }
    if (lower === 'r') {
      return 'KeyR';
    }
    if (lower === 's') {
      return 'KeyS';
    }
    return key;
  }

  function hasExactShortcutModifiers(event, { platform } = {}) {
    const mac = isMacPlatform(platform);
    const ctrl = Boolean(event && event.ctrlKey);
    const meta = Boolean(event && event.metaKey);
    const shift = Boolean(event && event.shiftKey);
    const alt = Boolean(event && event.altKey);
    if (!shift || alt) {
      return false;
    }
    if (mac) {
      return meta && !ctrl;
    }
    return ctrl && !meta;
  }

  function isShortcutEventRejected(event) {
    if (!event) {
      return true;
    }
    if (event.defaultPrevented) {
      return true;
    }
    if (event.repeat) {
      return true;
    }
    if (event.isComposing || event.keyCode === 229) {
      return true;
    }
    if (typeof event.getModifierState === 'function') {
      try {
        if (event.getModifierState('AltGraph')) {
          return true;
        }
      } catch (_error) {
        // Ignore modifier probe failures; fall through to key matching.
      }
    }
    if (event.key === 'AltGraph') {
      return true;
    }
    return false;
  }

  function resolveKeyboardShortcutAction(event, { platform } = {}) {
    if (isShortcutEventRejected(event)) {
      return null;
    }
    if (!hasExactShortcutModifiers(event, { platform })) {
      return null;
    }
    const code = normalizeShortcutKey(event);
    switch (code) {
      case 'Digit1':
      case 'Numpad1':
        return 'goto-record';
      case 'Digit2':
      case 'Numpad2':
        return 'goto-history';
      case 'Digit3':
      case 'Numpad3':
        return 'goto-settings';
      case 'KeyR':
        return 'start-recording';
      case 'KeyS':
        return 'stop-recording';
      default:
        return null;
    }
  }

  function isEditableShortcutTarget(target) {
    if (!target || typeof target !== 'object') {
      return false;
    }
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
    if (target.isContentEditable) {
      return true;
    }
    if (typeof target.closest === 'function') {
      try {
        if (target.closest('[contenteditable="true"]')) {
          return true;
        }
      } catch (_error) {
        // Ignore selector probe failures.
      }
    }
    return false;
  }

  function shouldSuppressKeyboardShortcut(event, { isMenuOpen = false, isDialogOpen = false } = {}) {
    if (isMenuOpen || isDialogOpen) {
      return true;
    }
    const target = event && event.target;
    if (isEditableShortcutTarget(target)) {
      return true;
    }
    if (target && typeof target.closest === 'function') {
      try {
        if (target.closest('[role="dialog"], .modal-overlay:not(.hidden), #record-mode-menu:not([hidden])')) {
          return true;
        }
      } catch (_error) {
        // Ignore selector probe failures.
      }
    }
    return false;
  }

  return {
    ACTIONS,
    getKeyboardShortcutAria,
    getKeyboardShortcutBindings,
    getKeyboardShortcutDisplay,
    hasExactShortcutModifiers,
    isEditableShortcutTarget,
    isMacPlatform,
    normalizeShortcutKey,
    resolveKeyboardShortcutAction,
    shouldSuppressKeyboardShortcut,
  };
}));
