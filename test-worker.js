"use strict";

const assert = require("assert");
const path = require("path");
const { Worker } = require("worker_threads");

const fixtureDir = "C:/Users/Shuha/Downloads/APK LAB/extracted";
const worker = new Worker(path.join(__dirname, "compare-worker.js"));
let nextId = 1;

function request(type, payload, onProgress) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message) => {
      if (message.id !== id) return;
      if (message.progress) {
        if (onProgress) onProgress(message.progress);
        return;
      }
      worker.off("message", onMessage);
      worker.off("error", onError);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    worker.once("error", onError);
    worker.on("message", onMessage);
    worker.postMessage({ id, type, ...payload });
  });
}

async function run() {
  try {
    const progressEvents = [];
    const result = await request("compare", {
      leftPath: path.join(fixtureDir, "classes2.dex"),
      rightPath: path.join(fixtureDir, "classes2b.dex"),
    }, (progress) => progressEvents.push(progress));
    assert(result.classes.length > 0);
    const compareProgress = progressEvents.filter((progress) => progress.stage === "compare");
    assert(compareProgress.length > 0, "comparison should report progress");
    assert.strictEqual(compareProgress[compareProgress.length - 1].current, compareProgress[compareProgress.length - 1].total);
    for (let i = 1; i < compareProgress.length; i++) {
      assert(compareProgress[i].current >= compareProgress[i - 1].current, "comparison progress should be monotonic");
    }
    assert(progressEvents.some((progress) => progress.stage === "parse"), "DEX parsing should report progress");
    const changedClass = result.classes.find((cls) => cls.status === "modified");
    assert(changedClass, "expected a changed class in comparison fixture");
    const changedMethod = changedClass.methods.find((method) => method.status === "modified");
    assert(changedMethod, "expected a changed method in comparison fixture");
    const smali = await request("methodSmali", {
      side: "left",
      descriptor: changedClass.descriptor,
      key: changedMethod.key,
    });
    assert(smali && smali.includes(".method"));
    console.log("Comparison worker tests passed");
  } finally {
    await worker.terminate();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
