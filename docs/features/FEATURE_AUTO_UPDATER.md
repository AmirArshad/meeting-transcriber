# Feature: Automatic Updates

## Overview

Implement automatic update detection and installation for new releases published on GitHub, keeping users on the latest version with minimal effort.

## Problem Being Solved

**Current State:**
- Users must manually check GitHub for new releases
- No notification when updates are available
- Manual download and installation required
- Users stay on outdated versions

**User Pain Points:**
- "I didn't know there was a new version"
- "Do I have the latest version?"
- "The manual update process is tedious"
- "I'm missing new features and bug fixes"

## Proposed Solution

### Automatic Update Flow

```
App Startup
    ↓
Check GitHub Releases API
    ↓
New Version Available? ─No→ Continue normally
    ↓ Yes
Show Notification
    ↓
User clicks "Update"
    ↓
Download in background
    ↓
Show "Update Downloaded"
    ↓
User clicks "Install & Restart"
    ↓
App restarts with new version
```

## User Experience

### 1. Update Available Notification

```
┌──────────────────────────────────────────────┐
│ 📦 Update Available: v1.3.0                  │
│                                              │
│ New features:                                │
│ • Combined Start/Stop button                │
│ • Audio visualizer                          │
│ • Performance improvements                  │
│                                              │
│ Current version: 1.2.4                      │
│ New version: 1.3.0                          │
│                                              │
│ [View Changelog]  [Later]  [Download Update]│
└──────────────────────────────────────────────┘
```

### 2. Downloading Update

```
┌──────────────────────────────────────────────┐
│ ⏬ Downloading Update...                     │
│                                              │
│ v1.3.0 (45.2 MB / 120.5 MB)                 │
│ ████████████░░░░░░░░░░░░░░░░░░░ 37%         │
│                                              │
│ You can continue using the app while        │
│ the update downloads.                       │
│                                              │
│ [Cancel Download]                           │
└──────────────────────────────────────────────┘
```

### 3. Ready to Install

```
┌──────────────────────────────────────────────┐
│ ✅ Update Downloaded                         │
│                                              │
│ Version 1.3.0 is ready to install.          │
│                                              │
│ The app will restart to complete the        │
│ installation.                               │
│                                              │
│ [Install Now]  [Install on Next Startup]    │
└──────────────────────────────────────────────┘
```

## Technical Implementation

### Dependencies

```bash
npm install electron-updater
```

**Why electron-updater?**
- Official Electron solution
- Integrates with GitHub Releases
- Handles code signing verification
- Cross-platform (Windows, macOS, Linux)
- Auto-update on app startup

### Configuration (package.json)

```json
{
  "name": "meeting-transcriber",
  "version": "1.2.4",
  "repository": {
    "type": "git",
    "url": "https://github.com/AmirArshad/meeting-transcriber.git"
  },
  "build": {
    "appId": "com.amirarshad.meetingtranscriber",
    "productName": "Meeting Transcriber",
    "publish": [
      {
        "provider": "github",
        "owner": "AmirArshad",
        "repo": "meeting-transcriber"
      }
    ],
    "win": {
      "target": ["nsis"],
      "publisherName": "Amir Arshad"
    }
  }
}
```

### Main Process (main.js)

```javascript
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Auto-updater configuration
autoUpdater.autoDownload = false; // User must explicitly click "Update"
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow;

app.whenReady().then(() => {
  createWindow();

  // Check for updates after app loads (5 second delay)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
});

function checkForUpdates() {
  autoUpdater.checkForUpdates();
}

// ============================================================================
// Auto-Updater Event Handlers
// ============================================================================

autoUpdater.on('checking-for-update', () => {
  log.info('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info.version);

  // Send notification to renderer
  mainWindow.webContents.send('update-available', {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes
  });
});

autoUpdater.on('update-not-available', (info) => {
  log.info('App is up to date:', info.version);
});

autoUpdater.on('error', (err) => {
  log.error('Update error:', err);
  mainWindow.webContents.send('update-error', err.message);
});

autoUpdater.on('download-progress', (progressObj) => {
  // Send download progress to renderer
  mainWindow.webContents.send('download-progress', {
    percent: progressObj.percent,
    transferred: progressObj.transferred,
    total: progressObj.total,
    bytesPerSecond: progressObj.bytesPerSecond
  });
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info.version);

  // Send notification to renderer
  mainWindow.webContents.send('update-downloaded', {
    version: info.version
  });
});

// ============================================================================
// IPC Handlers for Update Actions
// ============================================================================

ipcMain.handle('start-update-download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    log.error('Failed to start download:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-update', () => {
  // This will quit the app and install the update
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('check-for-updates-manual', () => {
  checkForUpdates();
});

ipcMain.handle('get-current-version', () => {
  return app.getVersion();
});
```

### Renderer Process (app.js)

```javascript
let updateInfo = null;

// Listen for update notifications
window.electronAPI.onUpdateAvailable((info) => {
  updateInfo = info;
  showUpdateNotification(info);
});

window.electronAPI.onDownloadProgress((progress) => {
  updateDownloadProgress(progress);
});

window.electronAPI.onUpdateDownloaded((info) => {
  showInstallPrompt(info);
});

window.electronAPI.onUpdateError((error) => {
  showUpdateError(error);
});

// Show update notification banner
function showUpdateNotification(info) {
  const banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.innerHTML = `
    <div class="update-content">
      <span class="update-icon">📦</span>
      <div class="update-text">
        <strong>Update Available: v${info.version}</strong>
        <p>New features and improvements are ready to download.</p>
      </div>
      <div class="update-actions">
        <button onclick="viewChangelog()">View Changes</button>
        <button onclick="dismissUpdate()">Later</button>
        <button class="primary" onclick="startUpdate()">Download Update</button>
      </div>
    </div>
  `;

  document.body.prepend(banner);
}

async function startUpdate() {
  const result = await window.electronAPI.startUpdateDownload();

  if (result.success) {
    showDownloadingUI();
  } else {
    alert(`Update failed: ${result.error}`);
  }
}

function showDownloadingUI() {
  const banner = document.querySelector('.update-banner');
  banner.innerHTML = `
    <div class="update-content">
      <span class="update-icon">⏬</span>
      <div class="update-text">
        <strong>Downloading Update...</strong>
        <p id="download-status">Preparing download...</p>
        <div class="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
      </div>
    </div>
  `;
}

function updateDownloadProgress(progress) {
  const statusText = document.getElementById('download-status');
  const progressFill = document.getElementById('progress-fill');

  const percent = Math.round(progress.percent);
  const transferred = formatBytes(progress.transferred);
  const total = formatBytes(progress.total);
  const speed = formatBytes(progress.bytesPerSecond);

  statusText.textContent = `${transferred} / ${total} (${speed}/s)`;
  progressFill.style.width = `${percent}%`;
}

function showInstallPrompt(info) {
  const banner = document.querySelector('.update-banner');
  banner.innerHTML = `
    <div class="update-content">
      <span class="update-icon">✅</span>
      <div class="update-text">
        <strong>Update Ready to Install</strong>
        <p>Version ${info.version} has been downloaded. Restart to complete installation.</p>
      </div>
      <div class="update-actions">
        <button onclick="dismissUpdate()">Install on Next Startup</button>
        <button class="primary" onclick="installUpdate()">Install Now</button>
      </div>
    </div>
  `;
}

async function installUpdate() {
  await window.electronAPI.installUpdate();
}

function dismissUpdate() {
  const banner = document.querySelector('.update-banner');
  if (banner) {
    banner.remove();
  }
}

function viewChangelog() {
  if (updateInfo && updateInfo.releaseNotes) {
    // Show changelog in modal or new window
    showChangelogModal(updateInfo.releaseNotes);
  } else {
    // Open GitHub releases page
    window.electronAPI.openExternal(
      `https://github.com/AmirArshad/meeting-transcriber/releases`
    );
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
```

### Preload Script (preload.js)

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ... existing APIs ...

  // Update APIs
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', (event, info) => callback(info));
  },
  onUpdateError: (callback) => {
    ipcRenderer.on('update-error', (event, error) => callback(error));
  },
  startUpdateDownload: () => ipcRenderer.invoke('start-update-download'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdatesManual: () => ipcRenderer.invoke('check-for-updates-manual'),
  getCurrentVersion: () => ipcRenderer.invoke('get-current-version')
});
```

### CSS Styling (styles.css)

```css
.update-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 15px 20px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

.update-content {
  display: flex;
  align-items: center;
  gap: 15px;
  max-width: 1200px;
  margin: 0 auto;
}

.update-icon {
  font-size: 32px;
}

.update-text {
  flex: 1;
}

.update-text strong {
  display: block;
  font-size: 16px;
  margin-bottom: 4px;
}

.update-text p {
  margin: 0;
  font-size: 14px;
  opacity: 0.9;
}

.update-actions {
  display: flex;
  gap: 10px;
}

.update-actions button {
  padding: 8px 16px;
  border: 1px solid rgba(255,255,255,0.3);
  background: rgba(255,255,255,0.1);
  color: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.update-actions button:hover {
  background: rgba(255,255,255,0.2);
}

.update-actions button.primary {
  background: white;
  color: #667eea;
  font-weight: bold;
}

.update-actions button.primary:hover {
  transform: scale(1.05);
}

.progress-bar {
  width: 300px;
  height: 8px;
  background: rgba(255,255,255,0.2);
  border-radius: 4px;
  overflow: hidden;
  margin-top: 8px;
}

.progress-fill {
  height: 100%;
  background: white;
  width: 0%;
  transition: width 0.3s ease;
}
```

## Release Process

### 1. Create GitHub Release

```bash
# Tag the release
git tag v1.3.0
git push origin v1.3.0

# Build installer
npm run build

# Upload installer to GitHub Release
# electron-builder will handle this automatically if configured
```

### 2. electron-builder Configuration

```json
{
  "build": {
    "publish": [
      {
        "provider": "github",
        "owner": "AmirArshad",
        "repo": "meeting-transcriber",
        "releaseType": "release"
      }
    ]
  },
  "scripts": {
    "build": "electron-builder --win --publish always"
  }
}
```

### 3. GitHub Token

Set `GH_TOKEN` environment variable for publishing:

```bash
# Windows
set GH_TOKEN=your_github_personal_access_token

# Build and publish
npm run build
```

## Security Considerations

### Code Signing
- **Required for Windows SmartScreen**
- Prevents "Unknown Publisher" warning
- Users more likely to install
- Cost: ~$200-400/year for certificate

```json
{
  "build": {
    "win": {
      "certificateFile": "path/to/certificate.pfx",
      "certificatePassword": "password",
      "signingHashAlgorithms": ["sha256"]
    }
  }
}
```

### Update Verification
- electron-updater verifies signatures automatically
- Uses HTTPS for all downloads
- Checks GitHub release authenticity

## User Settings

### Auto-Update Preferences

```javascript
// settings.json
{
  "autoUpdate": {
    "checkOnStartup": true,
    "autoDownload": false,
    "notifyOnly": false
  }
}
```

**UI:**
```
Settings → Updates
  [x] Check for updates on startup
  [ ] Automatically download updates
  [ ] Notify only (don't show banner)

  Current version: 1.2.4
  [Check for Updates Now]
```

## Testing

### Local Testing

```bash
# Build with different version
npm version patch  # 1.2.4 → 1.2.5

# Build installer
npm run build

# Test update flow
```

### Staging Releases

Use pre-release for testing:

```bash
git tag v1.3.0-beta.1
git push origin v1.3.0-beta.1

# Mark as pre-release on GitHub
# Users on beta channel will receive it
```

## Error Handling

### Network Errors
- Retry download up to 3 times
- Show error notification
- Allow manual retry

### Installation Errors
- Log detailed error messages
- Fallback to manual update link
- Don't break current installation

## Benefits

### For Users
- **Always Current:** Automatic updates keep app secure
- **Minimal Effort:** One-click update process
- **New Features:** Get improvements as soon as released
- **Security:** Fixes delivered quickly

### For Development
- **Faster Adoption:** Users update more frequently
- **Better Metrics:** Track version distribution
- **Reduced Support:** Fewer "outdated version" issues
- **Easier Rollouts:** Push fixes and features seamlessly

## Implementation Timeline

**Estimated Effort:** 6-8 hours

1. **Setup electron-updater** (2 hours)
   - Install dependencies
   - Configure package.json
   - Set up GitHub token

2. **Implement Update Logic** (2 hours)
   - Add auto-updater event handlers
   - Create IPC handlers
   - Test update checking

3. **Build UI Components** (2 hours)
   - Design update banner
   - Implement download progress
   - Add install prompts

4. **Testing & Polish** (2 hours)
   - Test full update flow
   - Handle edge cases
   - Code signing setup

## Success Metrics

- **Update Adoption:** >80% of users on latest version within 2 weeks
- **User Satisfaction:** Positive feedback on update process
- **Reduced Support:** Fewer issues from outdated versions
- **Release Velocity:** Ship updates more frequently

---

**Status:** Planned for v1.3.0
**Priority:** Medium
**Tracking:** Issue #TBD
**Related:** main.js, app.js, package.json
