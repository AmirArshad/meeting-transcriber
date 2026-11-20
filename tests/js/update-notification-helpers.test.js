'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RAIL_UPDATE_RING_CIRCUMFERENCE,
  buildUpdateViewModel,
  formatUpdateBytes,
  formatUpdateLastChecked,
  formatUpdateModeLabel,
  formatUpdateSpeed,
  isTrustedUpdateDownloadUrl,
  renderSafeReleaseNotes,
  shouldAcceptUpdateState,
  shouldAutoSurfaceUpdatePopover,
} = require('../../src/renderer/update-notification-helpers');

const UPDATE_DOWNLOAD_BASE = 'https://github.com/AmirArshad/meeting-transcriber/releases/download';

function avanevisInstallerUrl(version) {
  return `${UPDATE_DOWNLOAD_BASE}/v${version}/AvaNevis-Setup-${version}.exe`;
}

function makeBaseState(overrides = {}) {
  return {
    seq: 1,
    status: 'idle',
    mode: 'in-app',
    currentVersion: '2.12.0',
    availableVersion: null,
    releaseDate: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    installerName: null,
    manualPackageKind: null,
    manualInstallCommand: null,
    progress: null,
    autoDownload: false,
    installOnNextQuit: false,
    lastCheckedAt: null,
    manualCheck: false,
    error: null,
    ...overrides,
  };
}

test('isTrustedUpdateDownloadUrl accepts only trusted GitHub repo release links', () => {
  assert.equal(isTrustedUpdateDownloadUrl(avanevisInstallerUrl('3.0.0')), true);
  assert.equal(
    isTrustedUpdateDownloadUrl('https://github.com/AmirArshad/meeting-transcriber/releases/latest'),
    true,
  );
  assert.equal(isTrustedUpdateDownloadUrl('http://example.com/installer.exe'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://example.com/AvaNevis-Setup-3.0.0.exe'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://github.com/electron/electron/releases/latest'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://github.com/AmirArshad/meeting-transcriber-malicious/releases/latest'), false);
  assert.equal(isTrustedUpdateDownloadUrl('mailto:updates@example.com'), false);
  assert.equal(isTrustedUpdateDownloadUrl('/local/installer.exe'), false);
});

test('shouldAcceptUpdateState enforces strictly monotonic seq numbers', () => {
  assert.equal(shouldAcceptUpdateState(-1, { seq: 0 }), true);
  assert.equal(shouldAcceptUpdateState(0, { seq: 1 }), true);
  assert.equal(shouldAcceptUpdateState(5, { seq: 5 }), false);
  assert.equal(shouldAcceptUpdateState(5, { seq: 4 }), false);
  assert.equal(shouldAcceptUpdateState(5, null), false);
  assert.equal(shouldAcceptUpdateState(5, {}), false);
});

test('formatters format bytes, speed, relative last-checked time, and update mode', () => {
  assert.equal(formatUpdateBytes(0), '0 B');
  assert.equal(formatUpdateBytes(-10), '0 B');
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(912 * 1024), '912 KB');
  assert.equal(formatUpdateBytes(48.2 * 1024 * 1024), '48.2 MB');
  assert.equal(formatUpdateBytes(1.2 * 1024 * 1024 * 1024), '1.2 GB');

  assert.equal(formatUpdateSpeed(0), '');
  assert.equal(formatUpdateSpeed(-1), '');
  assert.equal(formatUpdateSpeed(6.4 * 1024 * 1024), '6.4 MB/s');

  const now = Date.parse('2026-11-20T15:00:00.000Z');
  assert.equal(formatUpdateLastChecked(null, now), 'Never');
  assert.equal(formatUpdateLastChecked('invalid-date', now), 'Never');
  assert.equal(formatUpdateLastChecked('2026-11-20T14:59:30.000Z', now), 'Just now');
  assert.equal(formatUpdateLastChecked('2026-11-20T14:55:00.000Z', now), '5m ago');
  assert.equal(formatUpdateLastChecked('2026-11-20T13:00:00.000Z', now), '2h ago');
  assert.equal(formatUpdateLastChecked('2026-11-18T15:00:00.000Z', now), '2d ago');

  assert.equal(formatUpdateModeLabel('in-app', null), 'Automatic in-app');
  assert.equal(formatUpdateModeLabel('manual-package', 'pacman'), 'System package (pacman)');
  assert.equal(formatUpdateModeLabel('manual-package', 'deb'), 'System package (deb)');
  assert.equal(formatUpdateModeLabel('dev-unpackaged', null), 'Development build');
});

test('buildUpdateViewModel hides rail indicator on idle, up-to-date, and background checking', () => {
  const idleVm = buildUpdateViewModel(makeBaseState({ status: 'idle' }));
  assert.equal(idleVm.rail.visible, false);
  assert.equal(idleVm.settings.primaryAction.action, 'check');

  const upToDateVm = buildUpdateViewModel(makeBaseState({
    status: 'up-to-date',
    lastCheckedAt: '2026-11-20T14:55:00.000Z',
  }), { nowMs: Date.parse('2026-11-20T15:00:00.000Z') });
  assert.equal(upToDateVm.rail.visible, false);
  assert.equal(upToDateVm.settings.badgeText, 'Up to date');
  assert.equal(upToDateVm.settings.lastCheckedText, '5m ago');

  const bgCheckVm = buildUpdateViewModel(makeBaseState({ status: 'checking', manualCheck: false }));
  assert.equal(bgCheckVm.rail.visible, false);

  const manualCheckVm = buildUpdateViewModel(makeBaseState({ status: 'checking', manualCheck: true }));
  assert.equal(manualCheckVm.rail.visible, true);
  assert.equal(manualCheckVm.rail.iconKind, 'spinner');
});

test('buildUpdateViewModel builds available, downloading, and ready-to-install states with recording safety gate', () => {
  const availableVm = buildUpdateViewModel(makeBaseState({
    status: 'available',
    currentVersion: '2.12.0',
    availableVersion: '3.0.0',
    releaseNotes: '## Highlights\n- In-app updater',
  }));
  assert.equal(availableVm.rail.visible, true);
  assert.equal(availableVm.rail.showDot, true);
  assert.equal(availableVm.rail.tooltip, 'Update v3.0.0 available');
  assert.equal(availableVm.popover.versionDelta, 'v2.12.0 → v3.0.0');
  assert.equal(availableVm.popover.hasReleaseNotes, true);
  assert.equal(availableVm.popover.primaryAction.action, 'download');
  assert.equal(availableVm.popover.secondaryAction.action, 'github');
  assert.equal(availableVm.popover.tertiaryAction.action, 'later');

  // Dismissed version quiets the attention dot without hiding the rail entry
  const dismissedVm = buildUpdateViewModel(makeBaseState({
    status: 'available',
    availableVersion: '3.0.0',
  }), { dismissedVersion: '3.0.0' });
  assert.equal(dismissedVm.rail.visible, true);
  assert.equal(dismissedVm.rail.showDot, false);

  // Downloading drives SVG ring dashoffset and tabular stats
  const downloadingVm = buildUpdateViewModel(makeBaseState({
    status: 'downloading',
    availableVersion: '3.0.0',
    progress: {
      percent: 50,
      transferred: 50 * 1024 * 1024,
      total: 100 * 1024 * 1024,
      bytesPerSecond: 5 * 1024 * 1024,
    },
  }));
  assert.equal(downloadingVm.rail.visible, true);
  assert.equal(downloadingVm.rail.showRing, true);
  assert.equal(downloadingVm.rail.tooltip, 'Downloading 50%');
  assert.equal(downloadingVm.progress.percentText, '50%');
  assert.equal(downloadingVm.progress.transferredText, '50.0 MB / 100.0 MB');
  assert.equal(downloadingVm.progress.speedText, '5.0 MB/s');
  assert.ok(Math.abs(downloadingVm.progress.ringDashOffset - (RAIL_UPDATE_RING_CIRCUMFERENCE / 2)) < 0.05);
  assert.equal(downloadingVm.popover.secondaryAction.action, 'cancel');

  // Ready-to-install while recording disables Restart and shows amber notice
  const readyRecordingVm = buildUpdateViewModel(makeBaseState({
    status: 'ready-to-install',
    availableVersion: '3.0.0',
  }), { isRecordingActive: true, dismissedVersion: '3.0.0' });
  assert.equal(readyRecordingVm.rail.visible, true);
  assert.equal(readyRecordingVm.rail.tone, 'emerald');
  assert.equal(readyRecordingVm.rail.showDot, true);
  assert.equal(readyRecordingVm.popover.showRecordingNotice, true);
  assert.equal(readyRecordingVm.popover.primaryAction.disabled, true);
  assert.equal(readyRecordingVm.settings.primaryAction.disabled, true);

  // Ready-to-install when idle with AI confirmation pending
  const readyAiConfirmVm = buildUpdateViewModel(makeBaseState({
    status: 'ready-to-install',
    availableVersion: '3.0.0',
  }), { isRecordingActive: false, aiConfirmPending: true });
  assert.equal(readyAiConfirmVm.popover.showRecordingNotice, false);
  assert.equal(readyAiConfirmVm.popover.showAiConfirm, true);
  assert.equal(readyAiConfirmVm.popover.primaryAction.disabled, false);
  assert.equal(readyAiConfirmVm.popover.primaryAction.variant, 'ready');
});

test('buildUpdateViewModel handles Linux manual-package, error, and dev-unpackaged modes', () => {
  const pacmanVm = buildUpdateViewModel(makeBaseState({
    status: 'manual-required',
    mode: 'manual-package',
    availableVersion: '3.0.0',
    manualPackageKind: 'pacman',
    manualInstallCommand: 'sudo pacman -U ~/Downloads/avanevis-3.0.0-x86_64.pkg.tar.zst',
    autoDownload: true,
  }));
  assert.equal(pacmanVm.rail.visible, true);
  assert.equal(pacmanVm.popover.showManualPackage, true);
  assert.equal(pacmanVm.popover.primaryAction.label, 'Download .pkg.tar.zst');
  assert.equal(pacmanVm.settings.modeText, 'System package (pacman)');
  assert.equal(pacmanVm.settings.autoDownload.disabled, true);
  assert.equal(pacmanVm.settings.autoDownload.checked, false);

  const debVm = buildUpdateViewModel(makeBaseState({
    status: 'manual-required',
    mode: 'manual-package',
    availableVersion: '3.0.0',
    manualPackageKind: 'deb',
    manualInstallCommand: 'sudo apt install ~/Downloads/avanevis_3.0.0_amd64.deb',
  }));
  assert.equal(debVm.popover.primaryAction.label, 'Download .deb');
  assert.equal(debVm.settings.modeText, 'System package (deb)');

  const errorVm = buildUpdateViewModel(makeBaseState({
    status: 'error',
    error: { code: 'NETWORK', message: 'Offline', retryable: true },
  }));
  assert.equal(errorVm.rail.visible, true);
  assert.equal(errorVm.rail.tone, 'crimson');
  assert.equal(errorVm.popover.showError, true);
  assert.equal(errorVm.popover.errorMessage, 'Offline');
  assert.equal(errorVm.popover.primaryAction.action, 'retry');

  const devVm = buildUpdateViewModel(makeBaseState({
    status: 'idle',
    mode: 'dev-unpackaged',
  }));
  assert.equal(devVm.settings.modeText, 'Development build');
  assert.equal(devVm.settings.autoDownload.disabled, true);
  assert.equal(devVm.settings.primaryAction.disabled, true);
});

test('shouldAutoSurfaceUpdatePopover never pops during recording or background checks', () => {
  const checking = makeBaseState({ seq: 1, status: 'checking', manualCheck: true });
  const availableManual = makeBaseState({ seq: 2, status: 'available', availableVersion: '3.0.0', manualCheck: true });
  const availableBg = makeBaseState({ seq: 2, status: 'available', availableVersion: '3.0.0', manualCheck: false });
  const upToDateManual = makeBaseState({ seq: 2, status: 'up-to-date', manualCheck: true });

  assert.equal(shouldAutoSurfaceUpdatePopover(checking, availableManual, { isRecordingActive: false }), true);
  assert.equal(shouldAutoSurfaceUpdatePopover(checking, upToDateManual, { isRecordingActive: false }), true);
  assert.equal(shouldAutoSurfaceUpdatePopover(checking, availableManual, { isRecordingActive: true }), false);
  assert.equal(shouldAutoSurfaceUpdatePopover(checking, availableBg, { isRecordingActive: false }), false);
  assert.equal(shouldAutoSurfaceUpdatePopover(availableManual, availableManual, { isRecordingActive: false }), false);
});

test('renderSafeReleaseNotes uses strict sanitizer and fails closed to plain text when absent', () => {
  // Mock minimal DOM
  function createMockDocument() {
    return {
      createElement(tag) {
        const el = {
          tagName: tag.toUpperCase(),
          children: [],
          textContent: '',
          _innerHTML: '',
          get innerHTML() { return this._innerHTML; },
          set innerHTML(val) {
            this._innerHTML = String(val);
            if (tag === 'template') {
              this.content = { __fromTemplateHtml: String(val) };
            }
          },
          appendChild(child) {
            this.children.push(child);
            return child;
          },
          replaceChildren(...nodes) {
            this.children = [...nodes];
          },
        };
        return el;
      },
    };
  }

  const doc = createMockDocument();
  const container = doc.createElement('div');

  // Empty notes returns false and clears container
  assert.equal(renderSafeReleaseNotes(container, '   ', { documentObj: doc }), false);
  assert.equal(container.children.length, 0);

  // Sanitized path uses markdownRenderHelpers.sanitizeMarkdownHtml
  const seenInputs = [];
  const sanitized = renderSafeReleaseNotes(
    container,
    '## Release\n<script>alert(1)</script><a href="https://evil.example">x</a>',
    {
      documentObj: doc,
      markdownRenderHelpers: {
        sanitizeMarkdownHtml(raw) {
          seenInputs.push(raw);
          return '<h2>Release</h2><p>x</p>';
        },
      },
    },
  );
  assert.equal(sanitized, true);
  assert.equal(seenInputs.length, 1);
  assert.deepEqual(container.children, [{ __fromTemplateHtml: '<h2>Release</h2><p>x</p>' }]);

  // Fail-closed plain-text fallback when sanitizer is unavailable (never sets innerHTML!)
  const fallbackContainer = doc.createElement('div');
  const fallbackResult = renderSafeReleaseNotes(
    fallbackContainer,
    'First paragraph <img src=x onerror=alert(1)>\n\nSecond paragraph',
    {
      documentObj: doc,
      markdownRenderHelpers: null,
    },
  );
  assert.equal(fallbackResult, true);
  assert.equal(fallbackContainer._innerHTML, '');
  assert.equal(fallbackContainer.children.length, 2);
  assert.equal(fallbackContainer.children[0].tagName, 'P');
  assert.equal(fallbackContainer.children[0].textContent, 'First paragraph <img src=x onerror=alert(1)>');
  assert.equal(fallbackContainer.children[1].textContent, 'Second paragraph');
});
