(function attachUpdateNotificationHelpers(root) {
  function buildUpdateNotificationView(updateInfo = {}) {
    const versionSuffix = updateInfo.version ? `: v${updateInfo.version}` : '';

    return {
      title: `Update Available${versionSuffix}`,
      description: 'A new version of Meeting Transcriber is ready to download.',
      logMessage: `✨ Update available${versionSuffix}`,
    };
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

  const helpers = {
    buildUpdateNotificationView,
    showUpdateNotificationBanner,
    hideUpdateNotificationBanner,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.updateNotificationHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
