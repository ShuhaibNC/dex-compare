"use strict";

const fs = require("fs");
const { DexFile } = require("./dex");
const { readZipEntries, extractEntry } = require("./zip");

const LOC_SIG = 0x04034b50;

// A DexSet "merges" all DEX files of one side (APK or single .dex) into one
// logical class space. Each class is tagged with the DexFile it came from so
// that smali disassembly can use the correct string/type/method tables.
class DexSet {
  constructor(dexes, sources) {
    this.dexes = dexes;
    this.sources = sources || dexes.map((d) => d.name);
    this.classes = [];
    this.classMap = new Map();
    this.duplicates = 0;
    for (const dex of dexes) {
      for (const cls of dex.classes) {
        cls._dex = dex;
        if (this.classMap.has(cls.descriptor)) { this.duplicates++; continue; }
        this.classMap.set(cls.descriptor, cls);
        this.classes.push(cls);
      }
    }
    this.dexCount = dexes.length;
    this.version = dexes.length ? dexes[0].version : "?";
    this.methodIds = { length: 0 };
    this.fieldIds = { length: 0 };
    this.strings = { length: 0 };
    for (const dex of dexes) {
      this.methodIds.length += dex.methodIds.length;
      this.fieldIds.length += dex.fieldIds.length;
      this.strings.length += dex.strings.length;
    }
    this._classByName = null;
  }
  methodSmali(cls, m) { return cls._dex.methodSmali(m); }
  classSmali(cls) { return cls._dex.classSmali(cls); }
}

function dexSetFromBuffers(buffers, names) {
  const dexes = buffers.map((b, i) => new DexFile(b, names && names[i] ? names[i] : `classes${i || ""}.dex`));
  return new DexSet(dexes, names);
}

function dexNum(name) {
  const m = /^classes(\d*)\.dex$/i.exec(name);
  if (!m) return 1e9;
  return m[1] ? parseInt(m[1], 10) : 1;
}
function isClassesDex(name) { return /^classes\d*\.dex$/i.test(name); }
function isNestedApk(name) { return /\.apk$/i.test(name); }
// base/master apks first, then alphabetically (splits/standalones/universal)
function apkRank(name) {
  const n = name.toLowerCase();
  if (/(^|\/)base(-master)?\.apk$/.test(n) || /(^|\/)base\.apk$/.test(n)) return 0;
  if (n.endsWith("/universal.apk") || n === "universal.apk") return 1;
  if (/(^|\/)base-[a-z]+\.apk$/.test(n)) return 2;
  return 3;
}

// Extract all classes*.dex from one APK/ZIP buffer. Invalid entries are pushed
// to `skipped` (with `label` prefix) instead of aborting the whole archive.
function dexEntriesFromZip(buf, skipped, label) {
  const entries = readZipEntries(buf);
  let dexEntries = entries.filter((e) => isClassesDex(e.name));
  if (!dexEntries.length) dexEntries = entries.filter((e) => /\.dex$/i.test(e.name));
  dexEntries.sort((a, b) => dexNum(a.name) - dexNum(b.name) || a.name.localeCompare(b.name));
  const dexes = [], names = [];
  for (const e of dexEntries) {
    let data;
    try { data = extractEntry(buf, e); } catch (err) { skipped.push(`${label}${e.name}: ${err.message}`); continue; }
    if (data.length < 8 || data.toString("latin1", 0, 4) !== "dex\n") { skipped.push(`${label}${e.name}: not a DEX (bad magic)`); continue; }
    try { dexes.push(new DexFile(data, e.name)); names.push(e.name); }
    catch (err) { skipped.push(`${label}${e.name}: ${err.message}`); }
  }
  return { dexes, names };
}

// Load a ZIP container that is either a plain APK or a bundle
// (XAPK / APKS / APKM) holding nested split APKs.
function dexSetFromZipBuffer(buf, label) {
  label = label || "archive";
  let entries;
  try { entries = readZipEntries(buf); } catch (e) {
    throw new Error(`Cannot read "${label}": ${e.message}`);
  }
  const skipped = [];
  const dexes = [], names = [];

  // A plain APK has classes*.dex at its root -> always preferred. Only when
  // there is no top-level dex is the archive treated as an XAPK/APKS/APKM
  // bundle holding nested split APKs.
  let rootDex = entries.filter((e) => isClassesDex(e.name));
  if (!rootDex.length) rootDex = entries.filter((e) => /\.dex$/i.test(e.name));
  const nested = entries.filter((e) => isNestedApk(e.name) && !/^META-INF\//i.test(e.name));

  if (rootDex.length || !nested.length) {
    const sub = dexEntriesFromZip(buf, skipped, "");
    if (!sub.dexes.length) throw new Error(`No .dex files found inside "${label}"` + hint(skipped));
    dexes.push(...sub.dexes); names.push(...sub.names);
  } else {
    nested.sort((a, b) => apkRank(a.name) - apkRank(b.name) || a.name.localeCompare(b.name));
    for (const e of nested) {
      let apkBuf;
      try { apkBuf = extractEntry(buf, e); } catch (err) { skipped.push(`${e.name}: ${err.message}`); continue; }
      if (apkBuf.length < 4 || apkBuf.readUInt32LE(0) !== LOC_SIG) {
        skipped.push(`${e.name}: not a ZIP/APK (encrypted or corrupt bundle entry?)`);
        continue;
      }
      let sub;
      try { sub = dexEntriesFromZip(apkBuf, skipped, e.name + "!"); }
      catch (err) { skipped.push(`${e.name}: ${err.message}`); continue; }
      for (let i = 0; i < sub.dexes.length; i++) { dexes.push(sub.dexes[i]); names.push(e.name + "!" + sub.names[i]); }
    }
    if (!dexes.length) {
      throw new Error(`No valid DEX files inside bundle "${label}"` + hint(skipped));
    }
  }

  const set = new DexSet(dexes, names);
  set.skipped = skipped;
  return set;
}

function hint(skipped) {
  return skipped.length ? ` (${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? `; +${skipped.length - 3} more` : ""})` : "";
}

function dexSetFromApk(apkPath) {
  return dexSetFromZipBuffer(fs.readFileSync(apkPath), apkPath);
}

module.exports = { DexSet, dexSetFromBuffers, dexSetFromZipBuffer, dexSetFromApk };
