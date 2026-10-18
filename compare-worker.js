"use strict";

const { parentPort } = require("worker_threads");
const { comparePaths } = require("./lib/compare");

if (!parentPort) throw new Error("Comparison worker must run in a worker thread");

let session = null;

parentPort.on("message", (message) => {
  try {
    if (message.type === "compare") {
      session = comparePaths(message.leftPath, message.rightPath, (progress) => {
        parentPort.postMessage({ id: message.id, progress });
      });
      parentPort.postMessage({ id: message.id, result: session.result });
    } else if (message.type === "methodSmali") {
      const result = session
        ? session.getMethodSmali(message.side, message.descriptor, message.key)
        : null;
      parentPort.postMessage({ id: message.id, result });
    } else if (message.type === "classSmali") {
      const result = session
        ? session.getClassSmali(message.side, message.descriptor)
        : null;
      parentPort.postMessage({ id: message.id, result });
    } else {
      throw new Error(`Unknown comparison worker request: ${message.type}`);
    }
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
