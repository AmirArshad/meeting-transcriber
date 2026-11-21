const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
const helpers = source.slice(source.indexOf('function summaryLibrary()'), source.indexOf('function renderSummaryModelLibrary('));
const context = vm.createContext({ aiAddonStatusSnapshot: null });
vm.runInContext(helpers, context);

test('model choices include only installed, checked, ready models', () => {
  const library = { defaultModelId: 'a', models: [
    { modelId: 'a', modelName: 'First', installed: true, setupComplete: true, status: 'ready' },
    { modelId: 'b', installed: true, setupComplete: false, status: 'error' },
    { modelId: 'c', installed: false, setupComplete: true, status: 'ready' },
  ] };
  assert.deepEqual(Array.from(context.usableSummaryModels(library), (model) => model.modelId), ['a']);
  assert.equal(context.summaryModelName('a', library), 'First');
  assert.equal(context.summaryModelName('removed', library), 'removed');
  assert.equal(context.usableSummaryModels({ models: [] }).length, 0);
});

test('partial removal stays in managed storage and blocked models cannot be selected', () => {
  assert.equal(context.summaryModelHasFiles({ installed: false, installedBytes: 42 }), true);
  assert.equal(context.summaryModelHasFiles({ installed: false, error: 'Removal is incomplete. Retry removal.' }), true);
  assert.equal(context.summaryModelHasFiles({ installed: false, installedBytes: 0 }), false);
  const library = { models: [{ modelId: 'a', installed: true, setupComplete: true, status: 'ready', fit: { status: 'needs_more_memory', blocked: true } }] };
  assert.equal(context.usableSummaryModels(library).length, 0);
  assert.equal(context.summaryFitLabel('unknown'), 'Couldn’t check memory');
});

test('replacement dialog traps keyboard focus and restores it on cancel', async () => {
  const makeElement = () => ({ children: [], append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, setAttribute() {}, remove() { this.removed = true; }, focus() { document.activeElement = this; } });
  const prior = makeElement(); prior.isConnected = true;
  const document = { activeElement: prior, body: makeElement(), createElement: makeElement };
  const dialogSource = source.slice(source.indexOf('function chooseSummaryReplacement('), source.indexOf('async function refreshChatEligibility('));
  const ctx = vm.createContext({ document, formatBytes: () => '1 GB', Option: function Option(name, value) { this.text = name; this.value = value; } });
  // The dialog only needs the native select's add method in addition to ordinary elements.
  document.createElement = (tag) => { const element = makeElement(); if (tag === 'select') element.add = (item) => element.children.push(item); return element; };
  vm.runInContext(dialogSource, ctx);
  const pending = ctx.chooseSummaryReplacement({ modelName: 'First', reclaimableBytes: 1 }, [{ modelName: 'Second', modelId: 'b' }]);
  const overlay = document.body.children[0];
  const body = overlay.children[0].children[0];
  const [, select, cancel, remove] = body.children;
  assert.equal(document.activeElement, select);
  let prevented = false;
  overlay.onkeydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, remove);
  cancel.onclick();
  assert.equal(await pending, null);
  assert.equal(document.activeElement, prior);
});

test('model controls are present once and summary model precedes language', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
  for (const id of ['summary-model-library', 'summary-model-select', 'chat-model-select', 'chat-manage-models']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.ok(html.indexOf('id="summary-model-select"') < html.indexOf('id="summary-transcript-language"'));
  assert.match(html, /Gemma 4/);
  assert.match(html, /Inkling 2 Mini/);
});


test('advisory memory fit permits selection and confirmation separates download and storage', () => {
  const advisory = { modelId: 'a', modelName: 'A', installed: true, setupComplete: true, status: 'ready', fit: { status: 'needs_more_memory', blocked: false } };
  assert.equal(context.usableSummaryModels({ models: [advisory] }).length, 1);
  assert.equal(context.summaryFitLabel('runtime_needed'), 'Runtime setup needed');
  assert.equal(context.summaryFitLabel('unavailable'), 'Unavailable on this device');
  context.formatBytes = (value) => `${value} bytes`;
  const text = context.summaryDownloadConfirmation({ modelName: 'A', downloadBytes: 10, runtimeDownloadBytes: 5, additionalDownloadBytes: 15, peakFreeBytes: 30 }, { availableBytes: 20 });
  assert.match(text, /Model download: 10 bytes/);
  assert.match(text, /Runtime download: 5 bytes/);
  assert.match(text, /Total additional download: 15 bytes/);
  assert.match(text, /Free another 10 bytes/);
});

test('active setup card shows progress and cancellation only until terminal state', async () => {
  const elements = [];
  const makeElement = (tag) => ({ tag, children: [], hidden: false, textContent: '', appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(type, fn) { this[type] = fn; } });
  const container = makeElement('div');
  const document = { createElement: (tag) => { const e = makeElement(tag); elements.push(e); return e; }, getElementById: (id) => id === 'summary-model-library' ? container : null };
  let cancelled = 0;
  const state = { active: true, terminal: false, cancelling: false, modelId: 'a', percent: 45, message: 'Downloading' };
  const ctx = vm.createContext({ document, aiAddonDownloadState: { summary: state }, chatState: { modelState: {} }, formatBytes: (n) => `${n} bytes`, setAiAddonProgressState: (_feature, patch) => Object.assign(state, patch), window: { electronAPI: { cancelSummaryModelSetup: async () => { cancelled += 1; } } } });
  vm.runInContext(source.slice(source.indexOf('function summaryModelHasFiles('), source.indexOf('function chooseSummaryReplacement(')), ctx);
  const library = { models: [{ modelId: 'a', modelName: 'A', status: 'notConfigured', fit: { status: 'unknown' } }] };
  ctx.renderSummaryModelLibrary(library);
  assert.ok(elements.some((el) => el.textContent === 'Downloading · 45%'));
  const cancel = elements.find((el) => el.textContent === 'Cancel setup');
  assert.ok(cancel);
  await cancel.click();
  assert.equal(cancelled, 1);
  assert.equal(state.cancelling, true);
  elements.length = 0;
  Object.assign(state, { terminal: true, cancelling: false, message: 'Ready' });
  ctx.renderSummaryModelLibrary(library);
  assert.equal(elements.some((el) => el.textContent === 'Cancel setup'), false);
});

test('incomplete removal offers retry and reports remaining bytes', () => {
  const elements = [];
  const makeElement = () => ({ children: [], textContent: '', appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(type, fn) { this[type] = fn; } });
  const container = makeElement();
  const document = { createElement: () => { const e = makeElement(); elements.push(e); return e; }, getElementById: (id) => id === 'summary-model-library' ? container : null };
  const ctx = vm.createContext({ document, aiAddonDownloadState: { summary: { active: false } }, chatState: { modelState: {} }, formatBytes: (n) => `${n} bytes`, usableSummaryModels: () => [] });
  vm.runInContext(source.slice(source.indexOf('function summaryModelHasFiles('), source.indexOf('function chooseSummaryReplacement(')), ctx);
  ctx.renderSummaryModelLibrary({ models: [{ modelId: 'a', modelName: 'A', status: 'error', removalPending: true, residualBytes: 20, fit: { status: 'unknown' } }] });
  assert.ok(elements.some((el) => el.textContent === 'Retry removal'));
  assert.ok(elements.some((el) => el.textContent === '20 bytes remaining after removal'));
});
