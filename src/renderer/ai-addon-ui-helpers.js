(function initAiAddonUiHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.aiAddonUiHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildAiAddonUiHelpers() {
  function isAiAddonTerminalStatus(status) {
    return status === 'ready'
      || status === 'error'
      || status === 'notConfigured'
      || status === 'needsAccount'
      || status === 'unsupported';
  }

  const SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE = 'This AvaNevis install is incomplete. Reinstall AvaNevis.';

  function isAiAddonProgressPhase(progress) {
    const phase = progress && progress.phase;
    return phase === 'downloading'
      || phase === 'downloading-runtime'
      || phase === 'downloading-dependencies'
      || phase === 'extracting-runtime'
      || phase === 'validating';
  }

  function resolveSelectedDiarizationEngine(diarization, fallback = 'speakrs') {
    const engine = diarization && typeof diarization.engine === 'string'
      ? diarization.engine.trim().toLowerCase()
      : '';
    return engine === 'pyannote' || engine === 'speakrs' ? engine : fallback;
  }

  function shouldShowDiarizationTokenUi(engine) {
    return engine === 'pyannote';
  }

  function shouldShowDiarizationSpeakerCount(engine) {
    return engine === 'pyannote';
  }

  function isSpeakrsRecommended({ platform, arch } = {}) {
    return platform === 'darwin' && arch === 'arm64';
  }

  function getDiarizationEngineCard({ engine, platform, arch } = {}) {
    if (engine === 'speakrs') {
      return {
        engine: 'speakrs',
        title: 'Speakrs',
        subtitle: platform === 'darwin'
          ? 'Faster. No Hugging Face account.'
          : 'No Hugging Face account.',
        recommended: isSpeakrsRecommended({ platform, arch }),
      };
    }
    if (engine === 'pyannote') {
      return {
        engine: 'pyannote',
        title: 'Pyannote',
        subtitle: platform === 'win32'
          ? 'More accurate and faster here. Needs a Hugging Face account.'
          : 'Needs a Hugging Face account.',
        recommended: false,
      };
    }
    return null;
  }

  function buildDiarizationEngineCards({ platform, arch } = {}) {
    return [
      getDiarizationEngineCard({ engine: 'speakrs', platform, arch }),
      getDiarizationEngineCard({ engine: 'pyannote', platform, arch }),
    ];
  }

  function shouldConfirmDiarizationEngineSwitch({
    selectedEngine,
    installedEngine,
    hasOtherEngineLocalState,
  } = {}) {
    return Boolean(
      selectedEngine
      && installedEngine
      && selectedEngine !== installedEngine
      && hasOtherEngineLocalState,
    );
  }

  function getDiarizationSwitchConfirmMessage({ targetEngine, platform } = {}) {
    if (targetEngine === 'speakrs') {
      return 'Switch to Speakrs? This removes the current speaker model, including your saved Hugging Face token and about 2–4 GB of files. Speakrs does not need an account.';
    }
    if (targetEngine === 'pyannote') {
      const base = 'Switch to Pyannote? This removes Speakrs (about 800 MB). Pyannote needs a Hugging Face account and a larger download.';
      return platform === 'win32' ? `${base} On this PC it is more accurate and faster.` : base;
    }
    return '';
  }

  function getDiarizationRemoveConfirmMessage({ engine } = {}) {
    if (engine === 'pyannote') {
      return 'Remove Pyannote speaker identification and the saved Hugging Face token?';
    }
    if (engine === 'speakrs') {
      return 'Remove Speakrs speaker identification?';
    }
    return 'Remove speaker identification setup and stored token?';
  }

  function isSpeakrsPackagedCliMissingMessage(value) {
    const text = String(value || '');
    return /incomplete/i.test(text) && /Reinstall AvaNevis/.test(text);
  }

  function resolveDiarizationSetupSource(buttonId) {
    return buttonId === 'home-setup-diarization-btn' ? 'home' : 'settings';
  }

  function readDiarizationSetupToken({
    engine,
    source,
    homeToken = '',
    settingsToken = '',
  } = {}) {
    if (engine !== 'pyannote') {
      return '';
    }
    const raw = source === 'home' ? homeToken : source === 'settings' ? settingsToken : '';
    return String(raw || '').trim();
  }

  function shouldClearDiarizationTokenFields({ selectedEngine, setupAttemptEnded = false } = {}) {
    return selectedEngine !== 'pyannote' || setupAttemptEnded === true;
  }

  return {
    SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
    buildDiarizationEngineCards,
    getDiarizationEngineCard,
    getDiarizationRemoveConfirmMessage,
    getDiarizationSwitchConfirmMessage,
    isAiAddonProgressPhase,
    isAiAddonTerminalStatus,
    isSpeakrsPackagedCliMissingMessage,
    isSpeakrsRecommended,
    readDiarizationSetupToken,
    resolveDiarizationSetupSource,
    resolveSelectedDiarizationEngine,
    shouldClearDiarizationTokenFields,
    shouldConfirmDiarizationEngineSwitch,
    shouldShowDiarizationSpeakerCount,
    shouldShowDiarizationTokenUi,
  };
}));
