'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reusableSummaryLanguage } = require('../../src/renderer/summary-language-helpers');
const { getSummaryLanguagePolicy } = require('../../src/summary-language-policy');
const modelId = 'qwen3.5-9b-q4-k-m';
const policy = getSummaryLanguagePolicy(modelId, 'win32', 'x64');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractTopLevelFunctionSource } = require('./source-scan-helpers');

test('checked language policy retains product languages and rejects replacements and unsupported runtimes', () => {
  assert.deepEqual(policy.languages, ['en', 'es', 'fr', 'de', 'zh', 'ja', 'it', 'pa', 'hi', 'ko', 'pt']);
  assert.equal(policy.languages.includes('fa'), false);
  for (const id of ['unknown', 'qwen3.5-4b-q4-k-m', 'qwen3-14b-q4-k-m']) {
    assert.deepEqual(getSummaryLanguagePolicy(id, 'win32', 'x64').languages, []);
  }
  assert.deepEqual(getSummaryLanguagePolicy(modelId, 'darwin', 'x64').languages, []);
  assert.deepEqual(getSummaryLanguagePolicy(modelId, 'linux', 'x64').languages, policy.languages);
});

test('real composition-root CLI builder propagates language and hash without changing setup validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const context = vm.createContext({ process: { platform: 'win32', arch: 'x64' }, getBackendModuleArgs: (name, args) => ['-m', name, ...args] });
  vm.runInContext(extractTopLevelFunctionSource(source, 'buildSummaryArgs'), context);
  const args = context.buildSummaryArgs({ meetingId: 'id', transcriptPath: 'meeting.md', runtimeDir: 'runtime', modelPath: 'model.gguf', modelId, transcriptLanguage: 'es', sourceTranscriptHash: 'sha256:fixture' });
  assert.equal(args[args.indexOf('--language') + 1], 'es');
  assert.equal(args[args.indexOf('--source-transcript-hash') + 1], 'sha256:fixture');
  assert.equal(args[args.indexOf('--model-id') + 1], modelId);
  const validation = context.buildSummaryArgs({ meetingId: 'setup', runtimeDir: 'runtime', modelPath: 'model.gguf', validateRuntime: true });
  assert.ok(validation.includes('--validate-runtime'));
  assert.equal(validation.includes('--language'), false);
  assert.equal(validation.includes(undefined), false);
});

test('confirmation belongs to unchanged transcript, model and policy; legacy output is unconfirmed', () => {
  const summary = { language: 'es', languageSource: 'userConfirmed', sourceTranscriptHash: 'hash', modelId, languagePolicyVersion: policy.version };
  assert.equal(reusableSummaryLanguage({ ai: { summary } }, 'hash', policy), 'es');
  assert.equal(reusableSummaryLanguage({ ai: { summary } }, 'new-hash', policy), null);
  assert.equal(reusableSummaryLanguage({}, 'hash', policy), null);
  for (const [key, value] of Object.entries({ language: 'fa', languageSource: null, modelId: 'other', languagePolicyVersion: 'old' })) {
    assert.equal(reusableSummaryLanguage({ ai: { summary: { ...summary, [key]: value } } }, 'hash', policy), null);
  }
});

function createDialogHarness() {
  const elements = {};
  const focused = [];
  for (const id of ['summary-language-modal', 'summary-transcript-language', 'summary-language-form', 'summary-language-cancel', 'summary-language-confirm', 'summary-language-message']) {
    const listeners = new Map();
    elements[id] = {
      value: '', disabled: false, children: [], hidden: true,
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
      focus() { focused.push(id); context.document.activeElement = this; },
      classList: { add() { elements[id].hidden = true; }, remove() { elements[id].hidden = false; } },
      addEventListener(event, listener) { listeners.set(event, listener); },
      removeEventListener(event) { listeners.delete(event); },
      dispatch(event, options = {}) { listeners.get(event)?.({ preventDefault() {}, stopPropagation() {}, ...options }); },
      listeners,
    };
  }
  const priorFocus = { isConnected: true, focus() { focused.push('prior'); } };
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id], createElement: () => ({}), activeElement: priorFocus },
    closeSummaryLanguageConfirmation: null,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const dialogSource = source.slice(source.indexOf('function confirmSummaryTranscriptLanguage('), source.indexOf('async function generateSummaryForMeeting('));
  vm.runInContext(dialogSource, context);
  return { context, elements, focused };
}

test('real confirmation dialog prefills meeting language, explains unavailability, and cleans up on cancellation', async () => {
  const { context, elements, focused } = createDialogHarness();
  const pending = context.confirmSummaryTranscriptLanguage({ language: 'es' }, { ...policy, languages: ['en'] });
  assert.equal(elements['summary-transcript-language'].value, 'es');
  assert.equal(elements['summary-language-confirm'].disabled, true);
  assert.match(elements['summary-language-message'].textContent, /not available for Spanish/);
  elements['summary-language-form'].dispatch('submit');
  assert.equal(elements['summary-language-modal'].hidden, false);
  elements['summary-language-modal'].dispatch('keydown', { key: 'Escape' });
  assert.equal(await pending, null);
  assert.equal(elements['summary-language-modal'].hidden, true);
  assert.equal(elements['summary-language-form'].listeners.size, 0);
  assert.equal(context.closeSummaryLanguageConfirmation, null);
  assert.equal(focused.at(-1), 'prior');
});

test('real dialog accepts only explicit supported submission and traps focus', async () => {
  const { context, elements } = createDialogHarness();
  const pending = context.confirmSummaryTranscriptLanguage({ language: 'unknown' }, policy);
  assert.equal(elements['summary-transcript-language'].value, '');
  assert.equal(elements['summary-language-confirm'].disabled, true);
  elements['summary-transcript-language'].value = 'es';
  elements['summary-transcript-language'].dispatch('change');
  assert.match(elements['summary-language-message'].textContent, /Summary will use Spanish/);
  elements['summary-language-confirm'].focus();
  elements['summary-language-modal'].dispatch('keydown', { key: 'Tab' });
  assert.equal(context.document.activeElement, elements['summary-transcript-language']);
  elements['summary-language-form'].dispatch('submit');
  assert.equal(await pending, 'es');
});
