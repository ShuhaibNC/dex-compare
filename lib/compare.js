"use strict";

const fs = require("fs");
const path = require("path");
const { classModifiers, fieldModifiers, methodModifiers } = require("./dex");
const { DexSet, dexSetFromBuffers, dexSetFromZipBuffer } = require("./dexset");
const { diffLines } = require("./mydiff");

// Status constants (mirror MT compare model tokens)
const S = { SAME: "same", ADDED: "added", REMOVED: "removed", MODIFIED: "modified" };

// Smali comments start with "#" -> stripped before any comparison.
function stripComments(lines) {
  return lines.filter((l) => !/^\s*#/.test(l));
}

function classKey(cls) { return cls.descriptor; }
function fieldKey(f) { return `${f.name}:${f.type}`; }
function methodKey(m) { return `${m.name}(${m.params.join("")})${m.returnType}`; }

function classHeaderText(cls) {
  const lines = [];
  const mods = classModifiers(cls.access);
  lines.push(`.class ${mods ? mods + " " : ""}${cls.descriptor}`);
  if (cls.superDescriptor) lines.push(`.super ${cls.superDescriptor}`);
  // .source (debug info) is intentionally ignored
  for (const i of cls.interfaces) lines.push(`.implements ${i}`);
  return lines;
}

function fieldText(f) {
  const mods = fieldModifiers(f.access);
  return `.field ${mods ? mods + " " : ""}${f.name}:${f.type}`;
}

function compareFields(left, right) {
  const l = new Map(), r = new Map();
  for (const f of left) l.set(fieldKey(f), f);
  for (const f of right) r.set(fieldKey(f), f);
  const keys = new Set([...l.keys(), ...r.keys()]);
  const out = [];
  for (const k of keys) {
    const a = l.get(k), b = r.get(k);
    if (a && !b) out.push({ key: k, status: S.REMOVED, leftText: fieldText(a), rightText: null });
    else if (!a && b) out.push({ key: k, status: S.ADDED, leftText: null, rightText: fieldText(b) });
    else if (a.access !== b.access) out.push({ key: k, status: S.MODIFIED, leftText: fieldText(a), rightText: fieldText(b), leftAccess: a.access, rightAccess: b.access });
    else out.push({ key: k, status: S.SAME, leftText: fieldText(a), rightText: fieldText(b) });
  }
  return out;
}

function compareMethods(left, right, dexL, dexR, onMethodCompared) {
  const l = new Map(), r = new Map();
  for (const m of left) l.set(methodKey(m), m);
  for (const m of right) r.set(methodKey(m), m);
  const keys = new Set([...l.keys(), ...r.keys()]);
  const out = [];
  for (const k of keys) {
    const a = l.get(k), b = r.get(k);
    if (a && !b) {
      out.push({ key: k, status: S.REMOVED, access: a.access, left: null, right: null });
    } else if (!a && b) {
      out.push({ key: k, status: S.ADDED, access: b.access, left: null, right: null });
    } else {
      const sameAccess = a.access === b.access;
      let bodyDiff = null;
      let sameBody = true;
      if ((a.code ? 1 : 0) !== (b.code ? 1 : 0)) {
        sameBody = false;
      } else if (a.code) {
        // normalized smali: ignores debug info, nops, register numbering/count,
        // comments, and equivalent instruction encodings (const/goto/invoke-range)
        const sa = stripComments(dexL.methodCompareLines(a));
        const sb = stripComments(dexR.methodCompareLines(b));
        bodyDiff = diffLines(sa, sb, 6000);
        if (bodyDiff === null) { sameBody = false; bodyDiff = "too-big"; }
        else sameBody = bodyDiff.every((row) => row.t === "eq");
      }
      if (sameAccess && sameBody) out.push({ key: k, status: S.SAME, access: a.access, left: null, right: null });
      else out.push({ key: k, status: S.MODIFIED, access: a.access, bAccess: b.access, accessChanged: !sameAccess, diff: bodyDiff, tooBig: bodyDiff === "too-big", left: null, right: null });
    }
    if (onMethodCompared) onMethodCompared();
  }
  return out;
}

function compareDex(dexL, dexR, leftName, rightName, onProgress) {
  const lmap = new Map(), rmap = new Map();
  for (const c of dexL.classes) lmap.set(classKey(c), c);
  for (const c of dexR.classes) rmap.set(classKey(c), c);
  const keys = new Set([...lmap.keys(), ...rmap.keys()]);
  let methodsTotal = 0;
  for (const k of keys) {
    const left = lmap.get(k), right = rmap.get(k);
    const methods = [
      ...(left ? [...left.directMethods, ...left.virtualMethods] : []),
      ...(right ? [...right.directMethods, ...right.virtualMethods] : []),
    ];
    methodsTotal += new Set(methods.map(methodKey)).size;
  }

  const classes = [];
  let methodsCompleted = 0;
  let classesCompleted = 0;
  const progressTotal = methodsTotal + keys.size;
  let lastProgressAt = 0;
  const reportProgress = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    onProgress({
      stage: "compare",
      current: methodsCompleted + classesCompleted,
      total: progressTotal,
      methodsCompleted,
      methodsTotal,
      classesCompleted,
      classesTotal: keys.size,
      detail: `${methodsCompleted}/${methodsTotal} methods · ${classesCompleted}/${keys.size} classes`,
    });
  };
  reportProgress(true);
  const summary = {
    classes: { same: 0, added: 0, removed: 0, modified: 0 },
    methods: { same: 0, added: 0, removed: 0, modified: 0 },
    fields: { same: 0, added: 0, removed: 0, modified: 0 },
  };

  for (const k of keys) {
    const a = lmap.get(k), b = rmap.get(k);
    if (a && !b) {
      const fields = compareFields([...a.staticFields, ...a.instanceFields], []);
      const methods = compareMethods([...a.directMethods, ...a.virtualMethods], [], a._dex, null, () => {
        methodsCompleted++;
        reportProgress(false);
      });
      summary.classes.removed++;
      tally(summary.fields, fields); tally(summary.methods, methods);
      classes.push({ descriptor: k, status: S.REMOVED, fields, methods, leftHeader: classHeaderText(a) });
    } else if (!a && b) {
      const fields = compareFields([], [...b.staticFields, ...b.instanceFields]);
      const methods = compareMethods([], [...b.directMethods, ...b.virtualMethods], null, b._dex, () => {
        methodsCompleted++;
        reportProgress(false);
      });
      summary.classes.added++;
      tally(summary.fields, fields); tally(summary.methods, methods);
      classes.push({ descriptor: k, status: S.ADDED, fields, methods, rightHeader: classHeaderText(b) });
    } else {
      const hl = stripComments(classHeaderText(a)), hr = stripComments(classHeaderText(b));
      const headerDiff = diffLines(hl, hr, 2000) || "too-big";
      const headerChanged = headerDiff === "too-big" || !headerDiff.every((r) => r.t === "eq");
      const fields = compareFields([...a.staticFields, ...a.instanceFields], [...b.staticFields, ...b.instanceFields]);
      const methods = compareMethods(
        [...a.directMethods, ...a.virtualMethods],
        [...b.directMethods, ...b.virtualMethods],
        a._dex,
        b._dex,
        () => {
          methodsCompleted++;
          reportProgress(false);
        }
      );
      const fieldChanged = fields.some((f) => f.status !== S.SAME);
      const methodChanged = methods.some((m) => m.status !== S.SAME);
      const changed = headerChanged || fieldChanged || methodChanged;
      summary.classes[changed ? "modified" : "same"]++;
      tally(summary.fields, fields); tally(summary.methods, methods);
      classes.push({
        descriptor: k, status: changed ? S.MODIFIED : S.SAME,
        headerChanged, headerDiff: headerChanged ? headerDiff : null, fields, methods,
      });
    }
    classesCompleted++;
    reportProgress(false);
  }

  // sort: modified, added, removed, same; keep same at end
  const order = { modified: 0, added: 1, removed: 2, same: 3 };
  classes.sort((x, y) => (order[x.status] - order[y.status]) || x.descriptor.localeCompare(y.descriptor));
  reportProgress(true);

  return {
    leftName, rightName,
    summary,
    classes,
    meta: {
      left: metaOf(dexL), right: metaOf(dexR),
    },
  };
}

function metaOf(set) {
  return {
    version: set.version,
    dexes: set.dexCount || 1,
    sources: set.sources || [],
    duplicates: set.duplicates || 0,
    classes: set.classes.length,
    methods: set.methodIds.length,
    fields: set.fieldIds.length,
    strings: set.strings.length,
  };
}

function tally(acc, items) {
  for (const it of items) acc[it.status]++;
}

class CompareSession {
  constructor(setL, setR, leftName, rightName, onProgress) {
    this.setL = setL; this.setR = setR;
    this.result = compareDex(setL, setR, leftName, rightName, onProgress);
    this._classL = setL.classMap;
    this._classR = setR.classMap;
  }
  getMethodSmali(side, classDescriptor, methodKey) {
    const map = side === "left" ? this._classL : this._classR;
    const cls = map.get(classDescriptor);
    if (!cls) return null;
    for (const m of cls.directMethods) if (methodKey === methodKeyOf(m)) return cls._dex.methodSmali(m);
    for (const m of cls.virtualMethods) if (methodKey === methodKeyOf(m)) return cls._dex.methodSmali(m);
    return null;
  }
  getClassSmali(side, classDescriptor) {
    const map = side === "left" ? this._classL : this._classR;
    const cls = map.get(classDescriptor);
    if (!cls) return null;
    return cls._dex.classSmali(cls);
  }
}

function methodKeyOf(m) { return `${m.name}(${m.params.join("")})${m.returnType}`; }

function compare(bufL, bufR, leftName, rightName) {
  const setL = dexSetFromBuffers([bufL], [leftName || "left.dex"]);
  const setR = dexSetFromBuffers([bufR], [rightName || "right.dex"]);
  return new CompareSession(setL, setR, leftName, rightName);
}

function compareSets(setL, setR, leftName, rightName, onProgress) {
  return new CompareSession(setL, setR, leftName, rightName, onProgress);
}

// Loads any side: a raw .dex, a plain .apk, or a bundle container
// (.xapk / .apks / .apkm) holding nested split APKs.
function loadSide(p, side, onProgress) {
  if (onProgress) onProgress({ stage: "load", current: 0, total: 1, detail: `Reading ${side} input` });
  const buf = fs.readFileSync(p);
  if (onProgress) onProgress({ stage: "load", current: 1, total: 1, detail: `Read ${side} input` });
  if (buf.length >= 8 && buf.toString("latin1", 0, 4) === "dex\n") {
    return dexSetFromBuffers([buf], [path.basename(p)], onProgress);
  }
  return dexSetFromZipBuffer(buf, path.basename(p), onProgress);
}

function comparePaths(leftPath, rightPath, onProgress) {
  const setL = loadSide(leftPath, "left", onProgress);
  const setR = loadSide(rightPath, "right", onProgress);
  return new CompareSession(setL, setR, path.basename(leftPath), path.basename(rightPath), onProgress);
}

module.exports = { compare, compareSets, comparePaths, CompareSession, compareDex, S, fieldText, methodKeyOf };
