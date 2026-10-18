"use strict";

const assert = require("assert");
const { DexFile } = require("./lib/dex");
const { diffLines } = require("./lib/mydiff");

function disassemble22c(op, index) {
  const dex = Object.create(DexFile.prototype);
  dex.buf = Buffer.from([op, 0x65, index & 0xff, index >> 8]);
  dex.types = ["Ltest/Owner;", "[Le2/q1;"];
  dex.strings = ["unused", "f"];
  dex.fieldIds = [{ classIdx: 0, typeIdx: 1, nameIdx: 1 }];
  const method = {
    access: 0,
    name: "sample",
    params: [],
    returnType: "V",
    code: { registersSize: 7, insnsOff: 0, insnsSize: 2, handlers: [] },
  };
  return {
    smali: dex.methodSmali(method),
    comparison: dex.methodCompareLines(method),
  };
}

function disassemble35c(op, instructions, insnsSize, registersSize) {
  const dex = Object.create(DexFile.prototype);
  dex.buf = Buffer.from(instructions);
  dex.types = ["Lsample/Owner;", "[Lsample/Item;"];
  dex.strings = ["unused", "field", "method"];
  dex.fieldIds = [{ classIdx: 0, typeIdx: 1, nameIdx: 1 }];
  dex.protos = [{ params: ["I"], returnType: "V" }];
  dex.methodIds = [{ classIdx: 0, protoIdx: 0, nameIdx: 2 }];
  const method = {
    access: 0,
    name: "sample",
    params: [],
    returnType: "V",
    code: { registersSize, insnsOff: 0, insnsSize, handlers: [] },
  };
  return {
    smali: dex.methodSmali(method),
    comparison: dex.methodCompareLines(method),
  };
}

for (const [opcode, mnemonic, typeIndex] of [
  [0x20, "instance-of", 1],
  [0x23, "new-array", 1],
]) {
  const output = disassemble22c(opcode, typeIndex);
  assert(output.smali.includes(`${mnemonic} v5, v6, [Le2/q1;`));
  assert(output.comparison[0].includes(`${mnemonic} v0, v1, [Le2/q1;`));
  assert(!output.smali.includes("?"));
  assert(!output.comparison[0].includes("?"));
}

const fieldOutput = disassemble22c(0x54, 0);
assert(fieldOutput.smali.includes("iget-object v5, v6, Ltest/Owner;->f:[Le2/q1;"));
assert(fieldOutput.comparison[0].includes("iget-object v0, v1, Ltest/Owner;->f:[Le2/q1;"));

const filledArray = disassemble35c(0x24, [0x24, 0x10, 1, 0, 2, 0], 3, 4);
assert(filledArray.smali.includes("filled-new-array {v2}, [Lsample/Item;"));
assert(filledArray.comparison[0].includes("filled-new-array {v0}, [Lsample/Item;"));

const filledArrayRange = disassemble35c(0x25, [0x25, 2, 1, 0, 2, 0], 3, 4);
assert(filledArrayRange.smali.includes("filled-new-array/range {v2, v3}, [Lsample/Item;"));
assert(filledArrayRange.comparison[0].includes("filled-new-array/range {v0, v1}, [Lsample/Item;"));

const invoke = disassemble35c(0x6e, [0x6e, 0x10, 0, 0, 2, 0], 3, 4);
assert(invoke.smali.includes("invoke-virtual {v2}, Lsample/Owner;->method(I)V"));
assert(invoke.comparison[0].includes("invoke-virtual {v0}, Lsample/Owner;->method(I)V"));

const farApartLines = [
  Array.from({ length: 700 }, (_, i) => `left-${i}`),
  Array.from({ length: 700 }, (_, i) => `right-${i}`),
];
assert.strictEqual(diffLines(farApartLines[0], farApartLines[1], 6000), null);

console.log("DEX reference decoding tests passed");
