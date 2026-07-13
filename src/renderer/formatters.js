(function initFormatters(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.formatters = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildFormatters() {
  // Helper function to format seconds into MM:SS
  function formatTimestamp(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // Elapsed recording clock: MM:SS until one hour, then H:MM:SS.
  function formatElapsedDuration(totalSeconds) {
    const secondsTotal = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(secondsTotal / 3600);
    const minutes = Math.floor((secondsTotal % 3600) / 60);
    const seconds = secondsTotal % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // Format date helper
  function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Compact, Notion-style relative date for the meeting list
  function formatRelativeDate(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;

    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  }

  function formatStatusLabel(status) {
    const labels = {
      notConfigured: 'Not configured',
      needsAccount: 'Needs account',
      downloading: 'Downloading',
      validating: 'Validating',
      ready: 'Ready',
      error: 'Error',
      unsupported: 'Unsupported',
    };
    return labels[status] || 'Unknown';
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) {
      return '0 MB';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const precision = unitIndex >= 3 ? 1 : 0;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
  }

  function formatAiAddonProgressText(progress) {
    const message = progress && progress.message ? progress.message : 'Working...';
    const percent = Number.isFinite(progress && progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : null;
    const downloaded = Number(progress && progress.downloadedBytes) || 0;
    const total = Number(progress && progress.totalBytes) || 0;

    if (downloaded > 0 && total > 0) {
      return `${message} ${formatBytes(downloaded)} of ${formatBytes(total)} (${Math.round(percent || ((downloaded / total) * 100))}%)`;
    }
    if (percent !== null) {
      return `${message} ${Math.round(percent)}%`;
    }
    return message;
  }

  return {
    formatAiAddonProgressText,
    formatBytes,
    formatDate,
    formatElapsedDuration,
    formatRelativeDate,
    formatStatusLabel,
    formatTimestamp,
  };
}));
