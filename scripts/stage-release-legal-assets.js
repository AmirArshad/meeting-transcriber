#!/usr/bin/env node
/**
 * Download FFmpeg corresponding source and stage files for GitHub Releases.
 * Used by .github/workflows/build-release.yml (no application code changes).
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { stageLegalBundle, stageFfmpegSourceArchive } = require('../build/prepare-resources');

const REPO_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = process.env.RELEASE_LEGAL_DIR
  ? path.resolve(process.env.RELEASE_LEGAL_DIR)
  : path.join(REPO_ROOT, 'release-legal');

function createLegalBundleZip(legalDir, version) {
  const zipPath = path.join(OUTPUT_DIR, `avanevis-legal-${version}.zip`);
  const zip = new AdmZip();

  for (const entry of fs.readdirSync(legalDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    zip.addLocalFile(path.join(legalDir, entry.name));
  }

  zip.writeZip(zipPath);
  return zipPath;
}

async function main() {
  const rawVersion = process.env.RELEASE_VERSION || require(path.join(REPO_ROOT, 'package.json')).version;
  const version = String(rawVersion).replace(/^v/, '');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const legalDir = path.join(OUTPUT_DIR, 'legal');
  fs.mkdirSync(legalDir, { recursive: true });

  stageLegalBundle(legalDir);

  try {
    const { execSync } = require('child_process');
    execSync('node scripts/generate-python-sbom.js', { cwd: REPO_ROOT, stdio: 'inherit' });
    const sbomPath = path.join(REPO_ROOT, 'legal', 'PYTHON-BUNDLED-PACKAGES.md');
    if (fs.existsSync(sbomPath)) {
      fs.copyFileSync(sbomPath, path.join(legalDir, 'PYTHON-BUNDLED-PACKAGES.md'));
    }
  } catch (error) {
    console.log(`Warning: could not generate Python SBOM: ${error.message}`);
  }

  const sourceArchive = await stageFfmpegSourceArchive(legalDir);
  const bundleZip = createLegalBundleZip(legalDir, version);

  console.log('Release legal assets ready:');
  console.log(`  ${sourceArchive}`);
  console.log(`  ${bundleZip}`);
  console.log(`  ${path.join(legalDir, 'THIRD_PARTY_NOTICES.md')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main };
