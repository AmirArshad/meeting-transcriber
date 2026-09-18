'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  applyDiarizationEngineCardDomState,
  buildDiarizationEngineCards,
  coerceDiarizationEngineForPlatform,
  getAiAddonRemoveButtonLabel,
  getAiAddonValidateButtonLabel,
  getDiarizationEngineCard,
  getDiarizationRemoveConfirmMessage,
  getDiarizationSetupButtonLabel,
  getDiarizationSwitchConfirmMessage,
  getDiarizationTokenInputPlaceholder,
  getSummarySetupButtonLabel,
  isAiAddonProgressPhase,
  isAiAddonSetupLockingControls,
  isAiAddonTerminalStatus,
  isSpeakrsPackagedCliMissingMessage,
  readDiarizationSetupToken,
  resolveDiarizationSetupSource,
  resolveSelectedDiarizationEngine,
  shouldClearDiarizationTokenFields,
  shouldConfirmDiarizationEngineSwitch,
  shouldShowDiarizationSpeakerCount,
  shouldShowDiarizationTokenUi,
  shouldOfferDiarizationSetupFields,
  shouldUseStaticSpeakrsEngineText,
} = require('../../src/renderer/ai-addon-ui-helpers');

test('unsupported Linux add-on fields hide token and speaker-count UI', () => {
  assert.deepEqual(
    shouldOfferDiarizationSetupFields({ engine: 'pyannote', unsupported: true }),
    { showToken: false, showSpeakerCount: false },
  );
  assert.deepEqual(
    shouldOfferDiarizationSetupFields({ engine: 'pyannote', unsupported: false }),
    { showToken: true, showSpeakerCount: true },
  );
});

test('AI add-on controls are disabled in the initial HTML until status is known', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const controlIds = [
    'ai-addon-cta',
    'generate-summary-btn',
    'regenerate-summary-btn',
    'home-setup-diarization-btn',
    'diarization-token-input',
    'diarization-speaker-count',
    'setup-diarization-btn',
    'validate-diarization-btn',
    'remove-diarization-btn',
    'summary-profile-select',
    'setup-summary-btn',
    'validate-summary-btn',
    'remove-summary-btn',
  ];
  for (const id of controlIds) {
    const openingTag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, 'i'))?.[0] || '';
    assert.match(openingTag, /\sdisabled(?:\s|>|=)/i, `${id} must start disabled`);
  }

  const engineRadios = [...html.matchAll(/<input[^>]+class="diarization-engine-radio"[^>]*>/gi)];
  assert.ok(engineRadios.length > 0);
  for (const [openingTag] of engineRadios) {
    assert.match(openingTag, /\sdisabled(?:\s|>|=)/i);
  }
});

test('isAiAddonTerminalStatus recognizes terminal statuses', () => {
  assert.equal(isAiAddonTerminalStatus('ready'), true);
  assert.equal(isAiAddonTerminalStatus('error'), true);
  assert.equal(isAiAddonTerminalStatus('notConfigured'), true);
  assert.equal(isAiAddonTerminalStatus('needsAccount'), true);
  assert.equal(isAiAddonTerminalStatus('unsupported'), true);
  assert.equal(isAiAddonTerminalStatus('downloading'), false);
  assert.equal(isAiAddonTerminalStatus('validating'), false);
});

test('isAiAddonProgressPhase recognizes active progress phases', () => {
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading-runtime' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading-dependencies' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'extracting' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'extracting-runtime' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'validating' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'idle' }), false);
  assert.equal(isAiAddonProgressPhase(null), false);
});

test('isAiAddonSetupLockingControls ignores leftover progress after Ready', () => {
  assert.equal(isAiAddonSetupLockingControls({ featureStatus: 'downloading' }), true);
  assert.equal(isAiAddonSetupLockingControls({ featureStatus: 'validating' }), true);
  assert.equal(isAiAddonSetupLockingControls({
    featureStatus: 'ready',
    progressActive: true,
  }), false);
  assert.equal(isAiAddonSetupLockingControls({
    featureStatus: 'error',
    progressActive: true,
  }), false);
  assert.equal(isAiAddonSetupLockingControls({
    featureStatus: 'notConfigured',
    progressActive: true,
  }), true);
  assert.equal(isAiAddonSetupLockingControls({
    featureStatus: undefined,
    progressActive: true,
  }), true);
  assert.equal(isAiAddonSetupLockingControls({
    featureStatus: 'ready',
    progressActive: false,
  }), false);
});

test('Speakrs is Recommended only on Apple Silicon and uses selector copy', () => {
  const macSpeakrs = getDiarizationEngineCard({ engine: 'speakrs', platform: 'darwin', arch: 'arm64' });
  const winSpeakrs = getDiarizationEngineCard({ engine: 'speakrs', platform: 'win32', arch: 'x64' });
  const macPyannote = getDiarizationEngineCard({ engine: 'pyannote', platform: 'darwin', arch: 'arm64' });
  const winPyannote = getDiarizationEngineCard({ engine: 'pyannote', platform: 'win32', arch: 'x64' });

  assert.equal(macSpeakrs.title, 'Speakrs');
  assert.equal(macSpeakrs.subtitle, 'Faster. No Hugging Face account.');
  assert.equal(macSpeakrs.recommended, true);
  assert.equal(winSpeakrs.subtitle, 'No Hugging Face account.');
  assert.equal(winSpeakrs.recommended, false);
  assert.equal(macPyannote.title, 'Pyannote');
  assert.equal(macPyannote.subtitle, 'Needs a Hugging Face account.');
  assert.equal(macPyannote.recommended, false);
  assert.equal(winPyannote.subtitle, 'More accurate and faster here. Needs a Hugging Face account.');
  assert.equal(winPyannote.recommended, false);

  const cards = buildDiarizationEngineCards({ platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(cards.map((card) => card.engine), ['speakrs', 'pyannote']);
});

test('Linux exposes Speakrs as its only speaker-identification engine', () => {
  const cards = buildDiarizationEngineCards({ platform: 'linux', arch: 'x64' });

  assert.deepEqual(cards.map((card) => card.engine), ['speakrs']);
});

test('unknown renderer platform stays Speakrs-only until win32/darwin is known', () => {
  assert.deepEqual(buildDiarizationEngineCards({}).map((card) => card.engine), ['speakrs']);
  assert.deepEqual(buildDiarizationEngineCards({ platform: null }).map((card) => card.engine), ['speakrs']);
  assert.equal(coerceDiarizationEngineForPlatform('pyannote', 'linux'), 'speakrs');
  assert.equal(coerceDiarizationEngineForPlatform('pyannote', null), 'speakrs');
  assert.equal(coerceDiarizationEngineForPlatform('pyannote', 'win32'), 'pyannote');
});

test('Linux renderer state hides Pyannote cards and keeps token UI off', () => {
  const homeAndSettings = applyDiarizationEngineCardDomState(
    [{ engine: 'speakrs' }, { engine: 'pyannote' }],
    { selectedEngine: 'pyannote', platform: 'linux', arch: 'x64' },
  );

  assert.deepEqual(homeAndSettings, [
    { engine: 'speakrs', hidden: false, selected: true, radioDisabled: true },
    { engine: 'pyannote', hidden: true, selected: false, radioDisabled: true },
  ]);
  assert.equal(
    shouldShowDiarizationTokenUi(coerceDiarizationEngineForPlatform('pyannote', 'linux')),
    false,
  );
  assert.equal(
    shouldOfferDiarizationSetupFields({
      engine: coerceDiarizationEngineForPlatform('pyannote', 'linux'),
    }).showToken,
    false,
  );
});

test('token and speaker-count UI stay hidden unless pyannote is selected', () => {
  assert.equal(shouldShowDiarizationTokenUi('speakrs'), false);
  assert.equal(shouldShowDiarizationSpeakerCount('speakrs'), false);
  assert.equal(shouldShowDiarizationTokenUi('pyannote'), true);
  assert.equal(shouldShowDiarizationSpeakerCount('pyannote'), true);
  assert.equal(shouldShowDiarizationTokenUi(null), false);
});

test('new users resolve to Speakrs and existing pyannote stays selected', () => {
  assert.equal(resolveSelectedDiarizationEngine(null), 'speakrs');
  assert.equal(resolveSelectedDiarizationEngine({}), 'speakrs');
  assert.equal(resolveSelectedDiarizationEngine({ engine: 'speakrs' }), 'speakrs');
  assert.equal(resolveSelectedDiarizationEngine({ engine: 'pyannote' }), 'pyannote');
});

test('switch confirm copy matches the exclusive selector table', () => {
  assert.equal(
    getDiarizationSwitchConfirmMessage({ targetEngine: 'speakrs', platform: 'win32' }),
    'Switch to Speakrs? This removes the current speaker model (about 2–4 GB). Your saved Hugging Face token is kept so you can switch back to Pyannote without pasting it again. Speakrs does not need an account.',
  );
  assert.equal(
    getDiarizationSwitchConfirmMessage({ targetEngine: 'pyannote', platform: 'win32' }),
    'Switch to Pyannote? This removes Speakrs (about 800 MB). Pyannote needs a Hugging Face account and a larger download. On this PC it is more accurate and faster.',
  );
  assert.equal(
    getDiarizationSwitchConfirmMessage({ targetEngine: 'pyannote', platform: 'darwin' }),
    'Switch to Pyannote? This removes Speakrs (about 800 MB). Pyannote needs a Hugging Face account and a larger download.',
  );
  assert.match(getDiarizationRemoveConfirmMessage({ engine: 'pyannote' }), /Pyannote.*token/i);
  assert.match(getDiarizationRemoveConfirmMessage({ engine: 'speakrs' }), /Disable and remove Speakrs/i);
  assert.doesNotMatch(getDiarizationRemoveConfirmMessage({ engine: 'speakrs' }), /token|hugging face/i);
  assert.doesNotMatch(getDiarizationRemoveConfirmMessage({}), /token/i);
  assert.equal(
    getDiarizationTokenInputPlaceholder(),
    'Leave blank to reuse a saved token, or paste a new one',
  );
});

test('switch confirm is required only when the other engine has local state', () => {
  assert.equal(shouldConfirmDiarizationEngineSwitch({
    selectedEngine: 'speakrs',
    installedEngine: 'pyannote',
    hasOtherEngineLocalState: true,
  }), true);
  assert.equal(shouldConfirmDiarizationEngineSwitch({
    selectedEngine: 'pyannote',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: true,
  }), true);
  assert.equal(shouldConfirmDiarizationEngineSwitch({
    selectedEngine: 'speakrs',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: true,
  }), false);
  assert.equal(shouldConfirmDiarizationEngineSwitch({
    selectedEngine: 'pyannote',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: false,
  }), false);
});

test('packaged missing CLI copy tells the user to reinstall, not re-run setup', () => {
  assert.match(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, /incomplete/i);
  assert.match(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, /Reinstall AvaNevis/);
  assert.doesNotMatch(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, /re-run speaker setup|FileNotFoundError|traceback/i);
  assert.equal(isSpeakrsPackagedCliMissingMessage(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE), true);
  assert.equal(isSpeakrsPackagedCliMissingMessage('Speakrs CLI is not available.'), false);
});

test('engine selector markup uses native radios in a radiogroup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /name="home-diarization-engine"/);
  assert.match(html, /name="settings-diarization-engine"/);
  assert.match(html, /type="radio"[^>]*value="speakrs"|value="speakrs"[^>]*type="radio"/);
  assert.match(html, /type="radio"[^>]*value="pyannote"|value="pyannote"[^>]*type="radio"/);
  assert.match(html, /class="diarization-engine-radio"/);
  assert.doesNotMatch(html, /<button[^>]*class="diarization-engine-card"/);
});

test('setup reads only the initiating surface token and never sends Speakrs a token', () => {
  assert.equal(resolveDiarizationSetupSource('home-setup-diarization-btn'), 'home');
  assert.equal(resolveDiarizationSetupSource('setup-diarization-btn'), 'settings');
  assert.equal(readDiarizationSetupToken({
    engine: 'pyannote',
    source: 'settings',
    homeToken: 'hf_home_token_value',
    settingsToken: 'hf_settings_token_value',
  }), 'hf_settings_token_value');
  assert.equal(readDiarizationSetupToken({
    engine: 'pyannote',
    source: 'home',
    homeToken: 'hf_home_token_value',
    settingsToken: 'hf_settings_token_value',
  }), 'hf_home_token_value');
  assert.equal(readDiarizationSetupToken({
    engine: 'speakrs',
    source: 'home',
    homeToken: 'hf_home_token_value',
    settingsToken: 'hf_settings_token_value',
  }), '');
  assert.equal(shouldClearDiarizationTokenFields({ selectedEngine: 'speakrs' }), true);
  assert.equal(shouldClearDiarizationTokenFields({ selectedEngine: 'pyannote' }), false);
  assert.equal(shouldClearDiarizationTokenFields({ selectedEngine: 'pyannote', setupAttemptEnded: true }), true);
});

test('setup button reads Switch model only when the other engine is installed', () => {
  assert.equal(getDiarizationSetupButtonLabel({
    selectedEngine: 'pyannote',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: true,
  }), 'Switch to Pyannote');
  assert.equal(getDiarizationSetupButtonLabel({
    selectedEngine: 'speakrs',
    installedEngine: 'pyannote',
    hasOtherEngineLocalState: true,
  }), 'Switch to Speakrs');
  assert.equal(getDiarizationSetupButtonLabel({
    selectedEngine: 'speakrs',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: true,
  }), 'Enable speaker identification');
  assert.equal(getDiarizationSetupButtonLabel({
    selectedEngine: 'pyannote',
    installedEngine: 'speakrs',
    hasOtherEngineLocalState: false,
  }), 'Enable speaker identification');
  assert.equal(getSummarySetupButtonLabel(), 'Enable summaries');
  assert.equal(getAiAddonValidateButtonLabel(), 'Check setup');
  assert.equal(getAiAddonRemoveButtonLabel(), 'Disable and remove…');
});

test('hidden AI add-on fields beat display:flex so Speakrs hides token and speaker-count', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.ai-addon-field\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.ai-addon-field\[hidden\]\s*\{[^}]*display:\s*none/);
});

test('hidden diarization engine cards beat display:flex so Linux can hide Pyannote', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.diarization-engine-card\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.diarization-engine-card\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.diarization-engine-selector\.is-single-engine\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('renderer applies Linux Speakrs-only card state instead of leaving static Pyannote HTML visible', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(appJs, /applyDiarizationEngineCardDomState/);
  assert.match(appJs, /coerceDiarizationEngineForPlatform/);
  assert.match(appJs, /is-single-engine/);
});

test('Settings and Home apply Switch engine and restore engine radios from control state', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(appJs, /getDiarizationSetupButtonLabel/);
  assert.match(appJs, /getSummarySetupButtonLabel/);
  assert.match(appJs, /getAiAddonValidateButtonLabel/);
  assert.match(appJs, /getAiAddonRemoveButtonLabel/);
  assert.match(appJs, /canSelectEngine/);
  assert.match(appJs, /radio\.disabled\s*=\s*!.*canSelectEngine/);
  assert.match(appJs, /isAiAddonSetupLockingControls/);
  assert.match(appJs, /setupActive:\s*diarizationSetupLocking/);
  assert.doesNotMatch(appJs, /setupActive:\s*aiAddonDownloadState\.diarization\.active/);
  assert.match(appJs, /getDiarizationTokenInputPlaceholder/);
});

test('single-engine platforms use static Speakrs text with no radio tab stop', () => {
  assert.equal(shouldUseStaticSpeakrsEngineText({ platform: 'linux' }), true);
  assert.equal(shouldUseStaticSpeakrsEngineText({ platform: null }), true);
  assert.equal(shouldUseStaticSpeakrsEngineText({}), true);
  assert.equal(shouldUseStaticSpeakrsEngineText({ platform: 'win32' }), false);
  assert.equal(shouldUseStaticSpeakrsEngineText({ platform: 'darwin' }), false);

  const winCards = applyDiarizationEngineCardDomState(
    [{ engine: 'speakrs' }, { engine: 'pyannote' }],
    { selectedEngine: 'speakrs', platform: 'win32', arch: 'x64' },
  );
  assert.equal(winCards[0].radioDisabled, false);
  assert.equal(winCards[1].radioDisabled, false);
});

test('Settings and Home include static Speakrs text for single-engine platforms', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8');
  const statics = [...html.matchAll(/data-speakrs-static[^>]*>/gi)];
  assert.ok(statics.length >= 2);
  for (const [openingTag] of statics) {
    assert.match(openingTag, /\shidden(?:\s|>|=)/i);
  }
  assert.match(html, /Engine:\s*Speakrs/);
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(appJs, /shouldUseStaticSpeakrsEngineText/);
  assert.match(appJs, /data-speakrs-static/);
});
