'use strict';

const fs = require('fs');
const path = require('path');

const SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE = 'This AvaNevis install is incomplete. Reinstall AvaNevis.';
const SPEAKRS_VALIDATE_WAV_NAME = 'speakrs-two-speaker-16k.wav';
const WINDOWS_PE_MACHINE_AMD64 = 0x8664;
const MACHO_MAGIC_64_LE = 0xfeedfacf;
const MACHO_CPU_TYPE_ARM64 = 0x0100000c;

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

function readFilePrefix(filePath, length, fsModule = fs) {
  const statSync = bindFsMethod(fsModule, 'statSync');
  const stats = statSync ? statSync(filePath) : null;
  const size = stats && typeof stats.size === 'number' ? stats.size : 0;
  if (size < length) {
    throw new Error(`speakrs-cli is too small to inspect architecture (${size} bytes): ${filePath}`);
  }

  const openSync = bindFsMethod(fsModule, 'openSync');
  const readSync = bindFsMethod(fsModule, 'readSync');
  const closeSync = bindFsMethod(fsModule, 'closeSync');
  if (openSync && readSync && closeSync) {
    const fd = openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, 0);
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
  if (buffer.length < length) {
    throw new Error(`speakrs-cli is too small to inspect architecture (${buffer.length} bytes): ${filePath}`);
  }
  return buffer.subarray(0, length);
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
      /not Windows x64 PE|not arm64 \(Mach-O/.test(message)
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
  MACHO_CPU_TYPE_ARM64,
  MACHO_MAGIC_64_LE,
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  SPEAKRS_VALIDATE_WAV_NAME,
  WINDOWS_PE_MACHINE_AMD64,
  assertSpeakrsCliArchitecture,
  getBundledSpeakrsCliPath,
  getBundledSpeakrsValidateWavPath,
  getPackagedSpeakrsIntegrityError,
  getSpeakrsCliExecutableName,
  inspectPackagedSpeakrsLayout,
  inspectSpeakrsCliFile,
  inspectSpeakrsValidateWavFile,
  readMachOCpuType,
  readWindowsPeMachine,
};
