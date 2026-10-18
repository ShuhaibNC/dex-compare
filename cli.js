"use strict";
const { comparePaths } = require("./lib/compare");

const [, , a, b] = process.argv;
if (!a || !b) { console.error("usage: node cli.js left.(dex|apk|xapk|apks|apkm) right.(...)"); process.exit(1); }
const t0 = Date.now();
const session = comparePaths(a, b);
const r = session.result;
const t1 = Date.now();
console.log("meta:", JSON.stringify(r.meta));
console.log("summary:", JSON.stringify(r.summary, null, 2));
console.log("classes total:", r.classes.length, "compared in", (t1 - t0), "ms");
console.log("\n--- non-same classes (first 40) ---");
for (const c of r.classes.filter((x) => x.status !== "same").slice(0, 40)) {
  const mdiff = c.methods.filter((m) => m.status !== "same");
  const fdiff = c.fields.filter((f) => f.status !== "same");
  console.log(`${c.status.padEnd(8)} ${c.descriptor}  methods:${mdiff.length} fields:${fdiff.length}`);
  for (const m of mdiff.slice(0, 4)) console.log("    m " + m.status.padEnd(8) + " " + m.key);
  for (const f of fdiff.slice(0, 4)) console.log("    f " + f.status.padEnd(8) + " " + f.key);
}
