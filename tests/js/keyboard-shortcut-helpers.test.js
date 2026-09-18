'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACTIONS,
  getKeyboardShortcutAria,
  getKeyboardShortcutBindings,
  getKeyboardShortcutDisplay,
  hasExactShortcutModifiers,
  isEditableShortcutTarget,
  normalizeShortcutKey,
  resolveKeyboardShortcutAction,
  shouldSuppressKeyboardShortcut,
} = require('../../src/renderer/keyboard-shortcut-helpers');

function makeEvent(overrides = {}) {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    getModifierState: () => false,
    target: { tagName: 'BODY' },
    ...overrides,
  };
}

test('bindings expose five fixed actions with platform modifiers', () => {
  assert.deepEqual([...ACTIONS].sort(), ['goto-history', 'goto-record', 'goto-settings', 'start-recording', 'stop-recording'].sort());
  assert.equal(getKeyboardShortcutDisplay('goto-record', { platform: 'win32' }), 'Ctrl+Shift+1');
  assert.equal(getKeyboardShortcutDisplay('goto-record', { platform: 'darwin' }), 'Command+Shift+1');
  assert.equal(getKeyboardShortcutDisplay('start-recording', { platform: 'linux' }), 'Ctrl+Shift+R');
  assert.equal(getKeyboardShortcutDisplay('stop-recording', { platform: 'darwin' }), 'Command+Shift+S');
  assert.equal(getKeyboardShortcutAria('start-recording', { platform: 'win32' }), 'Control+Shift+R');
  assert.equal(getKeyboardShortcutAria('stop-recording', { platform: 'linux' }), 'Control+Shift+S');
  assert.equal(getKeyboardShortcutAria('goto-record', { platform: 'darwin' }), 'Meta+Shift+1');
  assert.equal(getKeyboardShortcutAria('start-recording', { platform: 'darwin' }), 'Meta+Shift+R');
  assert.doesNotMatch(getKeyboardShortcutAria('start-recording', { platform: 'win32' }), /Ctrl/);
  assert.doesNotMatch(getKeyboardShortcutAria('start-recording', { platform: 'darwin' }), /Command/);
  const bindings = getKeyboardShortcutBindings({ platform: 'win32' });
  assert.equal(bindings.length, 5);
  for (const binding of bindings) {
    assert.ok(binding.action && binding.label && binding.display);
  }
});

test('command matching requires the exact platform modifier', () => {
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyR', ctrlKey: true, shiftKey: true }), { platform: 'win32' }), 'start-recording');
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyR', metaKey: true, shiftKey: true }), { platform: 'darwin' }), 'start-recording');
  // Wrong modifier for platform.
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyR', metaKey: true, shiftKey: true }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyR', ctrlKey: true, shiftKey: true }), { platform: 'darwin' }), null);
  // Extra modifiers rejected.
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyR', ctrlKey: true, shiftKey: true, altKey: true }), { platform: 'win32' }), null);
  assert.equal(hasExactShortcutModifiers(makeEvent({ ctrlKey: true, shiftKey: true }), { platform: 'win32' }), true);
  assert.equal(hasExactShortcutModifiers(makeEvent({ ctrlKey: true, shiftKey: true, altKey: true }), { platform: 'win32' }), false);
});

test('command matching rejects repeats, composition, handled events, and AltGraph', () => {
  const base = { code: 'KeyR', ctrlKey: true, shiftKey: true };
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, repeat: true }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, isComposing: true }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, keyCode: 229 }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, defaultPrevented: true }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, getModifierState: (name) => name === 'AltGraph' }), { platform: 'win32' }), null);
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ ...base, key: 'AltGraph' }), { platform: 'win32' }), null);
});

test('command matching normalizes case and shifted number rows', () => {
  assert.equal(normalizeShortcutKey({ code: '', key: 'r' }), 'KeyR');
  assert.equal(normalizeShortcutKey({ code: '', key: 'R' }), 'KeyR');
  assert.equal(normalizeShortcutKey({ code: '', key: '!' }), 'Digit1');
  assert.equal(normalizeShortcutKey({ code: 'Digit1', key: '!' }), 'Digit1');
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'Digit1', ctrlKey: true, shiftKey: true, key: '!' }), { platform: 'win32' }), 'goto-record');
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: '', key: '1', ctrlKey: true, shiftKey: true }), { platform: 'win32' }), 'goto-record');
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyS', key: 's', ctrlKey: true, shiftKey: true }), { platform: 'linux' }), 'stop-recording');
  assert.equal(resolveKeyboardShortcutAction(makeEvent({ code: 'KeyS', key: 'S', ctrlKey: true, shiftKey: true }), { platform: 'linux' }), 'stop-recording');
});

test('suppression covers editables, menus, and dialogs', () => {
  assert.equal(isEditableShortcutTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableShortcutTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableShortcutTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableShortcutTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableShortcutTarget({ tagName: 'BODY' }), false);
  assert.equal(shouldSuppressKeyboardShortcut(makeEvent({ target: { tagName: 'INPUT' } })), true);
  assert.equal(shouldSuppressKeyboardShortcut(makeEvent(), { isMenuOpen: true }), true);
  assert.equal(shouldSuppressKeyboardShortcut(makeEvent(), { isDialogOpen: true }), true);
  assert.equal(shouldSuppressKeyboardShortcut(makeEvent({ target: { tagName: 'BODY' } })), false);
});

test('renderer loads keyboard shortcuts before app.js with a unique global', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scriptSrcs.includes('keyboard-shortcut-helpers.js'));
  assert.ok(scriptSrcs.indexOf('keyboard-shortcut-helpers.js') < scriptSrcs.indexOf('app.js'));
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'keyboard-shortcut-helpers.js'), 'utf8');
  assert.match(source, /root\.keyboardShortcutHelpers\s*=/);
});
