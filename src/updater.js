/**
 * Simple auto-updater using GitHub Releases API
 *
 * Checks for new releases on startup and notifies user.
 * No code signing required - user downloads manually.
 */

const { app, shell } = require('electron');
const fs = require('fs');
const https = require('https');
const { resolveExternalUrl, UPDATER_HTTP_RESPONSE_MAX_CHARS } = require('./main-process-helpers');

// GitHub repository info
const REPO_OWNER = 'AmirArshad';
const REPO_NAME = 'meeting-transcriber';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const INSTALLER_NAME_TOKEN = 'AvaNevis-Setup-';

/**
 * Check if a new version is available on GitHub
 *
 * @returns {Promise<Object|null>} Update info or null if no update
 */
async function checkForUpdates({ throwOnError = false } = {}) {
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

      // Find the appropriate installer asset based on platform
      const installerAsset = findInstallerAsset(releaseInfo.assets);

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
    if (throwOnError) {
      throw error;
    }
    // Don't throw - update check failures should be silent for legacy callers
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
        'User-Agent': 'AvaNevis-App',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    https.get(GITHUB_API, options, (res) => {
      res.setEncoding('utf8');
      let data = '';

      res.on('data', (chunk) => {
        if (data.length >= UPDATER_HTTP_RESPONSE_MAX_CHARS) {
          return;
        }
        const remaining = UPDATER_HTTP_RESPONSE_MAX_CHARS - data.length;
        data += chunk.slice(0, remaining);
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
 * Find the appropriate installer asset for the current platform
 *
 * @param {Array} assets - Release assets from GitHub API
 * @returns {Object|null} Matching asset or null
 */
function parseOsRelease(text) {
  const fields = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value.replace(/\\([\\"'$`])/g, '$1');
  }
  return fields;
}

function readOsRelease() {
  try {
    return fs.readFileSync('/etc/os-release', 'utf8');
  } catch (_error) {
    return '';
  }
}

function isValidLinuxAppImageEnvPath(env) {
  const raw = env && typeof env.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
  return Boolean(raw && raw.startsWith('/') && !raw.includes('\0'));
}

function resolveLinuxInstallerOrder({ env = process.env, osReleaseText = readOsRelease() } = {}) {
  if (isValidLinuxAppImageEnvPath(env)) {
    return ['.AppImage'];
  }

  const release = parseOsRelease(osReleaseText);
  const id = String(release.ID || '').toLowerCase();
  const related = new Set([
    id,
    ...String(release.ID_LIKE || '').toLowerCase().split(/\s+/),
  ].filter(Boolean));

  // SteamOS has an Arch lineage but its read-only A/B root makes pacman -U a
  // poor update route. Keep Desktop Mode friends on the portable artifact.
  if (id === 'steamos') {
    return ['.AppImage'];
  }
  if (['ubuntu', 'debian', 'pop', 'linuxmint'].some((name) => related.has(name))) {
    return ['.deb', '.AppImage'];
  }
  if (['arch', 'cachyos', 'omarchy'].some((name) => related.has(name))) {
    return ['.pkg.tar.zst', '.AppImage'];
  }
  return ['.AppImage'];
}

function findInstallerAsset(assets, options = {}) {
  const platform = options.platform || process.platform;

  if (platform === 'darwin') {
    const dmgAsset = assets.find(asset =>
      asset.name.startsWith(INSTALLER_NAME_TOKEN) && asset.name.endsWith('.dmg')
    );
    return dmgAsset || null;
  }

  if (platform === 'win32') {
    const exeAsset = assets.find(asset =>
      asset.name.startsWith(INSTALLER_NAME_TOKEN) && asset.name.endsWith('.exe')
    );
    return exeAsset || null;
  }

  if (platform === 'linux') {
    const suffixOrder = resolveLinuxInstallerOrder({
      env: options.env || process.env,
      osReleaseText: Object.prototype.hasOwnProperty.call(options, 'osReleaseText')
        ? options.osReleaseText
        : readOsRelease(),
    });
    for (const suffix of suffixOrder) {
      const asset = assets.find((candidate) =>
        candidate.name.startsWith(INSTALLER_NAME_TOKEN) && candidate.name.endsWith(suffix)
      );
      if (asset) return asset;
    }
    return null;
  }

  return null;
}

function parseSemver(version) {
  if (typeof version !== 'string') {
    return null;
  }
  const cleaned = version.trim().replace(/^v/, '');
  const match = cleaned.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }
  const prereleaseRaw = match[4];
  let prerelease = [];
  if (prereleaseRaw !== undefined) {
    prerelease = prereleaseRaw.split('.');
    if (prerelease.some((id) => id === '')) {
      return null;
    }
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(aIds, bIds) {
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    if (i >= aIds.length) return -1;
    if (i >= bIds.length) return 1;
    const a = aIds[i];
    const b = bIds[i];
    if (a === b) continue;
    const aNum = /^[0-9]+$/.test(a);
    const bNum = /^[0-9]+$/.test(b);
    if (aNum && bNum) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (aNum !== bNum) {
      return aNum ? -1 : 1;
    }
    return a > b ? 1 : -1;
  }
  return 0;
}

/**
 * Compare two semantic versions per SemVer 2.0.0.
 *
 * @param {string} latest - Latest version (e.g., "3.0.0")
 * @param {string} current - Current version (e.g., "3.0.0-rc.1")
 * @returns {boolean} True if latest is newer than current
 */
function isNewerVersion(latest, current) {
  const parsedLatest = parseSemver(latest);
  const parsedCurrent = parseSemver(current);
  if (!parsedLatest || !parsedCurrent) {
    return false;
  }

  for (const field of ['major', 'minor', 'patch']) {
    if (parsedLatest[field] > parsedCurrent[field]) return true;
    if (parsedLatest[field] < parsedCurrent[field]) return false;
  }

  const latestHasPre = parsedLatest.prerelease.length > 0;
  const currentHasPre = parsedCurrent.prerelease.length > 0;
  if (!latestHasPre && !currentHasPre) {
    return false;
  }
  if (!latestHasPre && currentHasPre) {
    return true;
  }
  if (latestHasPre && !currentHasPre) {
    return false;
  }
  return comparePrereleaseIdentifiers(parsedLatest.prerelease, parsedCurrent.prerelease) > 0;
}

/**
 * Open the download URL in the user's browser
 *
 * @param {string} url - Download or release page URL
 */
function openDownloadPage(url) {
  const trustedUrl = resolveExternalUrl(url);
  const repoPrefix = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
  if (
    !trustedUrl
    || !(trustedUrl === repoPrefix || trustedUrl.startsWith(`${repoPrefix}/`))
  ) {
    throw new Error(`Refusing to open untrusted update URL: ${url}`);
  }

  return shell.openExternal(trustedUrl);
}

module.exports = {
  checkForUpdates,
  findInstallerAsset,
  parseOsRelease,
  resolveLinuxInstallerOrder,
  openDownloadPage,
  isNewerVersion // Export for testing
};
