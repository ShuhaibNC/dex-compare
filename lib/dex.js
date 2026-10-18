"use strict";

// ---------------------------------------------------------------------------
// Minimal dependency-free DEX parser + smali disassembler.
// Model is designed for structural comparison (classes / methods / fields).
// ---------------------------------------------------------------------------

const NO_INDEX = 0xffffffff;

function readU16(b, o) { return b.readUInt16LE(o); }
function readI16(b, o) { return b.readInt16LE(o); }
function readU32(b, o) { return b.readUInt32LE(o); }
function readI32(b, o) { return b.readInt32LE(o); }

function readUleb128(b, o) {
  let result = 0, shift = 0, byte;
  do { byte = b[o++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return [result >>> 0, o];
}
function readSleb128(b, o) {
  let result = 0, shift = 0, byte;
  do { byte = b[o++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  if (shift < 32 && (byte & 0x40)) result |= -(1 << shift);
  return [result | 0, o];
}
function readUleb128p1(b, o) {
  const [v, p] = readUleb128(b, o);
  return [v - 1, p];
}

// MUTF-8 decode of a string_data_item, returns { value, end }
function readString(b, off) {
  let p = off;
  let [, p2] = readUleb128(b, p); // utf16 length (unused)
  p = p2;
  let out = "";
  while (b[p] !== 0) {
    const c = b[p];
    if (c < 0x80) { out += String.fromCharCode(c); p += 1; }
    else if ((c & 0xe0) === 0xc0) { out += String.fromCharCode(((c & 0x1f) << 6) | (b[p + 1] & 0x3f)); p += 2; }
    else if ((c & 0xf0) === 0xe0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[p + 1] & 0x3f) << 6) | (b[p + 2] & 0x3f));
      p += 3;
    } else { out += "\uFFFD"; p += 1; }
  }
  return { value: out, end: p + 1 };
}

// ---------------------------------------------------------------------------
// Access flags
// ---------------------------------------------------------------------------
const ACC = {
  PUBLIC: 0x1, PRIVATE: 0x2, PROTECTED: 0x4, STATIC: 0x8, FINAL: 0x10,
  SYNCHRONIZED: 0x20, SUPER: 0x20, VOLATILE: 0x40, BRIDGE: 0x40,
  TRANSIENT: 0x80, VARARGS: 0x80, NATIVE: 0x100, INTERFACE: 0x200,
  ABSTRACT: 0x400, STRICT: 0x800, SYNTHETIC: 0x1000, ANNOTATION: 0x2000,
  ENUM: 0x4000, CONSTRUCTOR: 0x10000, DECLARED_SYNCHRONIZED: 0x20000,
};

function classModifiers(f) {
  const m = [];
  if (f & ACC.PUBLIC) m.push("public");
  if (f & ACC.FINAL) m.push("final");
  if (f & ACC.INTERFACE) m.push("interface");
  if (f & ACC.ABSTRACT) m.push("abstract");
  if (f & ACC.SYNTHETIC) m.push("synthetic");
  if (f & ACC.ANNOTATION) m.push("annotation");
  if (f & ACC.ENUM) m.push("enum");
  return m.join(" ");
}
function fieldModifiers(f) {
  const m = [];
  if (f & ACC.PUBLIC) m.push("public");
  if (f & ACC.PRIVATE) m.push("private");
  if (f & ACC.PROTECTED) m.push("protected");
  if (f & ACC.STATIC) m.push("static");
  if (f & ACC.FINAL) m.push("final");
  if (f & ACC.VOLATILE) m.push("volatile");
  if (f & ACC.TRANSIENT) m.push("transient");
  if (f & ACC.SYNTHETIC) m.push("synthetic");
  if (f & ACC.ENUM) m.push("enum");
  return m.join(" ");
}
function methodModifiers(f) {
  const m = [];
  if (f & ACC.PUBLIC) m.push("public");
  if (f & ACC.PRIVATE) m.push("private");
  if (f & ACC.PROTECTED) m.push("protected");
  if (f & ACC.STATIC) m.push("static");
  if (f & ACC.FINAL) m.push("final");
  if (f & ACC.SYNCHRONIZED) m.push("synchronized");
  if (f & ACC.BRIDGE) m.push("bridge");
  if (f & ACC.VARARGS) m.push("varargs");
  if (f & ACC.NATIVE) m.push("native");
  if (f & ACC.ABSTRACT) m.push("abstract");
  if (f & ACC.STRICT) m.push("strictfp");
  if (f & ACC.SYNTHETIC) m.push("synthetic");
  if (f & ACC.CONSTRUCTOR) m.push("constructor");
  if (f & ACC.DECLARED_SYNCHRONIZED) m.push("declared-synchronized");
  return m.join(" ");
}

// ---------------------------------------------------------------------------
// Opcode table
// ---------------------------------------------------------------------------
// fmt examples: "10x","12x","11n","11x","10t","20t","22x","21t","21s","21h",
//               "21c","23x","22b","22t","22s","22c","30t","31i","31t","31c",
//               "32x","35c","3rc","51l","00x"
const OPCODES = {
  0x00: ["nop", "10x"],
  0x01: ["move", "12x"], 0x02: ["move/from16", "22x"], 0x03: ["move/16", "32x"],
  0x04: ["move-wide", "12x"], 0x05: ["move-wide/from16", "22x"], 0x06: ["move-wide/16", "32x"],
  0x07: ["move-object", "12x"], 0x08: ["move-object/from16", "22x"], 0x09: ["move-object/16", "32x"],
  0x0a: ["move-result", "11x"], 0x0b: ["move-result-wide", "11x"], 0x0c: ["move-result-object", "11x"],
  0x0d: ["move-exception", "11x"],
  0x0e: ["return-void", "10x"], 0x0f: ["return", "11x"], 0x10: ["return-wide", "11x"], 0x11: ["return-object", "11x"],
  0x12: ["const/4", "11n"], 0x13: ["const/16", "21s"], 0x14: ["const", "31i"], 0x15: ["const/high16", "21h"],
  0x16: ["const-wide/16", "21s"], 0x17: ["const-wide/32", "31i"], 0x18: ["const-wide", "51l"], 0x19: ["const-wide/high16", "21h"],
  0x1a: ["const-string", "21c"], 0x1b: ["const-string/jumbo", "31c"], 0x1c: ["const-class", "21c"],
  0x1d: ["monitor-enter", "11x"], 0x1e: ["monitor-exit", "11x"],
  0x1f: ["check-cast", "21c"], 0x20: ["instance-of", "22c"], 0x21: ["array-length", "12x"],
  0x22: ["new-instance", "21c"], 0x23: ["new-array", "22c"],
  0x24: ["filled-new-array", "35c"], 0x25: ["filled-new-array/range", "3rc"], 0x26: ["fill-array-data", "31t"],
  0x27: ["throw", "11x"], 0x28: ["goto", "10t"], 0x29: ["goto/16", "20t"], 0x2a: ["goto/32", "30t"],
  0x2b: ["packed-switch", "31t"], 0x2c: ["sparse-switch", "31t"],
  0x2d: ["cmpl-float", "23x"], 0x2e: ["cmpg-float", "23x"], 0x2f: ["cmpl-double", "23x"],
  0x30: ["cmpg-double", "23x"], 0x31: ["cmp-long", "23x"],
  0x32: ["if-eq", "22t"], 0x33: ["if-ne", "22t"], 0x34: ["if-lt", "22t"], 0x35: ["if-ge", "22t"],
  0x36: ["if-gt", "22t"], 0x37: ["if-le", "22t"],
  0x38: ["if-eqz", "21t"], 0x39: ["if-nez", "21t"], 0x3a: ["if-ltz", "21t"], 0x3b: ["if-gez", "21t"],
  0x3c: ["if-gtz", "21t"], 0x3d: ["if-lez", "21t"],
  0x44: ["aget", "23x"], 0x45: ["aget-wide", "23x"], 0x46: ["aget-object", "23x"], 0x47: ["aget-boolean", "23x"],
  0x48: ["aget-byte", "23x"], 0x49: ["aget-char", "23x"], 0x4a: ["aget-short", "23x"],
  0x4b: ["aput", "23x"], 0x4c: ["aput-wide", "23x"], 0x4d: ["aput-object", "23x"], 0x4e: ["aput-boolean", "23x"],
  0x4f: ["aput-byte", "23x"], 0x50: ["aput-char", "23x"], 0x51: ["aput-short", "23x"],
  0x52: ["iget", "22c"], 0x53: ["iget-wide", "22c"], 0x54: ["iget-object", "22c"], 0x55: ["iget-boolean", "22c"],
  0x56: ["iget-byte", "22c"], 0x57: ["iget-char", "22c"], 0x58: ["iget-short", "22c"],
  0x59: ["iput", "22c"], 0x5a: ["iput-wide", "22c"], 0x5b: ["iput-object", "22c"], 0x5c: ["iput-boolean", "22c"],
  0x5d: ["iput-byte", "22c"], 0x5e: ["iput-char", "22c"], 0x5f: ["iput-short", "22c"],
  0x60: ["sget", "21c"], 0x61: ["sget-wide", "21c"], 0x62: ["sget-object", "21c"], 0x63: ["sget-boolean", "21c"],
  0x64: ["sget-byte", "21c"], 0x65: ["sget-char", "21c"], 0x66: ["sget-short", "21c"],
  0x67: ["sput", "21c"], 0x68: ["sput-wide", "21c"], 0x69: ["sput-object", "21c"], 0x6a: ["sput-boolean", "21c"],
  0x6b: ["sput-byte", "21c"], 0x6c: ["sput-char", "21c"], 0x6d: ["sput-short", "21c"],
  0x6e: ["invoke-virtual", "35c"], 0x6f: ["invoke-super", "35c"], 0x70: ["invoke-direct", "35c"],
  0x71: ["invoke-static", "35c"], 0x72: ["invoke-interface", "35c"],
  0x74: ["invoke-virtual/range", "3rc"], 0x75: ["invoke-super/range", "3rc"], 0x76: ["invoke-direct/range", "3rc"],
  0x77: ["invoke-static/range", "3rc"], 0x78: ["invoke-interface/range", "3rc"],
  0x7b: ["neg-int", "12x"], 0x7c: ["not-int", "12x"], 0x7d: ["neg-long", "12x"], 0x7e: ["not-long", "12x"],
  0x7f: ["neg-float", "12x"], 0x80: ["neg-double", "12x"], 0x81: ["int-to-long", "12x"], 0x82: ["int-to-float", "12x"],
  0x83: ["int-to-double", "12x"], 0x84: ["long-to-int", "12x"], 0x85: ["long-to-float", "12x"], 0x86: ["long-to-double", "12x"],
  0x87: ["float-to-int", "12x"], 0x88: ["float-to-long", "12x"], 0x89: ["float-to-double", "12x"],
  0x8a: ["double-to-int", "12x"], 0x8b: ["double-to-long", "12x"], 0x8c: ["double-to-float", "12x"],
  0x8d: ["int-to-byte", "12x"], 0x8e: ["int-to-char", "12x"], 0x8f: ["int-to-short", "12x"],
  0x90: ["add-int", "23x"], 0x91: ["sub-int", "23x"], 0x92: ["mul-int", "23x"], 0x93: ["div-int", "23x"],
  0x94: ["rem-int", "23x"], 0x95: ["and-int", "23x"], 0x96: ["or-int", "23x"], 0x97: ["xor-int", "23x"],
  0x98: ["shl-int", "23x"], 0x99: ["shr-int", "23x"], 0x9a: ["ushr-int", "23x"],
  0x9b: ["add-long", "23x"], 0x9c: ["sub-long", "23x"], 0x9d: ["mul-long", "23x"], 0x9e: ["div-long", "23x"],
  0x9f: ["rem-long", "23x"], 0xa0: ["and-long", "23x"], 0xa1: ["or-long", "23x"], 0xa2: ["xor-long", "23x"],
  0xa3: ["shl-long", "23x"], 0xa4: ["shr-long", "23x"], 0xa5: ["ushr-long", "23x"],
  0xa6: ["add-float", "23x"], 0xa7: ["sub-float", "23x"], 0xa8: ["mul-float", "23x"], 0xa9: ["div-float", "23x"],
  0xaa: ["rem-float", "23x"],
  0xab: ["add-double", "23x"], 0xac: ["sub-double", "23x"], 0xad: ["mul-double", "23x"], 0xae: ["div-double", "23x"],
  0xaf: ["rem-double", "23x"],
  0xb0: ["add-int/2addr", "12x"], 0xb1: ["sub-int/2addr", "12x"], 0xb2: ["mul-int/2addr", "12x"], 0xb3: ["div-int/2addr", "12x"],
  0xb4: ["rem-int/2addr", "12x"], 0xb5: ["and-int/2addr", "12x"], 0xb6: ["or-int/2addr", "12x"], 0xb7: ["xor-int/2addr", "12x"],
  0xb8: ["shl-int/2addr", "12x"], 0xb9: ["shr-int/2addr", "12x"], 0xba: ["ushr-int/2addr", "12x"],
  0xbb: ["add-long/2addr", "12x"], 0xbc: ["sub-long/2addr", "12x"], 0xbd: ["mul-long/2addr", "12x"], 0xbe: ["div-long/2addr", "12x"],
  0xbf: ["rem-long/2addr", "12x"], 0xc0: ["and-long/2addr", "12x"], 0xc1: ["or-long/2addr", "12x"], 0xc2: ["xor-long/2addr", "12x"],
  0xc3: ["shl-long/2addr", "12x"], 0xc4: ["shr-long/2addr", "12x"], 0xc5: ["ushr-long/2addr", "12x"],
  0xc6: ["add-float/2addr", "12x"], 0xc7: ["sub-float/2addr", "12x"], 0xc8: ["mul-float/2addr", "12x"], 0xc9: ["div-float/2addr", "12x"],
  0xca: ["rem-float/2addr", "12x"],
  0xcb: ["add-double/2addr", "12x"], 0xcc: ["sub-double/2addr", "12x"], 0xcd: ["mul-double/2addr", "12x"], 0xce: ["div-double/2addr", "12x"],
  0xcf: ["rem-double/2addr", "12x"],
  0xd0: ["add-int/lit16", "22s"], 0xd1: ["rsub-int", "22s"], 0xd2: ["mul-int/lit16", "22s"], 0xd3: ["div-int/lit16", "22s"],
  0xd4: ["rem-int/lit16", "22s"], 0xd5: ["and-int/lit16", "22s"], 0xd6: ["or-int/lit16", "22s"], 0xd7: ["xor-int/lit16", "22s"],
  0xd8: ["add-int/lit8", "22b"], 0xd9: ["rsub-int/lit8", "22b"], 0xda: ["mul-int/lit8", "22b"], 0xdb: ["div-int/lit8", "22b"],
  0xdc: ["rem-int/lit8", "22b"], 0xdd: ["and-int/lit8", "22b"], 0xde: ["or-int/lit8", "22b"], 0xdf: ["xor-int/lit8", "22b"],
  0xe0: ["shl-int/lit8", "22b"], 0xe1: ["shr-int/lit8", "22b"], 0xe2: ["ushr-int/lit8", "22b"],
  0xfa: ["invoke-polymorphic", "45cc"], 0xfb: ["invoke-polymorphic/range", "4rcc"],
  0xfc: ["invoke-custom", "35c"], 0xfd: ["invoke-custom/range", "3rc"],
  0xfe: ["const-method-handle", "21c"], 0xff: ["const-method-type", "21c"],
};

// instruction width in 16-bit units
function insnWidth(b, q) {
  const op = b[q];
  const ent = OPCODES[op];
  if (!ent) return 1;
  const fmt = ent[1];
  switch (fmt) {
    case "10x": case "12x": case "11n": case "11x": case "10t": return 1;
    case "20t": case "22x": case "21t": case "21s": case "21h": case "21c": return 2;
    case "23x": case "22b": case "22t": case "22s": case "22c": return 2;
    case "30t": case "32x": case "31i": case "31t": case "31c": return 3;
    case "35c": case "3rc": return 3;
    case "45cc": case "4rcc": return 4;
    case "51l": return 5;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// DexFile class
// ---------------------------------------------------------------------------
class DexFile {
  constructor(buf, name) {
    this.buf = buf;
    this.name = name || "classes.dex";
    this._parse();
  }

  _parse() {
    const b = this.buf;
    if (b.toString("latin1", 0, 4) !== "dex\n") throw new Error("Not a DEX file (bad magic): " + this.name);
    this.version = b.toString("latin1", 4, 7);
    const off = (n) => readU32(b, n);
    const header = {
      stringIdsSize: off(56), stringIdsOff: off(60),
      typeIdsSize: off(64), typeIdsOff: off(68),
      protoIdsSize: off(72), protoIdsOff: off(76),
      fieldIdsSize: off(80), fieldIdsOff: off(84),
      methodIdsSize: off(88), methodIdsOff: off(92),
      classDefsSize: off(96), classDefsOff: off(100),
    };
    this.header = header;

    // strings
    this.strings = new Array(header.stringIdsSize);
    for (let i = 0; i < header.stringIdsSize; i++) {
      this.strings[i] = readString(b, off(header.stringIdsOff + i * 4)).value;
    }
    // types = strings[type_ids[i].descriptor_idx]
    this.types = new Array(header.typeIdsSize);
    for (let i = 0; i < header.typeIdsSize; i++) {
      this.types[i] = this.strings[off(header.typeIdsOff + i * 4)];
    }
    // protos
    this.protos = new Array(header.protoIdsSize);
    for (let i = 0; i < header.protoIdsSize; i++) {
      const o = header.protoIdsOff + i * 12;
      const shorty = this.strings[off(o)];
      const returnType = this.types[off(o + 4)];
      const paramsOff = off(o + 8);
      const params = [];
      if (paramsOff) {
        const size = off(paramsOff);
        for (let k = 0; k < size; k++) params.push(this.types[readU16(b, paramsOff + 4 + k * 2)]);
      }
      this.protos[i] = { shorty, returnType, params };
    }
    // fields
    this.fieldIds = new Array(header.fieldIdsSize);
    for (let i = 0; i < header.fieldIdsSize; i++) {
      const o = header.fieldIdsOff + i * 8;
      this.fieldIds[i] = { classIdx: readU16(b, o), typeIdx: readU16(b, o + 2), nameIdx: off(o + 4) };
    }
    // methods
    this.methodIds = new Array(header.methodIdsSize);
    for (let i = 0; i < header.methodIdsSize; i++) {
      const o = header.methodIdsOff + i * 8;
      this.methodIds[i] = { classIdx: readU16(b, o), protoIdx: readU16(b, o + 2), nameIdx: off(o + 4) };
    }

    this.classes = [];
    for (let i = 0; i < header.classDefsSize; i++) {
      const o = header.classDefsOff + i * 32;
      const classIdx = off(o);
      const access = off(o + 4);
      const superIdx = off(o + 8);
      const interfacesOff = off(o + 12);
      const sourceFileIdx = off(o + 16);
      const classDataOff = off(o + 24);
      const interfaces = [];
      if (interfacesOff) {
        const size = off(interfacesOff);
        for (let k = 0; k < size; k++) interfaces.push(this.types[readU16(b, interfacesOff + 4 + k * 2)]);
      }
      const cls = {
        descriptor: this.types[classIdx],
        access,
        superDescriptor: superIdx === NO_INDEX ? null : this.types[superIdx],
        interfaces,
        sourceFile: sourceFileIdx === NO_INDEX ? null : this.strings[sourceFileIdx],
        staticFields: [],
        instanceFields: [],
        directMethods: [],
        virtualMethods: [],
      };
      if (classDataOff) this._parseClassData(cls, classDataOff);
      this.classes.push(cls);
    }
  }

  _parseClassData(cls, off) {
    const b = this.buf;
    let p = off, a;
    [a, p] = readUleb128(b, p); const staticFieldsSize = a;
    [a, p] = readUleb128(b, p); const instanceFieldsSize = a;
    [a, p] = readUleb128(b, p); const directMethodsSize = a;
    [a, p] = readUleb128(b, p); const virtualMethodsSize = a;

    let fidx = 0;
    for (let i = 0; i < staticFieldsSize; i++) {
      let d; [d, p] = readUleb128(b, p); fidx += d;
      let af; [af, p] = readUleb128(b, p);
      const f = this.fieldIds[fidx];
      cls.staticFields.push({ name: this.strings[f.nameIdx], type: this.types[f.typeIdx], access: af });
    }
    fidx = 0;
    for (let i = 0; i < instanceFieldsSize; i++) {
      let d; [d, p] = readUleb128(b, p); fidx += d;
      let af; [af, p] = readUleb128(b, p);
      const f = this.fieldIds[fidx];
      cls.instanceFields.push({ name: this.strings[f.nameIdx], type: this.types[f.typeIdx], access: af });
    }
    let midx = 0;
    for (let i = 0; i < directMethodsSize; i++) {
      let d; [d, p] = readUleb128(b, p); midx += d;
      let af; [af, p] = readUleb128(b, p);
      let codeOff; [codeOff, p] = readUleb128(b, p);
      cls.directMethods.push(this._makeMethod(midx, af, codeOff));
    }
    midx = 0;
    for (let i = 0; i < virtualMethodsSize; i++) {
      let d; [d, p] = readUleb128(b, p); midx += d;
      let af; [af, p] = readUleb128(b, p);
      let codeOff; [codeOff, p] = readUleb128(b, p);
      cls.virtualMethods.push(this._makeMethod(midx, af, codeOff));
    }
  }

  _makeMethod(methodIdx, access, codeOff) {
    const m = this.methodIds[methodIdx];
    const proto = this.protos[m.protoIdx];
    const info = {
      methodIdx,
      name: this.strings[m.nameIdx],
      classDescriptor: this.types[m.classIdx],
      access,
      returnType: proto.returnType,
      params: proto.params,
      protoIdx: m.protoIdx,
      codeOff,
      signature: this.methodSignature(this.types[m.classIdx], this.strings[m.nameIdx], proto),
    };
    if (codeOff) info.code = this._parseCode(codeOff);
    return info;
  }

  methodSignature(classDescriptor, name, proto) {
    return `${classDescriptor}->${name}(${proto.params.join("")})${proto.returnType}`;
  }

  _parseCode(codeOff) {
    const b = this.buf;
    const registersSize = readU16(b, codeOff);
    const insSize = readU16(b, codeOff + 2);
    const outsSize = readU16(b, codeOff + 4);
    const triesSize = readU16(b, codeOff + 6);
    const insnsSize = readU32(b, codeOff + 12);
    const insnsOff = codeOff + 16;
    const code = { registersSize, insSize, outsSize, triesSize, insnsSize, insnsOff, tries: [] };
    // tries
    if (triesSize) {
      const triesOff = insnsOff + insnsSize * 2;
      let handlersOff = triesOff + triesSize * 8;
      let p = handlersOff;
      let [size, p2] = readUleb128(b, p);
      const handlers = [];
      let hasCatchAll = size <= 0;
      let n = Math.abs(size);
      for (let i = 0; i < n; i++) {
        let typeIdx, addr;
        [typeIdx, p2] = readUleb128(b, p2);
        [addr, p2] = readUleb128(b, p2);
        handlers.push({ type: typeIdx === NO_INDEX ? "all" : this.types[typeIdx], addr });
      }
      if (hasCatchAll) {
        let addr; [addr, p2] = readUleb128(b, p2);
        handlers.push({ type: "<catchall>", addr });
      }
      for (let i = 0; i < triesSize; i++) {
        const to = triesOff + i * 8;
        code.tries.push({
          start: readU32(b, to), count: readU16(b, to + 4), handlerOff: readU16(b, to + 6),
        });
      }
      code.handlers = handlers;
    }
    return code;
  }
}

// ---------------------------------------------------------------------------
// Smali disassembly
// ---------------------------------------------------------------------------
function formatInsn(dex, b, q, base) {
  const op = b[q];
  const ent = OPCODES[op];
  const addr = ((q - base) / 2).toString(16).padStart(4, "0");
  const target = (off) => ((q - base) / 2 + off).toString(16).replace("-", "-").padStart(4, "0");
  if (!ent) return { line: `    :${addr}  #0x${op.toString(16)}`, width: 1 };
  const [name, fmt] = ent;
  let text = name;
  switch (fmt) {
    case "10x": break;
    case "12x": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}`; break;
    case "11n": {
      let lit = b[q + 1] >> 4; if (lit > 7) lit -= 16;
      text += ` v${b[q + 1] & 0xf}, #${lit}`; break;
    }
    case "11x": text += ` v${b[q + 1]}`; break;
    case "10t": text += ` :${target(signed8(b[q + 1]))}`; break;
    case "20t": text += ` :${target(readI16(b, q + 2))}`; break;
    case "30t": text += ` :${target(readI32(b, q + 2))}`; break;
    case "22x": text += ` v${b[q + 1]}, v${readU16(b, q + 2)}`; break;
    case "21t": text += ` v${b[q + 1]}, :${target(readI16(b, q + 2))}`; break;
    case "21s": text += ` v${b[q + 1]}, #${readI16(b, q + 2)}`; break;
    case "21h": text += ` v${b[q + 1]}, #0x${(readU16(b, q + 2) << 16 >>> 0).toString(16)}`; break;
    case "21c": text += ` v${b[q + 1]}, ${refFor21c(dex, op, readU16(b, q + 2))}`; break;
    case "23x": text += ` v${b[q + 1]}, v${b[q + 2]}, v${b[q + 3]}`; break;
    case "22b": { let lit = b[q + 2] | 0; if (lit > 127) lit -= 256; text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, #${lit}`; break; }
    case "22t": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, :${target(readI16(b, q + 2))}`; break;
    case "22s": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, #${readI16(b, q + 2)}`; break;
    case "22c": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, ${refFor22c(dex, op, readU16(b, q + 2))}`; break;
    case "32x": text += ` v${readU16(b, q + 2)}, v${readU16(b, q + 4)}`; break;
    case "31i": text += ` v${b[q + 1]}, #${readI32(b, q + 2)}`; break;
    case "31t": text += ` v${b[q + 1]}, :${target(readI32(b, q + 2))}`; break;
    case "31c": text += ` v${b[q + 1]}, ${refFor21c(dex, op, readU32(b, q + 2))}`; break;
    case "35c": {
      const count = b[q + 1] >> 4;
      const regs = [b[q + 4] & 0xf, b[q + 4] >> 4, b[q + 5] & 0xf, b[q + 5] >> 4, b[q + 1] & 0xf];
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + regs[i]);
      text += ` {${list.join(", ")}}, ${refFor35c(dex, op, readU16(b, q + 2))}`;
      break;
    }
    case "3rc": {
      const count = b[q + 1];
      const first = readU16(b, q + 4);
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + (first + i));
      text += ` {${list.join(", ")}}, ${refFor35c(dex, op, readU16(b, q + 2))}`;
      break;
    }
    case "45cc": {
      const count = b[q + 1] >> 4;
      const regs = [b[q + 4] & 0xf, b[q + 4] >> 4, b[q + 5] & 0xf, b[q + 5] >> 4, b[q + 1] & 0xf];
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + regs[i]);
      text += ` {${list.join(", ")}}, ${dex.methodIdString(readU16(b, q + 2))}, ${dex.types[readU16(b, q + 6)]}`;
      break;
    }
    case "4rcc": {
      const count = b[q + 1];
      const first = readU16(b, q + 4);
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + (first + i));
      text += ` {${list.join(", ")}}, ${dex.methodIdString(readU16(b, q + 2))}, ${dex.types[readU16(b, q + 6)]}`;
      break;
    }
    case "51l": {
      const lo = readU32(b, q + 2), hi = readU32(b, q + 6);
      const v = (BigInt(hi) << 32n) | BigInt(lo);
      text += ` v${b[q + 1]}, #${v}L`;
      break;
    }
    default: break;
  }
  return { line: `    ${addr}: ${text}`, width: insnWidth(b, q) };
}

function signedHex(n, pad) {
  if (n < 0) return "-" + Math.abs(n).toString(16).padStart(pad, "0");
  return n.toString(16).padStart(pad, "0");
}
function signed8(v) { v &= 0xff; return v > 127 ? v - 256 : v; }

function refFor21c(dex, op, idx) {
  switch (op) {
    case 0x1a: case 0x1b: return JSON.stringify(dex.strings[idx]);
    case 0x1c: return dex.types[idx] || "";
    case 0x1f: return dex.types[idx] || "";
    case 0x22: return dex.types[idx] || "";
    case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66:
    case 0x67: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c: case 0x6d: return dex.fieldIdString(idx);
    case 0xfe: return "method-handle@" + idx;
    case 0xff: return dex.types[idx] || "";
    default: return "#" + idx;
  }
}

function refFor22c(dex, op, idx) {
  if (op === 0x20 || op === 0x23) return dex.types[idx] || "";
  return dex.fieldIdString(idx);
}

function refFor35c(dex, op, idx) {
  if (op === 0x24 || op === 0x25) return dex.types[idx] || "";
  return dex.methodIdString(idx);
}

DexFile.prototype.fieldIdString = function (idx) {
  const f = this.fieldIds[idx];
  if (!f) return "?";
  return `${this.types[f.classIdx]}->${this.strings[f.nameIdx]}:${this.types[f.typeIdx]}`;
};
DexFile.prototype.methodIdString = function (idx) {
  const m = this.methodIds[idx];
  if (!m) return "?";
  const proto = this.protos[m.protoIdx];
  return `${this.types[m.classIdx]}->${this.strings[m.nameIdx]}(${proto.params.join("")})${proto.returnType}`;
};

// full method body smali (header + instructions + handlers)
DexFile.prototype.methodSmali = function (method) {
  const lines = [];
  const mods = methodModifiers(method.access);
  const paramsText = method.params.length ? method.params.join("") : "";
  lines.push(`.method ${mods ? mods + " " : ""}${method.name}(${paramsText})${method.returnType}`.replace(/\s+/g, " ").replace(" (", "("));
  lines.push(`    .registers ${method.code ? method.code.registersSize : 0}`);
  if (method.code) {
    const b = this.buf;
    const base = method.code.insnsOff;
    const end = base + method.code.insnsSize * 2;
    let q = base;
    while (q < end) {
      const op = b[q];
      if (op === 0x00) {
        const fmt = readU16(b, q + 2);
        if (fmt === 0x0100) {
          const size = readU16(b, q + 4);
          lines.push(`    :${((q - base) / 2).toString(16).padStart(4, "0")}: packed-switch-payload`);
          q += (2 + size * 4) * 2; continue;
        } else if (fmt === 0x0200) {
          const size = readU16(b, q + 4);
          lines.push(`    :${((q - base) / 2).toString(16).padStart(4, "0")}: sparse-switch-payload`);
          q += (2 + size * 4) * 2; continue;
        } else if (fmt === 0x0300) {
          const esize = readU16(b, q + 4);
          const count = readU32(b, q + 6);
          lines.push(`    :${((q - base) / 2).toString(16).padStart(4, "0")}: fill-array-data-payload`);
          const w = 4 + ((count * esize + 1) >> 1);
          q += w * 2; continue;
        }
      }
      const r = formatInsn(this, b, q, base);
      lines.push(r.line);
      q += r.width * 2;
    }
    if (method.code.handlers && method.code.handlers.length) {
      lines.push("    # handlers:");
      for (const h of method.code.handlers) lines.push(`    #   catch ${h.type} -> :${h.addr.toString(16).padStart(4, "0")}`);
    }
  }
  lines.push(".end method");
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Normalized (comparison) disassembly.
// Ignores: nop instructions, register numbering, register count (.registers),
// debug info, and equivalent encodings (const widths, goto widths,
// invoke/range variants). Branch targets and catch handlers are renumbered.
// ---------------------------------------------------------------------------
const GOTO_OPS = { 0x28: 1, 0x29: 1, 0x2a: 1 };
const INVOKE_RANGE_OPS = { 0x74: 0x6e, 0x75: 0x6f, 0x76: 0x70, 0x77: 0x71, 0x78: 0x72, 0xfb: 0xfa };

function constValueCmp(b, q, op) {
  switch (op) {
    case 0x12: { let lit = b[q + 1] >> 4; if (lit > 7) lit -= 16; return String(lit); }
    case 0x13: return String(readI16(b, q + 2));
    case 0x14: return String(readI32(b, q + 2));
    case 0x15: return String(readU16(b, q + 2) << 16);
    case 0x16: return String(readI16(b, q + 2));
    case 0x17: return String(readI32(b, q + 2));
    case 0x18: {
      const lo = readU32(b, q + 2), hi = readU32(b, q + 6);
      let v = (BigInt(hi) << 32n) | BigInt(lo);
      if (v >= 0x8000000000000000n) v -= 0x10000000000000000n;
      return v.toString();
    }
    case 0x19: {
      let v = BigInt(readU16(b, q + 2)) << 48n;
      if (v >= 0x8000000000000000n) v -= 0x10000000000000000n;
      return v.toString();
    }
    default: return null;
  }
}

// like formatInsn but: no address prefix, targets as %T placeholders
// (absolute code-unit offsets), const/goto/invoke forms normalized.
function formatInsnCmp(dex, b, q, base) {
  const op = b[q];
  const ent = OPCODES[op];
  const abs = (q - base) / 2;
  const targets = [];
  const T = (off) => { targets.push(off); return "%T" + (targets.length - 1); };
  if (!ent) return { text: `#0x${op.toString(16)}`, width: 1, targets };
  let name = ent[0];
  const fmt = ent[1];
  if (GOTO_OPS[op]) name = "goto";
  if (INVOKE_RANGE_OPS[op] !== undefined) name = OPCODES[INVOKE_RANGE_OPS[op]][0];
  const cv = constValueCmp(b, q, op);
  if (cv !== null) {
    const reg = op === 0x12 ? (b[q + 1] & 0xf) : b[q + 1];
    return { text: `const v${reg}, #${cv}`, width: insnWidth(b, q), targets };
  }
  let text = name;
  switch (fmt) {
    case "10x": break;
    case "12x": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}`; break;
    case "11x": text += ` v${b[q + 1]}`; break;
    case "10t": text += ` ${T(abs + signed8(b[q + 1]))}`; break;
    case "20t": text += ` ${T(abs + readI16(b, q + 2))}`; break;
    case "30t": text += ` ${T(abs + readI32(b, q + 2))}`; break;
    case "22x": text += ` v${b[q + 1]}, v${readU16(b, q + 2)}`; break;
    case "21t": text += ` v${b[q + 1]}, ${T(abs + readI16(b, q + 2))}`; break;
    case "21s": text += ` v${b[q + 1]}, #${readI16(b, q + 2)}`; break;
    case "21h": text += ` v${b[q + 1]}, #${readU16(b, q + 2) << 16}`; break;
    case "21c": text += ` v${b[q + 1]}, ${refFor21c(dex, op, readU16(b, q + 2))}`; break;
    case "23x": text += ` v${b[q + 1]}, v${b[q + 2]}, v${b[q + 3]}`; break;
    case "22b": { let lit = b[q + 2] | 0; if (lit > 127) lit -= 256; text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, #${lit}`; break; }
    case "22t": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, ${T(abs + readI16(b, q + 2))}`; break;
    case "22s": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, #${readI16(b, q + 2)}`; break;
    case "22c": text += ` v${b[q + 1] & 0xf}, v${b[q + 1] >> 4}, ${refFor22c(dex, op, readU16(b, q + 2))}`; break;
    case "32x": text += ` v${readU16(b, q + 2)}, v${readU16(b, q + 4)}`; break;
    case "31i": text += ` v${b[q + 1]}, #${readI32(b, q + 2)}`; break;
    case "31t": text += ` v${b[q + 1]}, ${T(abs + readI32(b, q + 2))}`; break;
    case "31c": text += ` v${b[q + 1]}, ${refFor21c(dex, op, readU32(b, q + 2))}`; break;
    case "35c": {
      const count = b[q + 1] >> 4;
      const regs = [b[q + 4] & 0xf, b[q + 4] >> 4, b[q + 5] & 0xf, b[q + 5] >> 4, b[q + 1] & 0xf];
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + regs[i]);
      text += ` {${list.join(", ")}}, ${refFor35c(dex, op, readU16(b, q + 2))}`;
      break;
    }
    case "3rc": {
      const count = b[q + 1];
      const first = readU16(b, q + 4);
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + (first + i));
      text += ` {${list.join(", ")}}, ${refFor35c(dex, op, readU16(b, q + 2))}`;
      break;
    }
    case "45cc": {
      const count = b[q + 1] >> 4;
      const regs = [b[q + 4] & 0xf, b[q + 4] >> 4, b[q + 5] & 0xf, b[q + 5] >> 4, b[q + 1] & 0xf];
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + regs[i]);
      text += ` {${list.join(", ")}}, ${dex.methodIdString(readU16(b, q + 2))}, ${dex.types[readU16(b, q + 6)]}`;
      break;
    }
    case "4rcc": {
      const count = b[q + 1];
      const first = readU16(b, q + 4);
      const list = [];
      for (let i = 0; i < count; i++) list.push("v" + (first + i));
      text += ` {${list.join(", ")}}, ${dex.methodIdString(readU16(b, q + 2))}, ${dex.types[readU16(b, q + 6)]}`;
      break;
    }
    case "51l": {
      const lo = readU32(b, q + 2), hi = readU32(b, q + 6);
      let v = (BigInt(hi) << 32n) | BigInt(lo);
      if (v >= 0x8000000000000000n) v -= 0x10000000000000000n;
      text += ` v${b[q + 1]}, #${v}`;
      break;
    }
    default: break;
  }
  return { text, width: insnWidth(b, q), targets };
}

// Returns an array of normalized smali lines for structural comparison.
DexFile.prototype.methodCompareLines = function (method) {
  if (!method.code) return [];
  const b = this.buf;
  const base = method.code.insnsOff;
  const end = base + method.code.insnsSize * 2;
  const insns = [];
  let q = base;
  while (q < end) {
    const op = b[q];
    const addr = (q - base) / 2;
    if (op === 0x00) {
      const pfmt = readU16(b, q + 2);
      if (pfmt === 0x0100 || pfmt === 0x0200 || pfmt === 0x0300) {
        let width;
        let kind;
        if (pfmt === 0x0100) { kind = "packed-switch-payload"; width = 2 + readU16(b, q + 4) * 4; }
        else if (pfmt === 0x0200) { kind = "sparse-switch-payload"; width = 2 + readU16(b, q + 4) * 4; }
        else {
          kind = "fill-array-data-payload";
          const esize = readU16(b, q + 4);
          const count = readU32(b, q + 6);
          width = 4 + ((count * esize + 1) >> 1);
        }
        insns.push({ addr, width, text: kind, targets: [] });
        q += width * 2;
        continue;
      }
      q += 2; // plain nop: ignored
      continue;
    }
    const r = formatInsnCmp(this, b, q, base);
    insns.push({ addr, width: r.width, text: r.text, targets: r.targets });
    q += r.width * 2;
  }

  // remap old code-unit offsets -> new offsets (nops removed, renumbered)
  let newAddr = 0;
  for (const ins of insns) { ins.newAddr = newAddr; newAddr += ins.width; }
  const mapTarget = (t) => {
    let lo = 0, hi = insns.length - 1, best = insns.length ? insns[insns.length - 1].newAddr + insns[insns.length - 1].width : 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (insns[mid].addr >= t) { best = insns[mid].newAddr; hi = mid - 1; }
      else lo = mid + 1;
    }
    return best;
  };

  // canonical register numbering by first use (string literals left untouched)
  const regMap = new Map();
  let nextReg = 0;
  const rename = (text) => text.replace(/("(?:[^"\\]|\\.)*")|\bv(\d+)\b/g, (m, str, n) => {
    if (str !== undefined) return str;
    n = +n;
    if (!regMap.has(n)) regMap.set(n, nextReg++);
    return "v" + regMap.get(n);
  });

  const out = [];
  for (const ins of insns) {
    const text = ins.text.replace(/%T(\d+)/g, (_m, k) =>
      ":" + mapTarget(ins.targets[+k]).toString(16).padStart(4, "0"));
    out.push(ins.newAddr.toString(16).padStart(4, "0") + ": " + rename(text));
  }
  if (method.code.handlers && method.code.handlers.length) {
    for (const h of method.code.handlers) {
      out.push("# catch " + h.type + " -> :" + mapTarget(h.addr).toString(16).padStart(4, "0"));
    }
  }
  return out;
};

DexFile.prototype.fieldSmali = function (field) {
  const mods = fieldModifiers(field.access);
  return `.field ${mods ? mods + " " : ""}${field.name}:${field.type}`;
};

DexFile.prototype.classSmali = function (cls) {
  const lines = [];
  const mods = classModifiers(cls.access);
  lines.push(`.class ${mods ? mods + " " : ""}${cls.descriptor}`);
  if (cls.superDescriptor) lines.push(`.super ${cls.superDescriptor}`);
  if (cls.sourceFile) lines.push(`.source ${JSON.stringify(cls.sourceFile)}`);
  for (const i of cls.interfaces) lines.push(`.implements ${i}`);
  lines.push("");
  for (const f of cls.staticFields) lines.push(this.fieldSmali(f));
  for (const f of cls.instanceFields) lines.push(this.fieldSmali(f));
  if (cls.staticFields.length || cls.instanceFields.length) lines.push("");
  for (const m of cls.directMethods) { lines.push(this.methodSmali(m)); lines.push(""); }
  for (const m of cls.virtualMethods) { lines.push(this.methodSmali(m)); lines.push(""); }
  return lines.join("\n");
};

// stable body signature (access + params/ret + smali instructions only)
DexFile.prototype.methodBodySmali = function (method) {
  return this.methodSmali(method);
};

module.exports = { DexFile, OPCODES, ACC, classModifiers, fieldModifiers, methodModifiers };
