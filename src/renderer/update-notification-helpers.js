(function attachUpdateNotificationHelpers(root) {
  function buildUpdateNotificationView(updateInfo = {}) {
    const versionSuffix = updateInfo.version ? `: v${updateInfo.version}` : '';

    return {
      title: `Update Available${versionSuffix}`,
      description: 'A new version of AvaNevis is ready to download.',
      logMessage: `✨ Update available${versionSuffix}`,
    };
  }

  const TRUSTED_GITHUB_REPO_PATH_PREFIX = '/AmirArshad/meeting-transcriber';

  function isTrustedUpdateDownloadUrl(url) {
    try {
      const parsedUrl = new URL(String(url || ''));
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
        return false;
      }

      return parsedUrl.pathname === TRUSTED_GITHUB_REPO_PATH_PREFIX
        || parsedUrl.pathname.startsWith(`${TRUSTED_GITHUB_REPO_PATH_PREFIX}/`);
    } catch (error) {
      return false;
    }
  }

  function showUpdateNotificationBanner({
    banner,
    title,
    description,
    downloadBtn,
    dismissBtn,
    updateInfo,
    onDownload,
    onDismiss,
    addLog,
  }) {
    const view = buildUpdateNotificationView(updateInfo);

    if (title) {
      title.textContent = view.title;
    }

    if (description) {
      description.textContent = view.description;
    }

    if (banner) {
      banner.style.display = 'block';
    }

    if (downloadBtn) {
      downloadBtn.onclick = onDownload;
    }

    if (dismissBtn) {
      dismissBtn.onclick = onDismiss;
    }

    if (typeof addLog === 'function') {
      addLog(view.logMessage);
    }

    return updateInfo;
  }

  function hideUpdateNotificationBanner({ banner, addLog }) {
    if (banner) {
      banner.style.display = 'none';
    }

    if (typeof addLog === 'function') {
      addLog('Update reminder dismissed');
    }
  }

  async function replayPendingUpdateNotification({ getPendingUpdateInfo, showUpdateNotification }) {
    if (typeof getPendingUpdateInfo !== 'function' || typeof showUpdateNotification !== 'function') {
      return null;
    }

    const updateInfo = await getPendingUpdateInfo();
    if (updateInfo && updateInfo.version && isTrustedUpdateDownloadUrl(updateInfo.downloadUrl)) {
      showUpdateNotification(updateInfo);
      return updateInfo;
    }

    return null;
  }

  const helpers = {
    buildUpdateNotificationView,
    isTrustedUpdateDownloadUrl,
    showUpdateNotificationBanner,
    hideUpdateNotificationBanner,
    replayPendingUpdateNotification,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.updateNotificationHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
