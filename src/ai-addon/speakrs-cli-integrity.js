'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE = 'This AvaNevis install is incomplete. Reinstall AvaNevis.';
const SPEAKRS_VALIDATE_WAV_NAME = 'speakrs-two-speaker-16k.wav';
const SPEAKRS_PACKAGED_INTEGRITY_MANIFEST_NAME = 'speakrs-integrity.json';
const WINDOWS_PE_MACHINE_AMD64 = 0x8664;
const MACHO_MAGIC_64_LE = 0xfeedfacf;
const MACHO_CPU_TYPE_ARM64 = 0x0100000c;
const ELF_CLASS_32 = 1;
const ELF_CLASS_64 = 2;
const ELF_DATA_LSB = 1;
const ELF_MACHINE_X86_64 = 62;
const ELF64_EHDR_SIZE = 64;
const ELF64_PHDR_SIZE = 56;
const ELF_VERSION_CURRENT = 1;
const ELF_ET_EXEC = 2;
const ELF_ET_DYN = 3;
const ELF_PT_LOAD = 1;
const ELF_PT_INTERP = 3;
const ELF_MAX_PHNUM = 128;
const ELF_MAX_INTERP_SIZE = 256;
const LINUX_X64_INTERPRETERS = Object.freeze([
  '/lib64/ld-linux-x86-64.so.2',
  '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
]);

function bindFsMethod(fsModule, methodName) {
  const method = fsModule && fsModule[methodName];
  return typeof method === 'function' ? method.bind(fsModule) : undefined;
}

function getSpeakrsCliExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
}

function getBundledSpeakrsCliPath({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (!resourcesPath) {
    return null;
  }
  return path.join(resourcesPath, 'bin', getSpeakrsCliExecutableName(platform));
}

function getBundledSpeakrsValidateWavPath({
  resourcesPath = process.resourcesPath,
} = {}) {
  if (!resourcesPath) {
    return null;
  }
  return path.join(resourcesPath, 'bin', SPEAKRS_VALIDATE_WAV_NAME);
}

function getBundledSpeakrsIntegrityManifestPath({
  resourcesPath = process.resourcesPath,
} = {}) {
  if (!resourcesPath) {
    return null;
  }
  return path.join(resourcesPath, 'bin', SPEAKRS_PACKAGED_INTEGRITY_MANIFEST_NAME);
}

function getSpeakrsPackagedPlatformKey(platform = process.platform) {
  if (platform === 'darwin') {
    return 'darwin-arm64';
  }
  if (platform === 'win32' || platform === 'linux') {
    return `${platform}-x64`;
  }
  return null;
}

function readPackagedSpeakrsIntegrityPins({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fsModule = fs,
} = {}) {
  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  const manifestPath = getBundledSpeakrsIntegrityManifestPath({ resourcesPath });
  const platformKey = getSpeakrsPackagedPlatformKey(platform);
  if (!readFileSync || !manifestPath || !platformKey) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pins = manifest?.version === 1 ? manifest?.platforms?.[platformKey] : null;
    for (const key of ['cli', 'validationWav']) {
      const pin = pins?.[key];
      if (!Number.isInteger(pin?.sizeBytes) || pin.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(pin?.sha256 || '')) {
        return null;
      }
    }
    return pins;
  } catch (_error) {
    return null;
  }
}

function matchesPackagedSpeakrsPin(filePath, pin, fsModule = fs) {
  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  if (!readFileSync || !pin) {
    return false;
  }
  try {
    const contents = readFileSync(filePath);
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    return buffer.length === pin.sizeBytes
      && crypto.createHash('sha256').update(buffer).digest('hex') === pin.sha256;
  } catch (_error) {
    return false;
  }
}

function readFileSlice(filePath, offset, length, fsModule = fs) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
    throw new Error(`speakrs-cli could not be read for architecture checks: ${filePath}`);
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end < offset) {
    throw new Error(`speakrs-cli could not be read for architecture checks: ${filePath}`);
  }

  const statSync = bindFsMethod(fsModule, 'statSync');
  const stats = statSync ? statSync(filePath) : null;
  const size = stats && typeof stats.size === 'number' ? stats.size : 0;
  if (size < end) {
    throw new Error(`speakrs-cli is too small to inspect architecture (${size} bytes): ${filePath}`);
  }

  const openSync = bindFsMethod(fsModule, 'openSync');
  const readSync = bindFsMethod(fsModule, 'readSync');
  const closeSync = bindFsMethod(fsModule, 'closeSync');
  if (openSync && readSync && closeSync) {
    const fd = openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      if (bytesRead < length) {
        throw new Error(`speakrs-cli could not be read for architecture checks: ${filePath}`);
      }
      return buffer;
    } finally {
      closeSync(fd);
    }
  }

  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  if (!readFileSync) {
    throw new Error(`speakrs-cli could not be read for architecture checks: ${filePath}`);
  }
  const data = readFileSync(filePath);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (buffer.length < end) {
    throw new Error(`speakrs-cli is too small to inspect architecture (${buffer.length} bytes): ${filePath}`);
  }
  return buffer.subarray(offset, end);
}

function readFilePrefix(filePath, length, fsModule = fs) {
  return readFileSlice(filePath, 0, length, fsModule);
}

function readElfU64(buffer, offset, filePath) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
  }
  return Number(value);
}

function isLinuxX64ElfExecutableFileOutput(fileOutput) {
  const text = String(fileOutput || '');
  if (!text || /shared object/i.test(text) || /invalid version/i.test(text)) {
    return false;
  }
  return /ELF 64-bit LSB (?:pie )?executable/i.test(text)
    && /(?:x86-64|x86_64)/i.test(text);
}

function readWindowsPeMachine(filePath, fsModule = fs) {
  const dos = readFilePrefix(filePath, 64, fsModule);
  if (dos.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`speakrs-cli is not a Windows PE executable: ${filePath}`);
  }
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < 64) {
    throw new Error(`speakrs-cli has an invalid PE header offset: ${filePath}`);
  }
  const openSync = bindFsMethod(fsModule, 'openSync');
  const readSync = bindFsMethod(fsModule, 'readSync');
  const closeSync = bindFsMethod(fsModule, 'closeSync');
  if (openSync && readSync && closeSync) {
    const fd = openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(6);
      const bytesRead = readSync(fd, header, 0, 6, peOffset);
      if (bytesRead < 6 || header.toString('ascii', 0, 4) !== 'PE\0\0') {
        throw new Error(`speakrs-cli is missing a PE signature: ${filePath}`);
      }
      return header.readUInt16LE(4);
    } finally {
      closeSync(fd);
    }
  }

  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  if (!readFileSync) {
    throw new Error(`speakrs-cli is missing a PE signature: ${filePath}`);
  }
  const data = readFileSync(filePath);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (buffer.length < peOffset + 6 || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`speakrs-cli is missing a PE signature: ${filePath}`);
  }
  return buffer.readUInt16LE(peOffset + 4);
}

function readMachOCpuType(filePath, fsModule = fs) {
  const header = readFilePrefix(filePath, 8, fsModule);
  const magic = header.readUInt32LE(0);
  if (magic !== MACHO_MAGIC_64_LE) {
    throw new Error(`speakrs-cli is not a thin 64-bit Mach-O binary: ${filePath}`);
  }
  return header.readUInt32LE(4);
}

function readElfMachine(filePath, fsModule = fs) {
  const ident = readFileSlice(filePath, 0, 16, fsModule);
  if (ident[0] !== 0x7f || ident.toString('ascii', 1, 4) !== 'ELF') {
    throw new Error(`speakrs-cli is not a Linux ELF executable: ${filePath}`);
  }
  const eiClass = ident[4];
  if (eiClass === ELF_CLASS_32) {
    throw new Error(`speakrs-cli is a 32-bit ELF binary: ${filePath}`);
  }
  if (eiClass !== ELF_CLASS_64) {
    throw new Error(`speakrs-cli has an unsupported ELF class (${eiClass}): ${filePath}`);
  }
  if (ident[5] !== ELF_DATA_LSB) {
    throw new Error(`speakrs-cli is not a little-endian ELF binary: ${filePath}`);
  }
  if (ident[6] !== ELF_VERSION_CURRENT) {
    throw new Error(`speakrs-cli has an unsupported ELF version: ${filePath}`);
  }

  const header = readFileSlice(filePath, 0, ELF64_EHDR_SIZE, fsModule);
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINE_X86_64) {
    throw new Error(
      `speakrs-cli is not Linux x86_64 ELF (machine 0x${machine.toString(16)}): ${filePath}`
    );
  }
  if (header.readUInt32LE(20) !== ELF_VERSION_CURRENT) {
    throw new Error(`speakrs-cli has an unsupported ELF version: ${filePath}`);
  }
  if (readElfU64(header, 24, filePath) === 0) {
    throw new Error(`speakrs-cli is missing a usable ELF entry point: ${filePath}`);
  }

  const eType = header.readUInt16LE(16);
  if (eType !== ELF_ET_EXEC && eType !== ELF_ET_DYN) {
    throw new Error(`speakrs-cli has an unsupported ELF type (${eType}): ${filePath}`);
  }
  if (header.readUInt16LE(52) !== ELF64_EHDR_SIZE || header.readUInt16LE(54) !== ELF64_PHDR_SIZE) {
    throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
  }

  const phoff = readElfU64(header, 32, filePath);
  const phnum = header.readUInt16LE(56);
  if (phoff < ELF64_EHDR_SIZE || phnum < 2 || phnum > ELF_MAX_PHNUM) {
    throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
  }
  const phTableSize = phnum * ELF64_PHDR_SIZE;
  const phEnd = phoff + phTableSize;
  if (!Number.isSafeInteger(phEnd) || phEnd < phoff) {
    throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
  }
  const phTable = readFileSlice(filePath, phoff, phTableSize, fsModule);
  const statSync = bindFsMethod(fsModule, 'statSync');
  const fileSize = statSync ? Number(statSync(filePath).size) || 0 : 0;

  let hasLoad = false;
  let interp = null;
  for (let index = 0; index < phnum; index += 1) {
    const phOffset = index * ELF64_PHDR_SIZE;
    const pType = phTable.readUInt32LE(phOffset);
    const pOffset = readElfU64(phTable, phOffset + 8, filePath);
    const pFilesz = readElfU64(phTable, phOffset + 32, filePath);
    const pMemsz = readElfU64(phTable, phOffset + 40, filePath);
    if (pType === ELF_PT_LOAD) {
      if (pMemsz === 0 || pFilesz > pMemsz) {
        throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
      }
      if (pFilesz > 0) {
        const loadEnd = pOffset + pFilesz;
        if (!Number.isSafeInteger(loadEnd) || loadEnd < pOffset || loadEnd > fileSize) {
          throw new Error(`speakrs-cli has invalid ELF program headers: ${filePath}`);
        }
      }
      hasLoad = true;
    }
    if (pType === ELF_PT_INTERP) {
      if (interp != null || pFilesz < 2 || pFilesz > ELF_MAX_INTERP_SIZE) {
        throw new Error(`speakrs-cli is missing a supported x86_64 ELF interpreter: ${filePath}`);
      }
      const raw = readFileSlice(filePath, pOffset, pFilesz, fsModule);
      if (raw[raw.length - 1] !== 0 || raw.subarray(0, raw.length - 1).includes(0)) {
        throw new Error(`speakrs-cli is missing a supported x86_64 ELF interpreter: ${filePath}`);
      }
      interp = raw.subarray(0, raw.length - 1).toString('utf8');
    }
  }
  if (!hasLoad) {
    throw new Error(`speakrs-cli is missing an ELF load segment: ${filePath}`);
  }
  if (!LINUX_X64_INTERPRETERS.includes(interp)) {
    if (eType === ELF_ET_DYN && interp == null) {
      throw new Error(`speakrs-cli is a Linux shared object, not an executable: ${filePath}`);
    }
    throw new Error(`speakrs-cli is missing a supported x86_64 ELF interpreter: ${filePath}`);
  }
  return machine;
}

function assertSpeakrsCliArchitecture(filePath, platform = process.platform, fsModule = fs) {
  if (platform === 'darwin') {
    const cpuType = readMachOCpuType(filePath, fsModule);
    if (cpuType !== MACHO_CPU_TYPE_ARM64) {
      throw new Error(
        `speakrs-cli is not arm64 (Mach-O cputype 0x${cpuType.toString(16)}): ${filePath}`
      );
    }
    return 'arm64';
  }
  if (platform === 'win32') {
    const machine = readWindowsPeMachine(filePath, fsModule);
    if (machine !== WINDOWS_PE_MACHINE_AMD64) {
      throw new Error(
        `speakrs-cli is not Windows x64 PE (machine 0x${machine.toString(16)}): ${filePath}`
      );
    }
    return 'x64';
  }
  if (platform === 'linux') {
    const machine = readElfMachine(filePath, fsModule);
    if (machine !== ELF_MACHINE_X86_64) {
      throw new Error(
        `speakrs-cli is not Linux x86_64 ELF (machine 0x${machine.toString(16)}): ${filePath}`
      );
    }
    return 'x64';
  }
  throw new Error(`Unsupported Speakrs packaging platform: ${platform}`);
}

function describeStats(filePath, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!filePath || !existsSync || !statSync || !existsSync(filePath)) {
    return { exists: false, isFile: false, isDirectory: false, size: 0, mode: null };
  }
  const stats = statSync(filePath);
  const isDirectory = typeof stats.isDirectory === 'function' ? stats.isDirectory() : false;
  const isFile = typeof stats.isFile === 'function' ? stats.isFile() : !isDirectory;
  return {
    exists: true,
    isFile,
    isDirectory,
    size: typeof stats.size === 'number' ? stats.size : 0,
    mode: typeof stats.mode === 'number' ? stats.mode : null,
  };
}

function inspectSpeakrsCliFile(filePath, {
  platform = process.platform,
  fsModule = fs,
} = {}) {
  if (!filePath) {
    return { ok: false, reason: 'missing', filePath: null };
  }
  const baseName = path.basename(filePath);
  if (baseName.toLowerCase().endsWith('.py')) {
    return { ok: false, reason: 'python-wrapper', filePath };
  }
  if (baseName !== getSpeakrsCliExecutableName(platform)) {
    return { ok: false, reason: 'wrong-basename', filePath };
  }
  if (path.dirname(filePath) === '.') {
    return { ok: false, reason: 'path-lookup', filePath };
  }

  const stats = describeStats(filePath, fsModule);
  if (!stats.exists) {
    return { ok: false, reason: 'missing', filePath };
  }
  if (stats.isDirectory) {
    return { ok: false, reason: 'directory', filePath };
  }
  if (!stats.isFile) {
    return { ok: false, reason: 'not-a-file', filePath };
  }
  if (!Number.isFinite(stats.size) || stats.size <= 0) {
    return { ok: false, reason: 'empty', filePath };
  }
  if (platform !== 'win32' && stats.mode != null && (stats.mode & 0o111) === 0) {
    return { ok: false, reason: 'non-executable', filePath };
  }

  try {
    assertSpeakrsCliArchitecture(filePath, platform, fsModule);
  } catch (error) {
    const message = String(error && error.message || '');
    if (
      /not Windows x64 PE|not arm64 \(Mach-O|not Linux x86_64 ELF|32-bit ELF/.test(message)
    ) {
      return { ok: false, reason: 'wrong-architecture', filePath, detail: message };
    }
    return { ok: false, reason: 'malformed', filePath, detail: message };
  }

  return { ok: true, reason: null, filePath };
}

function inspectSpeakrsValidateWavFile(filePath, {
  fsModule = fs,
} = {}) {
  if (!filePath) {
    return { ok: false, reason: 'missing', filePath: null };
  }
  if (path.basename(filePath) !== SPEAKRS_VALIDATE_WAV_NAME) {
    return { ok: false, reason: 'wrong-basename', filePath };
  }
  const stats = describeStats(filePath, fsModule);
  if (!stats.exists) {
    return { ok: false, reason: 'missing', filePath };
  }
  if (stats.isDirectory) {
    return { ok: false, reason: 'directory', filePath };
  }
  if (!stats.isFile) {
    return { ok: false, reason: 'not-a-file', filePath };
  }
  if (!Number.isFinite(stats.size) || stats.size <= 0) {
    return { ok: false, reason: 'empty', filePath };
  }
  return { ok: true, reason: null, filePath };
}

function inspectPackagedSpeakrsLayout({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fsModule = fs,
} = {}) {
  const cliPath = getBundledSpeakrsCliPath({ platform, resourcesPath });
  const wavPath = getBundledSpeakrsValidateWavPath({ resourcesPath });
  const cli = inspectSpeakrsCliFile(cliPath, { platform, fsModule });
  if (!cli.ok) {
    return {
      ok: false,
      kind: 'cli',
      reason: cli.reason,
      cliPath,
      wavPath,
      detail: cli.detail || null,
    };
  }
  const wav = inspectSpeakrsValidateWavFile(wavPath, { fsModule });
  if (!wav.ok) {
    return {
      ok: false,
      kind: 'fixture',
      reason: wav.reason,
      cliPath,
      wavPath,
      detail: wav.detail || null,
    };
  }
  // On macOS, the signed app bundle's code seal protects Resources/bin; these
  // build-generated pins additionally reject a substituted file before spawn.
  const pins = readPackagedSpeakrsIntegrityPins({ platform, resourcesPath, fsModule });
  if (!pins) {
    return {
      ok: false,
      kind: 'cli',
      reason: 'missing-pin',
      cliPath,
      wavPath,
      detail: null,
    };
  }
  if (!matchesPackagedSpeakrsPin(cliPath, pins.cli, fsModule)) {
    return {
      ok: false,
      kind: 'cli',
      reason: 'checksum-mismatch',
      cliPath,
      wavPath,
      detail: null,
    };
  }
  if (!matchesPackagedSpeakrsPin(wavPath, pins.validationWav, fsModule)) {
    return {
      ok: false,
      kind: 'fixture',
      reason: 'checksum-mismatch',
      cliPath,
      wavPath,
      detail: null,
    };
  }
  return {
    ok: true,
    kind: null,
    reason: null,
    cliPath,
    wavPath,
  };
}

function getPackagedSpeakrsIntegrityError({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fsModule = fs,
} = {}) {
  const result = inspectPackagedSpeakrsLayout({ platform, resourcesPath, fsModule });
  if (result.ok) {
    return null;
  }
  const error = new Error(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
  error.code = 'SPEAKRS_PACKAGED_CLI_MISSING';
  error.reason = result.reason;
  error.kind = result.kind;
  return error;
}

module.exports = {
  ELF64_EHDR_SIZE,
  ELF64_PHDR_SIZE,
  ELF_CLASS_32,
  ELF_CLASS_64,
  ELF_DATA_LSB,
  ELF_ET_DYN,
  ELF_ET_EXEC,
  ELF_MACHINE_X86_64,
  ELF_PT_INTERP,
  ELF_PT_LOAD,
  ELF_VERSION_CURRENT,
  LINUX_X64_INTERPRETERS,
  MACHO_CPU_TYPE_ARM64,
  MACHO_MAGIC_64_LE,
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  SPEAKRS_VALIDATE_WAV_NAME,
  WINDOWS_PE_MACHINE_AMD64,
  assertSpeakrsCliArchitecture,
  getBundledSpeakrsCliPath,
  getBundledSpeakrsIntegrityManifestPath,
  getBundledSpeakrsValidateWavPath,
  getPackagedSpeakrsIntegrityError,
  getSpeakrsCliExecutableName,
  getSpeakrsPackagedPlatformKey,
  inspectPackagedSpeakrsLayout,
  inspectSpeakrsCliFile,
  inspectSpeakrsValidateWavFile,
  isLinuxX64ElfExecutableFileOutput,
  readElfMachine,
  readMachOCpuType,
  readWindowsPeMachine,
  SPEAKRS_PACKAGED_INTEGRITY_MANIFEST_NAME,
};
