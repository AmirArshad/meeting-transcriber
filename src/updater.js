/**
 * Simple auto-updater using GitHub Releases API
 *
 * Checks for new releases on startup and notifies user.
 * No code signing required - user downloads manually.
 */

const { app, shell } = require('electron');
const https = require('https');

// GitHub repository info
const REPO_OWNER = 'AmirArshad';
const REPO_NAME = 'meeting-transcriber';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

/**
 * Check if a new version is available on GitHub
 *
 * @returns {Promise<Object|null>} Update info or null if no update
 */
async function checkForUpdates() {
  try {
    console.log('Checking for updates...');
    const currentVersion = app.getVersion(); // From package.json

    const releaseInfo = await fetchLatestRelease();

    if (!releaseInfo) {
      console.log('No release information available');
      return null;
    }

    const latestVersion = releaseInfo.tag_name.replace(/^v/, ''); // Remove 'v' prefix

    console.log(`Current version: ${currentVersion}`);
    console.log(`Latest version: ${latestVersion}`);

    if (isNewerVersion(latestVersion, currentVersion)) {
      console.log('✨ New version available!');

      // Find the Windows installer asset
      const installerAsset = releaseInfo.assets.find(asset =>
        asset.name.endsWith('.exe') && asset.name.includes('Setup')
      );

      return {
        version: latestVersion,
        releaseUrl: releaseInfo.html_url,
        downloadUrl: installerAsset ? installerAsset.browser_download_url : releaseInfo.html_url,
        releaseNotes: releaseInfo.body,
        releaseDate: releaseInfo.published_at,
        installerName: installerAsset ? installerAsset.name : null
      };
    }

    console.log('✓ App is up to date');
    return null;

  } catch (error) {
    console.error('Failed to check for updates:', error.message);
    // Don't throw - update check failures should be silent
    return null;
  }
}

/**
 * Fetch latest release info from GitHub API
 *
 * @returns {Promise<Object>} Release data
 */
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Meeting-Transcriber-App',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    https.get(GITHUB_API, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            resolve(release);
          } catch (e) {
            reject(new Error(`Failed to parse release data: ${e.message}`));
          }
        } else if (res.statusCode === 404) {
          // No releases yet
          resolve(null);
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
        }
      });

    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Compare two semantic versions
 *
 * @param {string} latest - Latest version (e.g., "1.3.0")
 * @param {string} current - Current version (e.g., "1.2.4")
 * @returns {boolean} True if latest is newer than current
 */
function isNewerVersion(latest, current) {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const latestPart = latestParts[i] || 0;
    const currentPart = currentParts[i] || 0;

    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false; // Versions are equal
}

/**
 * Open the download URL in the user's browser
 *
 * @param {string} url - Download or release page URL
 */
function openDownloadPage(url) {
  shell.openExternal(url);
}

module.exports = {
  checkForUpdates,
  openDownloadPage,
  isNewerVersion // Export for testing
};
