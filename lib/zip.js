"use strict";

const zlib = require("zlib");

// Minimal ZIP reader (APK = ZIP). Supports stored + deflate, and ZIP64 sizes.
// Returns entry descriptors; extractEntry(buf, entry) returns a Buffer.

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("Not a ZIP/APK (no EOCD record)");
  let total = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);

  // ZIP64: locate EOCD64 locator just before EOCD
  const locOff = eocd - 20;
  if (locOff >= 0 && buf.readUInt32LE(locOff) === EOCD64_LOC_SIG) {
    const eocd64Off = Number(buf.readBigUInt64LE(locOff + 8));
    if (buf.readUInt32LE(eocd64Off) === EOCD64_SIG) {
      total = Number(buf.readBigUInt64LE(eocd64Off + 32));
      cdSize = Number(buf.readBigUInt64LE(eocd64Off + 40));
      cdOff = Number(buf.readBigUInt64LE(eocd64Off + 48));
    }
  }

  const entries = [];
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p + 46 <= end && buf.readUInt32LE(p) === CEN_SIG) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = buf.readUInt16LE(e);
        const sz = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOff === 0xffffffff) { localOff = Number(buf.readBigUInt64LE(q)); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }

    entries.push({ name, method, flags, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  if (entry.flags & 0x1) throw new Error("Encrypted ZIP entry: " + entry.name);
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== LOC_SIG) throw new Error("Bad local header for " + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataOff = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    const out = zlib.inflateRawSync(raw);
    return entry.uncompSize ? out.subarray(0, entry.uncompSize) : out;
  }
  throw new Error("Unsupported ZIP compression method " + entry.method + " for " + entry.name);
}

module.exports = { readZipEntries, extractEntry };
