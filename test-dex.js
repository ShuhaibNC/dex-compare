"use strict";

const assert = require("assert");
const { DexFile } = require("./lib/dex");

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

console.log("DEX 22c reference tests passed");
