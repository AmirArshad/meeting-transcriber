'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
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
} = require('../../src/ai-addon/speakrs-cli-integrity');

const ELF_PT_DYNAMIC = 2;
const DEFAULT_INTERP = LINUX_X64_INTERPRETERS[0];
const WRONG_INTERP = '/lib/ld-linux.so.2';

function writePhdr(buffer, index, {
  type,
  flags,
  offset,
  vaddr,
  filesz,
  memsz,
  align,
}) {
  const base = ELF64_EHDR_SIZE + (index * ELF64_PHDR_SIZE);
  buffer.writeUInt32LE(type, base);
  buffer.writeUInt32LE(flags, base + 4);
  buffer.writeBigUInt64LE(BigInt(offset), base + 8);
  buffer.writeBigUInt64LE(BigInt(vaddr), base + 16);
  buffer.writeBigUInt64LE(BigInt(vaddr), base + 24);
  buffer.writeBigUInt64LE(BigInt(filesz), base + 32);
  buffer.writeBigUInt64LE(BigInt(memsz), base + 40);
  buffer.writeBigUInt64LE(BigInt(align), base + 48);
}

function writeElfIdent(buffer, { eiClass, eiVersion }) {
  buffer[0] = 0x7f;
  buffer.write('ELF', 1, 'ascii');
  buffer[4] = eiClass;
  buffer[5] = ELF_DATA_LSB;
  buffer[6] = eiVersion;
}

function writeElfFile(filePath, buf) {
  fs.writeFileSync(filePath, buf);
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeSpeakrsLinuxElfFixture(filePath, {
  kind = 'pie-executable',
  eiClass = ELF_CLASS_64,
  machine = ELF_MACHINE_X86_64,
} = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (kind === 'header-only' || eiClass === ELF_CLASS_32) {
    const buf = Buffer.alloc(ELF64_EHDR_SIZE, 0);
    writeElfIdent(buf, { eiClass: eiClass === ELF_CLASS_32 ? ELF_CLASS_32 : ELF_CLASS_64, eiVersion: ELF_VERSION_CURRENT });
    buf.writeUInt16LE(ELF_ET_DYN, 16);
    buf.writeUInt16LE(eiClass === ELF_CLASS_32 ? 3 : machine, 18);
    return writeElfFile(filePath, buf);
  }

  if (kind === 'truncated-program-table') {
    const buf = Buffer.alloc(ELF64_EHDR_SIZE + 20, 0);
    writeElfIdent(buf, { eiClass: ELF_CLASS_64, eiVersion: ELF_VERSION_CURRENT });
    buf.writeUInt16LE(ELF_ET_DYN, 16);
    buf.writeUInt16LE(machine, 18);
    buf.writeUInt32LE(ELF_VERSION_CURRENT, 20);
    buf.writeBigUInt64LE(0x401000n, 24);
    buf.writeBigUInt64LE(BigInt(ELF64_EHDR_SIZE), 32);
    buf.writeUInt16LE(ELF64_EHDR_SIZE, 52);
    buf.writeUInt16LE(ELF64_PHDR_SIZE, 54);
    buf.writeUInt16LE(4, 56);
    return writeElfFile(filePath, buf);
  }

  const interpPath = kind === 'missing-interpreter' ? WRONG_INTERP : DEFAULT_INTERP;
  const includeInterp = kind !== 'shared-object';
  const eiVersion = kind === 'bad-header-version' ? 0 : ELF_VERSION_CURRENT;
  const eVersion = kind === 'bad-header-version' ? 0 : ELF_VERSION_CURRENT;
  const eType = kind === 'et-exec' ? ELF_ET_EXEC : ELF_ET_DYN;
  const interp = Buffer.from(`${interpPath}\0`, 'ascii');
  const phnum = 2;
  const interpOffset = ELF64_EHDR_SIZE + (phnum * ELF64_PHDR_SIZE);
  const fileSize = includeInterp ? interpOffset + interp.length : interpOffset;
  const buf = Buffer.alloc(fileSize, 0);

  writeElfIdent(buf, { eiClass: ELF_CLASS_64, eiVersion });
  buf.writeUInt16LE(eType, 16);
  buf.writeUInt16LE(machine, 18);
  buf.writeUInt32LE(eVersion, 20);
  buf.writeBigUInt64LE(0x401000n, 24);
  buf.writeBigUInt64LE(BigInt(ELF64_EHDR_SIZE), 32);
  buf.writeUInt16LE(ELF64_EHDR_SIZE, 52);
  buf.writeUInt16LE(ELF64_PHDR_SIZE, 54);
  buf.writeUInt16LE(phnum, 56);

  if (includeInterp) {
    writePhdr(buf, 0, {
      type: ELF_PT_INTERP,
      flags: 4,
      offset: interpOffset,
      vaddr: interpOffset,
      filesz: interp.length,
      memsz: interp.length,
      align: 1,
    });
    interp.copy(buf, interpOffset);
  } else {
    writePhdr(buf, 0, {
      type: ELF_PT_DYNAMIC,
      flags: 4,
      offset: 0,
      vaddr: 0,
      filesz: 0,
      memsz: 0,
      align: 8,
    });
  }

  writePhdr(buf, 1, {
    type: ELF_PT_LOAD,
    flags: 5,
    offset: 0,
    vaddr: 0x400000,
    filesz: fileSize,
    memsz: fileSize,
    align: 0x1000,
  });

  return writeElfFile(filePath, buf);
}

module.exports = {
  writeSpeakrsLinuxElfFixture,
};
