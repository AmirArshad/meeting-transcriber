#!/usr/bin/env node
/**
 * Extract auditable dependency inventories from catalogs that Dependabot and
 * pip-audit cannot read directly: the Parakeet wheel locks, the pyannote
 * dependency artifacts, the bootstrap pip wheel, and the native runtime
 * downloads (CPython, FFmpeg).
 *
 *   node scripts/extract-dependency-inventory.js --list
 *   node scripts/extract-dependency-inventory.js --inventory parakeet-macos-metal --out reqs.txt
 *   node scripts/extract-dependency-inventory.js --parakeet-lock <path> --out reqs.txt
 *   node scripts/extract-dependency-inventory.js --json
 *
 * Requirements output is exact `name==version` lines for
 * scripts/pip_audit_inventory.py. Native components are inventoried for
 * review but are not in PyPI advisory databases, so they never appear in
 * requirements output. Any entry that cannot be parsed exactly fails the run:
 * an empty or partial list must never reach the audit as "clean".
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PARAKEET_LOCK_DIR = path.join(REPO_ROOT, 'build', 'parakeet');
const EXACT_VERSION = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[A-Za-z0-9.]+)?$/;

function normalizePackageName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function publicVersion(version) {
  return String(version).split('+', 1)[0];
}

function pypiEntry(name, version, source) {
  const normalizedName = normalizePackageName(name);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalizedName)) {
    throw new Error(`${source}: invalid package name ${JSON.stringify(name)}`);
  }
  if (!EXACT_VERSION.test(String(version || ''))) {
    throw new Error(`${source}: ${normalizedName} is not pinned to an exact version (${JSON.stringify(version)})`);
  }
  return { ecosystem: 'PyPI', name: normalizedName, version: String(version), auditVersion: publicVersion(version), source };
}

function parseExactRequirement(requirement, source) {
  const match = String(requirement).trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;]+)$/);
  if (!match) {
    throw new Error(`${source}: requirement is not an exact pin: ${JSON.stringify(requirement)}`);
  }
  return pypiEntry(match[1], match[2], source);
}

function wheelNameAndVersion(fileName, source) {
  const match = String(fileName).match(/^([^-]+)-([^-]+)-(?:\d[^-]*-)?[^-]+-[^-]+-[^-]+\.whl$/);
  if (!match) {
    throw new Error(`${source}: unparseable wheel file name ${JSON.stringify(fileName)}`);
  }
  return { name: normalizePackageName(match[1]), version: match[2] };
}

function finishInventory(id, kind, entries) {
  if (entries.length === 0) {
    throw new Error(`${id}: inventory is empty`);
  }
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.ecosystem}:${entry.name}`;
    const previous = seen.get(key);
    if (previous && previous.version !== entry.version) {
      throw new Error(`${id}: ${entry.name} is listed at both ${previous.version} and ${entry.version}`);
    }
    seen.set(key, entry);
  }
  const unique = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { id, kind, entries: unique };
}

function parakeetLockInventory(lock, id) {
  if (!lock || !Array.isArray(lock.wheels)) {
    throw new Error(`${id}: lock has no wheels array`);
  }
  const entries = lock.wheels.map((wheel, index) => {
    const source = `${id} wheels[${index}]`;
    const fromFile = wheelNameAndVersion(wheel.fileName, source);
    const entry = pypiEntry(wheel.packageName, wheel.version, source);
    if (fromFile.name !== entry.name || fromFile.version !== entry.version) {
      throw new Error(`${source}: ${wheel.fileName} does not match ${wheel.packageName}==${wheel.version}`);
    }
    return entry;
  });
  return finishInventory(id, 'parakeet-lock', entries);
}

function pyannoteInventories(artifacts) {
  return Object.entries(artifacts).map(([platformKey, artifact]) => {
    const id = `pyannote-${platformKey}`;
    const requirements = artifact && artifact.pip && artifact.pip.requirements;
    if (!Array.isArray(requirements)) {
      throw new Error(`${id}: artifact has no pip requirements`);
    }
    const inventory = finishInventory(id, 'pyannote-direct-pins',
      requirements.map((requirement) => parseExactRequirement(requirement, `${id} (${artifact.id})`)));
    return { ...inventory, note: 'Direct pins only; audit the resolved closure with scripts/qualify-pyannote-runtime.py --resolve-only.' };
  });
}

function bootstrapInventory(downloads) {
  const wheel = downloads.pipWheel;
  if (!wheel || !wheel.url) {
    throw new Error('bootstrap: pipWheel download is missing');
  }
  const fileName = decodeURIComponent(new URL(wheel.url).pathname.split('/').pop());
  const { name, version } = wheelNameAndVersion(fileName, 'bootstrap pipWheel');
  return finishInventory('bootstrap', 'bootstrap-wheel', [pypiEntry(name, version, `bootstrap ${fileName}`)]);
}

function matchVersion(value, pattern, source) {
  const match = String(value || '').match(pattern);
  if (!match) {
    throw new Error(`${source}: cannot read a version from ${JSON.stringify(value)}`);
  }
  return match[1];
}

function nativeInventory(downloads) {
  const cpython = [
    ['pythonWin', /\/python-(\d+\.\d+\.\d+)-embed-amd64\.zip$/],
    ['pythonMac', /\/cpython-(\d+\.\d+\.\d+)\+\d{8}-aarch64-apple-darwin-install_only\.tar\.gz$/],
    ['pythonLinux', /\/cpython-(\d+\.\d+\.\d+)\+\d{8}-x86_64-unknown-linux-gnu-install_only\.tar\.gz$/],
  ].map(([key, pattern]) => ({
    ecosystem: 'native', name: 'cpython', version: matchVersion(downloads[key] && downloads[key].url, pattern, key), source: key,
  }));

  const sourceVersion = matchVersion(downloads.ffmpegSource && downloads.ffmpegSource.url,
    /\/ffmpeg-(\d+\.\d+(?:\.\d+)?)\.tar\.xz$/, 'ffmpegSource');
  const ffmpeg = [
    ['ffmpegWin', /\/download\/(\d+\.\d+(?:\.\d+)?)\/ffmpeg-\1-essentials_build\.zip$/],
    ['ffmpegMac', /\/download\/n(\d+\.\d+(?:\.\d+)?)-\d+\/ffmpeg-osx-arm64$/],
    ['ffmpegLinux', /\/download\/n(\d+\.\d+(?:\.\d+)?)-\d+\/ffmpeg-linux-x64$/],
  ].map(([key, pattern]) => {
    const version = matchVersion(downloads[key] && downloads[key].url, pattern, key);
    if (version !== sourceVersion) {
      throw new Error(`${key}: binary FFmpeg ${version} does not match the bundled corresponding source ${sourceVersion}`);
    }
    return { ecosystem: 'native', name: 'ffmpeg', version, source: key };
  });

  return {
    id: 'native',
    kind: 'native-runtime',
    note: 'Not covered by PyPI advisory databases; review upstream CPython/OpenSSL and FFmpeg security releases.',
    entries: [...cpython, ...ffmpeg],
  };
}

function loadInventories({ lockDir = PARAKEET_LOCK_DIR } = {}) {
  const { BUILD_DOWNLOADS } = require('../build/download-manifest');
  const { AI_MODEL_CATALOG } = require('../src/ai-addon-state');
  const lockFiles = fs.readdirSync(lockDir).filter((name) => name.endsWith('.lock.json')).sort();
  if (lockFiles.length === 0) {
    throw new Error(`no Parakeet locks found in ${lockDir}`);
  }
  return [
    ...lockFiles.map((fileName) => parakeetLockInventory(
      JSON.parse(fs.readFileSync(path.join(lockDir, fileName), 'utf8')),
      `parakeet-${fileName.replace(/\.lock\.json$/, '')}`,
    )),
    ...pyannoteInventories(AI_MODEL_CATALOG.diarization.dependencyArtifacts),
    bootstrapInventory(BUILD_DOWNLOADS),
    nativeInventory(BUILD_DOWNLOADS),
  ];
}

function toRequirements(inventory) {
  if (inventory.kind === 'native-runtime') {
    throw new Error(`${inventory.id}: native components have no PyPI advisory coverage; review them separately`);
  }
  return inventory.entries.map((entry) => `${entry.name}==${entry.auditVersion}\n`).join('');
}

function parseArgs(argv) {
  const args = { list: false, json: false, inventory: null, parakeetLock: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--list') args.list = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--inventory') args.inventory = argv[++index];
    else if (flag === '--parakeet-lock') args.parakeetLock = argv[++index];
    else if (flag === '--out') args.out = argv[++index];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let output;
  if (args.parakeetLock) {
    const lock = JSON.parse(fs.readFileSync(args.parakeetLock, 'utf8'));
    output = toRequirements(parakeetLockInventory(lock, path.basename(args.parakeetLock)));
  } else {
    const inventories = loadInventories();
    if (args.list) {
      output = inventories.map((inventory) => `${inventory.id}\t${inventory.kind}\t${inventory.entries.length}\n`).join('');
    } else if (args.json) {
      output = `${JSON.stringify(inventories, null, 2)}\n`;
    } else if (args.inventory) {
      const inventory = inventories.find((candidate) => candidate.id === args.inventory);
      if (!inventory) {
        throw new Error(`Unknown inventory ${args.inventory}; known: ${inventories.map((candidate) => candidate.id).join(', ')}`);
      }
      output = toRequirements(inventory);
    } else {
      throw new Error('Pass --list, --json, --inventory <id> or --parakeet-lock <path>.');
    }
  }
  if (args.out) {
    fs.writeFileSync(args.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`extract-dependency-inventory: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  bootstrapInventory,
  loadInventories,
  nativeInventory,
  normalizePackageName,
  parakeetLockInventory,
  parseExactRequirement,
  pyannoteInventories,
  toRequirements,
  wheelNameAndVersion,
};
