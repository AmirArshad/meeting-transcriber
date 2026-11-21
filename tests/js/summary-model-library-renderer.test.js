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

test('replacement dialog uses modal structure, traps keyboard focus, and restores it on cancel', async () => {
  const makeElement = (tag) => ({ tag, children: [], attributes: {}, append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; }, focus() { document.activeElement = this; } });
  const prior = makeElement('button'); prior.isConnected = true;
  const document = { activeElement: prior, body: makeElement('body'), createElement: makeElement };
  const dialogSource = source.slice(source.indexOf('function chooseSummaryReplacement('), source.indexOf('async function refreshChatEligibility('));
  const ctx = vm.createContext({ document, formatBytes: () => '1 GB', Option: function Option(name, value) { this.text = name; this.value = value; } });
  // The dialog only needs the native select's add method in addition to ordinary elements.
  document.createElement = (tag) => { const element = makeElement(tag); if (tag === 'select') element.add = (item) => element.children.push(item); return element; };
  vm.runInContext(dialogSource, ctx);
  const pending = ctx.chooseSummaryReplacement({ modelName: 'First', reclaimableBytes: 1 }, [{ modelName: 'Second', modelId: 'b' }]);
  const overlay = document.body.children[0];
  const dialog = overlay.children[0];
  const [header, body, actions] = dialog.children;
  assert.equal(header.className, 'modal-header');
  assert.equal(header.children[0].tag, 'h2');
  assert.equal(header.children[0].textContent, 'Remove model');
  assert.equal(body.className, 'modal-body');
  const [, field] = body.children;
  assert.equal(field.className, 'ai-addon-field');
  const [label, select] = field.children;
  assert.equal(label.tag, 'label');
  assert.equal(actions.className, 'modal-actions');
  const [cancel, remove] = actions.children;
  assert.equal(cancel.type, 'button');
  assert.equal(remove.type, 'button');
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
  assert.match(html, /id="chat-model-label" class="chat-composer-model-label"/);
  assert.doesNotMatch(html, /id="chat-model-label" class="chat-model-pill"/);
  assert.match(html, /Gemma 4/);
  assert.match(html, /Inkling 2 Mini/);
});

test('available library cards show plain fit badges and button hierarchy without raw enum strings', () => {
  const elements = [];
  const makeElement = (tag) => ({
    tag, className: '', children: [], hidden: false, textContent: '', dataset: {},
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    setAttribute() {}, addEventListener() {},
  });
  const container = makeElement('div');
  const document = {
    createElement: (tag) => { const e = makeElement(tag); elements.push(e); return e; },
    getElementById: (id) => id === 'summary-model-library' ? container : null,
  };
  const ctx = vm.createContext({
    document,
    aiAddonDownloadState: { summary: { active: false } },
    chatState: { modelState: {} },
    formatBytes: (n) => `${n} B`,
    usableSummaryModels: (lib) => (lib?.models || []).filter((m) => m.installed && m.setupComplete && m.status === 'ready'),
  });
  vm.runInContext(source.slice(source.indexOf('function summaryModelHasFiles('), source.indexOf('function chooseSummaryReplacement(')), ctx);
  ctx.renderSummaryModelLibrary({
    defaultModelId: 'a',
    models: [
      { modelId: 'a', modelName: 'Installed Model', installed: true, setupComplete: true, status: 'ready', installedBytes: 10, fit: { status: 'fits' } },
      { modelId: 'b', modelName: 'Available Fit', installed: false, setupComplete: false, status: 'notConfigured', downloadBytes: 20, fit: { status: 'fits' } },
      { modelId: 'c', modelName: 'Gated Model', installed: false, setupComplete: false, status: 'unsupported', downloadBytes: 30, fit: { status: 'unavailable', blocked: true, reason: 'Not available on macOS yet.' } },
    ],
  });
  const texts = elements.map((el) => el.textContent);
  assert.ok(texts.includes('Fits this device'));
  assert.ok(texts.includes('Unavailable'));
  assert.equal(texts.includes('notConfigured'), false);
  assert.equal(texts.includes('unsupported'), false);
  const downloadBtn = elements.find((el) => el.tag === 'button' && el.textContent === 'Download');
  const removeBtn = elements.find((el) => el.tag === 'button' && el.textContent === 'Remove model');
  assert.match(downloadBtn.className, /\bbtn-primary\b/);
  assert.match(removeBtn.className, /\bbtn-danger\b/);
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

test('in-place progress updates preserve Cancel button node, hide legacy summary progress, and display language capabilities', async () => {
  function makeDomElement(tag = 'div') {
    return {
      tag,
      className: '',
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      disabled: false,
      textContent: '',
      classList: { toggle() {}, add() {}, remove() {} },
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child, ref) {
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx === -1) this.children.push(child);
        else this.children.splice(idx, 0, child);
        return child;
      },
      replaceChildren(...items) { this.children = [...items]; },
      remove() { this.removed = true; },
      setAttribute() {},
      addEventListener(type, fn) { this[type] = fn; },
      matchesClass(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1) : sel;
        return this.className.split(/\s+/).includes(cls);
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const child of node.children || []) {
            if (sel === 'button' ? child.tag === 'button' : child.matchesClass?.(sel)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
  }
  const byId = {
    'summary-model-library': makeDomElement('div'),
    'summary-progress': makeDomElement('div'),
    'cancel-summary-btn': makeDomElement('button'),
    'summary-addon-card': makeDomElement('div'),
    'summary-status-badge': makeDomElement('span'),
    'ai-addons-status-badge': makeDomElement('span'),
    'summary-profile-select': makeDomElement('select'),
    'summary-status-text': makeDomElement('p'),
    'setup-summary-btn': makeDomElement('button'),
    'validate-summary-btn': makeDomElement('button'),
    'remove-summary-btn': makeDomElement('button'),
    'summary-footprint': makeDomElement('div'),
  };
  const legacyActions = makeDomElement('div');
  legacyActions.appendChild(byId['setup-summary-btn']);
  byId['setup-summary-btn'].parentElement = legacyActions;

  const library = {
    defaultModelId: 'gemma-4-e4b',
    models: [
      {
        modelId: 'gemma-4-e4b',
        modelName: 'Gemma 4 E4B',
        description: 'Follow-ups.',
        installed: true,
        setupComplete: true,
        status: 'ready',
        languagePolicy: { languages: ['en'], names: { en: 'English' } },
        fit: { status: 'fits' },
      },
      {
        modelId: 'qwen3.5-9b-q4-k-m',
        modelName: 'Qwen3.5 9B',
        description: 'Everyday choice.',
        installed: false,
        setupComplete: false,
        status: 'notConfigured',
        languagePolicy: { languages: ['en', 'es'], names: { en: 'English', es: 'Spanish' } },
        fit: { status: 'fits' },
      },
    ],
  };
  const state = { active: true, terminal: false, cancelling: false, modelId: 'qwen3.5-9b-q4-k-m', percent: 10, message: 'Downloading' };
  const ctx = vm.createContext({
    document: {
      createElement: (tag) => makeDomElement(tag),
      getElementById: (id) => byId[id] || null,
    },
    aiAddonDownloadState: { summary: state, diarization: { active: false } },
    aiAddonStatusSnapshot: { summaryLibrary: library },
    chatState: { modelState: {}, activeThread: null, pendingModelId: null },
    formatBytes: (n) => `${n} B`,
    DEFAULT_SUMMARY_PROFILE: 'balanced',
    isAiAddonSetupLockingControls: ({ progressActive }) => Boolean(progressActive),
    setStatusBadge: (el, status) => { if (el) el.textContent = status; },
    buildAiAddonControlState: () => ({ canConfigure: false }),
    loadSettings: () => ({ summaryProfile: 'balanced' }),
    applyAiAddonButtonState: () => {},
    getSummarySetupButtonLabel: () => 'Enable',
    getAiAddonValidateButtonLabel: () => 'Check',
    getAiAddonRemoveButtonLabel: () => 'Remove',
    getSummarySetupMessage: () => '',
    isAiAddonTerminalStatus: () => false,
    updateSummaryFootprint: () => {},
    updateAiAddonFootprintWarning: () => {},
    updateSummaryGenerationButtons: () => {},
    historyLanguageCaptionMeeting: null,
    openSettingsAtAiAddons: () => {},
    renderChatOnboardingAndComposer: () => {},
    window: { electronAPI: { cancelSummaryModelSetup: async () => {} } },
  });
  vm.runInContext(
    source.slice(source.indexOf('function renderAiAddonProgress('), source.indexOf('const aiAddonProgressHideTimers'))
    + '\n'
    + source.slice(source.indexOf('function summaryLibrary()'), source.indexOf('async function refreshAiAddonSettings(')),
    ctx,
  );
  ctx.renderSummaryModelLibrary(library);
  const cancelBtnBefore = byId['summary-model-library'].querySelector('.summary-library-cancel-btn');
  assert.ok(cancelBtnBefore);
  assert.equal(byId['summary-progress'].hidden, true);
  assert.equal(byId['cancel-summary-btn'].hidden, true);
  assert.equal(legacyActions.hidden, true);
  assert.ok(byId['summary-model-library'].querySelectorAll('.summary-library-model-desc').some((el) => el.textContent.includes('English summaries & Chat')));
  assert.ok(byId['summary-model-library'].querySelectorAll('.summary-library-model-desc').some((el) => el.textContent.includes('Summaries (2 languages) & Chat')));

  ctx.setAiAddonProgressState('summary', { percent: 65, message: 'Downloading weights' });
  const cancelBtnAfter = byId['summary-model-library'].querySelector('.summary-library-cancel-btn');
  assert.equal(cancelBtnAfter, cancelBtnBefore);
  assert.equal(byId['summary-model-library'].querySelector('.progress-text').textContent, 'Downloading weights · 65%');
  assert.equal(byId['summary-progress'].style.display, 'none');

  // When setup finishes and a usable library model is ready, badges and profile select reflect summaryLibrary.
  ctx.setAiAddonProgressState('summary', { active: false, terminal: false });
  ctx.updateAiAddonSettings({
    summaryLibrary: library,
    features: { summary: { status: 'notConfigured' } },
  });
  assert.equal(byId['summary-status-badge'].textContent, 'ready');
  assert.equal(byId['ai-addons-status-badge'].textContent, 'ready');
  assert.equal(byId['summary-profile-select'].disabled, false);
});

test('renderChatModelChoice implements 0/1/2+ usable model UX without duplicate default entries', () => {
  function makeControl(tag) {
    return { tag, hidden: false, disabled: false, textContent: '', value: '', children: [], add(o) { this.children.push(o); }, replaceChildren(...items) { this.children = [...items]; } };
  }
  const els = {
    'chat-model-select': makeControl('select'),
    'chat-model-label': makeControl('span'),
    'chat-manage-models': makeControl('button'),
  };
  let library = { defaultModelId: null, models: [] };
  const ctx = vm.createContext({
    document: { getElementById: (id) => els[id] || null },
    Option: function Option(text, value) { this.text = text; this.value = value; },
    aiAddonStatusSnapshot: null,
    chatState: { activeThread: null, pendingModelId: null, sending: false },
    openSettingsAtAiAddons: () => {},
    renderChatOnboardingAndComposer: () => {},
  });
  vm.runInContext(
    source.slice(source.indexOf('function summaryLibrary()'), source.indexOf('function formatSummaryModelCapabilities('))
    + '\n'
    + source.slice(source.indexOf('function renderChatModelChoice('), source.indexOf('function updateAiAddonSettings(')),
    ctx,
  );

  // 0 usable models
  ctx.aiAddonStatusSnapshot = { summaryLibrary: library };
  ctx.renderChatModelChoice();
  assert.equal(els['chat-model-select'].hidden, true);
  assert.equal(els['chat-model-label'].hidden, true);
  assert.equal(els['chat-manage-models'].hidden, false);
  assert.equal(els['chat-manage-models'].textContent, 'Set up a model');

  // 1 usable model
  library = { defaultModelId: 'a', models: [{ modelId: 'a', modelName: 'Qwen3.5 9B', installed: true, setupComplete: true, status: 'ready' }] };
  ctx.aiAddonStatusSnapshot = { summaryLibrary: library };
  ctx.renderChatModelChoice();
  assert.equal(els['chat-model-select'].hidden, true);
  assert.equal(els['chat-model-label'].hidden, false);
  assert.equal(els['chat-model-label'].textContent, 'Qwen3.5 9B');

  // 2+ usable models: no duplicate default entry
  library = {
    defaultModelId: 'a',
    models: [
      { modelId: 'a', modelName: 'Qwen3.5 9B', installed: true, setupComplete: true, status: 'ready' },
      { modelId: 'b', modelName: 'Gemma 4 E4B', installed: true, setupComplete: true, status: 'ready' },
    ],
  };
  ctx.aiAddonStatusSnapshot = { summaryLibrary: library };
  ctx.renderChatModelChoice();
  assert.equal(els['chat-model-select'].hidden, false);
  assert.equal(els['chat-model-label'].hidden, true);
  assert.deepEqual(els['chat-model-select'].children.map((o) => [o.text, o.value]), [
    ['Qwen3.5 9B · Default', ''],
    ['Gemma 4 E4B', 'b'],
  ]);
});
