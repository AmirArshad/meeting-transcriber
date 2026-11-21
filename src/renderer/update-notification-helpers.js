(function attachUpdateNotificationHelpers(root) {
  const TRUSTED_GITHUB_REPO_PATH_PREFIX = '/AmirArshad/meeting-transcriber';
  const RAIL_UPDATE_RING_RADIUS = 15;
  const RAIL_UPDATE_RING_CIRCUMFERENCE = 2 * Math.PI * RAIL_UPDATE_RING_RADIUS;

  function hasUnsafeUpdateUrlPath(rawUrl, parsedUrl) {
    const str = String(rawUrl || '').trim();
    const schemeMatch = str.match(/^https:\/\/[^/?#]+(\/[^?#]*)?/i);
    const rawPath = (schemeMatch && schemeMatch[1]) ? schemeMatch[1] : '';
    const pathname = String((parsedUrl && parsedUrl.pathname) || '');

    if (/%2f|%5c|\\/i.test(rawPath) || /%2f|%5c|\\/i.test(pathname)) {
      return true;
    }

    let decodedRawPath;
    let decodedPathname;
    try {
      decodedRawPath = decodeURIComponent(rawPath);
      decodedPathname = decodeURIComponent(pathname);
    } catch (_error) {
      return true;
    }

    if (
      decodedRawPath.includes('\\')
      || decodedRawPath.includes('\0')
      || decodedPathname.includes('\\')
      || decodedPathname.includes('\0')
    ) {
      return true;
    }

    if (decodedRawPath.split('/').some((seg) => seg === '.' || seg === '..')) {
      return true;
    }

    return decodedPathname.split('/').some((seg) => seg === '.' || seg === '..');
  }

  function isTrustedUpdateDownloadUrl(url) {
    try {
      const parsedUrl = new URL(String(url || ''));
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
        return false;
      }
      if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
        return false;
      }
      if (hasUnsafeUpdateUrlPath(url, parsedUrl)) {
        return false;
      }

      return parsedUrl.pathname === TRUSTED_GITHUB_REPO_PATH_PREFIX
        || parsedUrl.pathname.startsWith(`${TRUSTED_GITHUB_REPO_PATH_PREFIX}/`);
    } catch (_error) {
      return false;
    }
  }

  function shouldAcceptUpdateState(currentSeq, nextState) {
    if (!nextState || typeof nextState !== 'object') {
      return false;
    }
    const nextSeq = Number(nextState.seq);
    if (!Number.isFinite(nextSeq)) {
      return false;
    }
    const prevSeq = Number.isFinite(Number(currentSeq)) ? Number(currentSeq) : -1;
    return nextSeq > prevSeq;
  }

  function formatVersionTag(version) {
    const raw = String(version || '').trim();
    if (!raw) {
      return '';
    }
    return raw.startsWith('v') || raw.startsWith('V') ? `v${raw.slice(1)}` : `v${raw}`;
  }

  function formatUpdateBytes(bytes) {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) {
      return '0 B';
    }
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    if (num < KB) {
      return `${Math.round(num)} B`;
    }
    if (num < MB) {
      return `${Math.round(num / KB)} KB`;
    }
    if (num < GB) {
      return `${(num / MB).toFixed(1)} MB`;
    }
    return `${(num / GB).toFixed(1)} GB`;
  }

  function formatUpdateSpeed(bytesPerSecond) {
    const num = Number(bytesPerSecond);
    if (!Number.isFinite(num) || num <= 0) {
      return '';
    }
    return `${formatUpdateBytes(num)}/s`;
  }

  function formatUpdateLastChecked(isoString, nowMs = Date.now()) {
    if (!isoString) {
      return 'Never';
    }
    const parsedMs = Date.parse(String(isoString));
    if (!Number.isFinite(parsedMs)) {
      return 'Never';
    }
    const baseNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const diffSec = Math.max(0, Math.floor((baseNow - parsedMs) / 1000));
    if (diffSec < 60) {
      return 'Just now';
    }
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) {
      return `${diffMin}m ago`;
    }
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  function formatUpdateModeLabel(mode, manualPackageKind = null) {
    if (mode === 'dev-unpackaged') {
      return 'Development build';
    }
    if (mode === 'manual-package') {
      if (manualPackageKind === 'dmg') {
        return 'Manual download (DMG)';
      }
      if (manualPackageKind === 'pacman') {
        return 'System package (pacman)';
      }
      if (manualPackageKind === 'deb') {
        return 'System package (deb)';
      }
      if (manualPackageKind === 'appimage') {
        return 'System package (AppImage)';
      }
      return 'System package';
    }
    return 'Automatic in-app';
  }

  function getManualPackageDownloadLabel(manualPackageKind, installerName = null) {
    if (manualPackageKind === 'dmg') {
      return 'Download .dmg';
    }
    if (manualPackageKind === 'pacman') {
      return 'Download .pkg.tar.zst';
    }
    if (manualPackageKind === 'deb') {
      return 'Download .deb';
    }
    if (manualPackageKind === 'appimage') {
      return 'Download .AppImage';
    }
    const name = String(installerName || '').trim();
    if (name.endsWith('.dmg')) {
      return 'Download .dmg';
    }
    if (name.endsWith('.pkg.tar.zst')) {
      return 'Download .pkg.tar.zst';
    }
    if (name.endsWith('.deb')) {
      return 'Download .deb';
    }
    return 'Download package';
  }

  function shouldAutoSurfaceUpdatePopover(prevState, nextState, options = {}) {
    const { isRecordingActive = false } = options;
    if (isRecordingActive) {
      return false;
    }
    if (!nextState || typeof nextState !== 'object') {
      return false;
    }
    if (nextState.manualCheck !== true) {
      return false;
    }
    const prevStatus = prevState && typeof prevState === 'object' ? prevState.status : null;
    const prevManualCheck = Boolean(prevState && typeof prevState === 'object' && prevState.manualCheck === true);
    if (nextState.status === 'downloading') {
      return !prevManualCheck;
    }
    const surfaceableStatuses = new Set([
      'available',
      'ready-to-install',
      'manual-required',
      'up-to-date',
      'error',
    ]);
    if (!surfaceableStatuses.has(nextState.status)) {
      return false;
    }
    return prevStatus !== nextState.status || !prevManualCheck;
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
      return 0;
    }
    if (num >= 100) {
      return 100;
    }
    return num;
  }

  function buildUpdateViewModel(rawState, options = {}) {
    const state = rawState && typeof rawState === 'object' ? rawState : {};
    const status = String(state.status || 'idle');
    const mode = String(state.mode || 'in-app');
    const currentVersion = String(state.currentVersion || '').trim();
    const availableVersion = state.availableVersion ? String(state.availableVersion).trim() : null;
    const manualPackageKind = state.manualPackageKind || null;
    const manualInstallCommand = state.manualInstallCommand ? String(state.manualInstallCommand).trim() : null;
    const manualCheck = Boolean(state.manualCheck);
    const isRecordingActive = Boolean(options.isRecordingActive);
    const dismissedVersion = options.dismissedVersion ? String(options.dismissedVersion).trim() : null;
    const aiConfirmPending = Boolean(options.aiConfirmPending);
    const nowMs = options.nowMs !== undefined ? options.nowMs : Date.now();

    const currentTag = formatVersionTag(currentVersion);
    const availableTag = formatVersionTag(availableVersion);
    const versionDelta = currentTag && availableTag && currentTag !== availableTag
      ? `${currentTag} → ${availableTag}`
      : (availableTag || currentTag || '');

    const rawProgress = state.progress && typeof state.progress === 'object' ? state.progress : null;
    const percent = clampPercent(rawProgress ? rawProgress.percent : 0);
    const roundedPercent = Math.round(percent);
    const transferred = rawProgress ? Number(rawProgress.transferred || 0) : 0;
    const total = rawProgress ? Number(rawProgress.total || 0) : 0;
    const speedText = rawProgress ? formatUpdateSpeed(rawProgress.bytesPerSecond) : '';
    const transferredText = total > 0
      ? `${formatUpdateBytes(transferred)} / ${formatUpdateBytes(total)}`
      : (transferred > 0 ? formatUpdateBytes(transferred) : '');
    const ringDashOffset = Number((RAIL_UPDATE_RING_CIRCUMFERENCE * (1 - (percent / 100))).toFixed(2));

    const isDismissedForCurrentAvailable = Boolean(
      dismissedVersion
      && availableVersion
      && dismissedVersion === availableVersion
      && !manualCheck,
    );

    const railVisible = (
      status === 'available'
      || status === 'downloading'
      || status === 'ready-to-install'
      || status === 'installing'
      || status === 'manual-required'
      || status === 'error'
      || (status === 'checking' && manualCheck)
    );

    let railTone = 'lilac';
    let railIconKind = 'arrow-up';
    let railTooltip = 'Updates';
    let railShowDot = false;
    let railShowRing = false;

    switch (status) {
      case 'checking':
        railTone = 'lilac';
        railIconKind = 'spinner';
        railTooltip = 'Checking for updates…';
        railShowDot = false;
        break;
      case 'available':
        railTone = 'lilac';
        railIconKind = 'arrow-up';
        railTooltip = availableTag ? `Update ${availableTag} available` : 'Update available';
        railShowDot = !isDismissedForCurrentAvailable;
        break;
      case 'downloading':
        railTone = 'lilac';
        railIconKind = 'arrow-up';
        railTooltip = `Downloading ${roundedPercent}%`;
        railShowRing = true;
        railShowDot = false;
        break;
      case 'ready-to-install':
        railTone = 'emerald';
        railIconKind = 'check-restart';
        railTooltip = 'Restart to update';
        railShowDot = true;
        break;
      case 'installing':
        railTone = 'emerald';
        railIconKind = 'spinner';
        railTooltip = 'Restarting to update…';
        railShowDot = false;
        break;
      case 'manual-required':
        railTone = 'lilac';
        railIconKind = 'arrow-up';
        railTooltip = availableTag
          ? `Update ${availableTag} available`
          : (manualPackageKind === 'dmg' ? 'Manual update' : 'Manual package update');
        railShowDot = !isDismissedForCurrentAvailable;
        break;
      case 'error':
        railTone = 'crimson';
        railIconKind = 'alert';
        railTooltip = 'Update check failed';
        railShowDot = true;
        break;
      default:
        railTone = 'neutral';
        railIconKind = 'arrow-up';
        railTooltip = 'Up to date';
        railShowDot = false;
        break;
    }

    let popoverTone = 'neutral';
    let popoverChipLabel = 'Updates';
    let popoverTitle = 'Up to date';
    let primaryAction = { visible: false, action: null, label: '', disabled: false, variant: 'primary' };
    let secondaryAction = { visible: false, action: null, label: '', disabled: false };
    let tertiaryAction = { visible: false, action: null, label: '' };

    switch (status) {
      case 'checking':
        popoverTone = 'lilac';
        popoverChipLabel = 'Checking';
        popoverTitle = 'Checking for updates';
        primaryAction = { visible: true, action: null, label: 'Checking…', disabled: true, variant: 'secondary' };
        break;
      case 'available':
        popoverTone = 'lilac';
        popoverChipLabel = 'Update available';
        popoverTitle = 'Update available';
        primaryAction = { visible: true, action: 'download', label: 'Download update', disabled: false, variant: 'primary' };
        secondaryAction = { visible: true, action: 'github', label: 'GitHub', disabled: false };
        tertiaryAction = { visible: true, action: 'later', label: 'Later' };
        break;
      case 'downloading':
        popoverTone = 'lilac';
        popoverChipLabel = 'Downloading';
        popoverTitle = 'Downloading update';
        secondaryAction = { visible: true, action: 'cancel', label: 'Cancel download', disabled: false };
        break;
      case 'ready-to-install':
        popoverTone = 'emerald';
        popoverChipLabel = 'Ready';
        popoverTitle = 'Ready to restart';
        primaryAction = {
          visible: true,
          action: 'install',
          label: 'Restart to update',
          disabled: isRecordingActive,
          variant: 'ready',
        };
        secondaryAction = { visible: true, action: 'later', label: 'Later', disabled: false };
        break;
      case 'installing':
        popoverTone = 'emerald';
        popoverChipLabel = 'Installing';
        popoverTitle = 'Restarting to update';
        primaryAction = { visible: true, action: null, label: 'Restarting…', disabled: true, variant: 'ready' };
        break;
      case 'manual-required':
        popoverTone = 'amber';
        popoverChipLabel = 'Manual update';
        popoverTitle = manualPackageKind === 'dmg' ? 'Update available' : 'Manual package update';
        primaryAction = {
          visible: true,
          action: 'download',
          label: getManualPackageDownloadLabel(manualPackageKind, state.installerName),
          disabled: false,
          variant: 'primary',
        };
        secondaryAction = { visible: true, action: 'github', label: 'GitHub', disabled: false };
        tertiaryAction = { visible: true, action: 'later', label: 'Later' };
        break;
      case 'error':
        popoverTone = 'crimson';
        popoverChipLabel = 'Error';
        popoverTitle = 'Update check failed';
        primaryAction = { visible: true, action: 'retry', label: 'Retry', disabled: false, variant: 'primary' };
        secondaryAction = { visible: true, action: 'github', label: 'GitHub', disabled: false };
        break;
      case 'up-to-date':
      default:
        popoverTone = 'emerald';
        popoverChipLabel = 'Current';
        popoverTitle = 'Up to date';
        primaryAction = {
          visible: true,
          action: 'check',
          label: 'Check for updates',
          disabled: mode === 'dev-unpackaged',
          variant: 'secondary',
        };
        break;
    }

    const hasReleaseNotes = Boolean(state.releaseNotes && String(state.releaseNotes).trim());
    const showRecordingNotice = status === 'ready-to-install' && isRecordingActive;
    const showAiConfirm = status === 'ready-to-install' && aiConfirmPending && !isRecordingActive;
    const showManualPackage = mode === 'manual-package'
      && Boolean(manualInstallCommand)
      && (status === 'manual-required' || status === 'available');
    const errorMessage = (state.error && state.error.message)
      ? String(state.error.message)
      : 'Could not check for updates.';

    let settingsBadgeText = 'Up to date';
    let settingsBadgeTone = 'enabled';
    let settingsPrimaryAction = {
      action: 'check',
      label: 'Check for updates',
      disabled: mode === 'dev-unpackaged',
      variant: 'primary',
    };

    switch (status) {
      case 'idle':
        settingsBadgeText = state.lastCheckedAt ? 'Up to date' : 'Not checked';
        settingsBadgeTone = state.lastCheckedAt ? 'enabled' : 'disabled';
        settingsPrimaryAction = {
          action: 'check',
          label: 'Check for updates',
          disabled: mode === 'dev-unpackaged',
          variant: 'primary',
        };
        break;
      case 'checking':
        settingsBadgeText = 'Checking…';
        settingsBadgeTone = 'installing';
        settingsPrimaryAction = {
          action: null,
          label: 'Checking…',
          disabled: true,
          variant: 'secondary',
        };
        break;
      case 'up-to-date':
        settingsBadgeText = 'Up to date';
        settingsBadgeTone = 'enabled';
        settingsPrimaryAction = {
          action: 'check',
          label: 'Check for updates',
          disabled: mode === 'dev-unpackaged',
          variant: 'primary',
        };
        break;
      case 'available':
        settingsBadgeText = availableTag ? `${availableTag} available` : 'Update available';
        settingsBadgeTone = 'installing';
        settingsPrimaryAction = {
          action: 'download',
          label: 'Download update',
          disabled: false,
          variant: 'primary',
        };
        break;
      case 'downloading':
        settingsBadgeText = `Downloading ${roundedPercent}%`;
        settingsBadgeTone = 'installing';
        settingsPrimaryAction = {
          action: 'cancel',
          label: 'Cancel download',
          disabled: false,
          variant: 'secondary',
        };
        break;
      case 'ready-to-install':
        settingsBadgeText = 'Ready to restart';
        settingsBadgeTone = 'enabled';
        settingsPrimaryAction = {
          action: 'install',
          label: 'Restart to update',
          disabled: isRecordingActive,
          variant: 'ready',
        };
        break;
      case 'installing':
        settingsBadgeText = 'Restarting…';
        settingsBadgeTone = 'installing';
        settingsPrimaryAction = {
          action: null,
          label: 'Restarting…',
          disabled: true,
          variant: 'ready',
        };
        break;
      case 'manual-required':
        settingsBadgeText = availableTag ? `${availableTag} manual` : 'Manual update';
        settingsBadgeTone = 'disabled';
        settingsPrimaryAction = {
          action: 'download',
          label: getManualPackageDownloadLabel(manualPackageKind, state.installerName),
          disabled: false,
          variant: 'primary',
        };
        break;
      case 'error':
        settingsBadgeText = 'Error';
        settingsBadgeTone = 'disabled';
        settingsPrimaryAction = {
          action: 'check',
          label: 'Retry check',
          disabled: mode === 'dev-unpackaged',
          variant: 'primary',
        };
        break;
      default:
        break;
    }

    const autoDownloadSupported = mode === 'in-app';
    let autoDownloadHint = 'When off, AvaNevis checks for new releases and waits for you to start the download.';
    if (mode === 'manual-package') {
      autoDownloadHint = manualPackageKind === 'dmg'
        ? 'Automatic in-app macOS updates require Developer ID signing. Download the latest .dmg from GitHub Releases to update.'
        : 'Unavailable for system package installs. Updates are installed through your package manager.';
    } else if (mode === 'dev-unpackaged') {
      autoDownloadHint = 'Unavailable in development builds.';
    }

    return {
      status,
      mode,
      currentVersion,
      availableVersion,
      versionDelta,
      progress: {
        visible: status === 'downloading',
        percent,
        percentText: `${roundedPercent}%`,
        transferredText,
        speedText,
        ringDashArray: Number(RAIL_UPDATE_RING_CIRCUMFERENCE.toFixed(2)),
        ringDashOffset,
      },
      rail: {
        visible: railVisible,
        showDot: railShowDot,
        showRing: railShowRing,
        tone: railTone,
        iconKind: railIconKind,
        tooltip: railTooltip,
        ariaLabel: railTooltip,
      },
      popover: {
        tone: popoverTone,
        chipLabel: popoverChipLabel,
        title: popoverTitle,
        versionDelta,
        hasReleaseNotes,
        showProgress: status === 'downloading',
        showRecordingNotice,
        recordingNoticeText: 'Recording in progress — restart once recording stops.',
        showAiConfirm,
        showManualPackage,
        manualGuidance: 'System package installs update through your package manager.',
        manualInstallCommand: manualInstallCommand || '',
        showError: status === 'error',
        errorMessage,
        primaryAction,
        secondaryAction,
        tertiaryAction,
      },
      settings: {
        badgeText: settingsBadgeText,
        badgeTone: settingsBadgeTone,
        versionText: currentTag || 'Unknown',
        modeText: formatUpdateModeLabel(mode, manualPackageKind),
        lastCheckedText: formatUpdateLastChecked(state.lastCheckedAt, nowMs),
        showProgress: status === 'downloading',
        showRecordingNotice,
        showError: status === 'error',
        errorMessage,
        primaryAction: settingsPrimaryAction,
        autoDownload: {
          checked: autoDownloadSupported && Boolean(state.autoDownload),
          disabled: !autoDownloadSupported,
          hint: autoDownloadHint,
        },
      },
    };
  }

  function renderSafeReleaseNotes(container, releaseNotes, options = {}) {
    const doc = options.documentObj || (typeof document !== 'undefined' ? document : null);
    if (!container || !doc) {
      return false;
    }

    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren();
    } else {
      container.textContent = '';
    }

    const raw = String(releaseNotes == null ? '' : releaseNotes).trim();
    if (!raw) {
      return false;
    }

    const mdHelpers = options.markdownRenderHelpers
      || (typeof globalThis !== 'undefined' ? globalThis.markdownRenderHelpers : null);

    const sanitizedHtml = (mdHelpers && typeof mdHelpers.sanitizeMarkdownHtml === 'function')
      ? mdHelpers.sanitizeMarkdownHtml(raw)
      : null;

    if (typeof sanitizedHtml === 'string') {
      const template = doc.createElement('template');
      template.innerHTML = sanitizedHtml;
      container.appendChild(template.content);
      return true;
    }

    // Fail-closed plain-text fallback: never assign innerHTML with unsanitized strings.
    const paragraphs = raw.split(/\r?\n\s*\r?\n/);
    for (const block of paragraphs) {
      const text = block.trim();
      if (!text) {
        continue;
      }
      const p = doc.createElement('p');
      p.textContent = text;
      container.appendChild(p);
    }
    return true;
  }

  const helpers = {
    RAIL_UPDATE_RING_RADIUS,
    RAIL_UPDATE_RING_CIRCUMFERENCE,
    isTrustedUpdateDownloadUrl,
    shouldAcceptUpdateState,
    formatUpdateBytes,
    formatUpdateSpeed,
    formatUpdateLastChecked,
    formatUpdateModeLabel,
    buildUpdateViewModel,
    shouldAutoSurfaceUpdatePopover,
    renderSafeReleaseNotes,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.updateNotificationHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
