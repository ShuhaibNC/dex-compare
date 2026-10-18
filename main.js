"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { Worker } = require("worker_threads");

let win = null;
let compareWorker = null;
let nextWorkerRequestId = 1;
const workerRequests = new Map();

function getCompareWorker() {
  if (compareWorker) return compareWorker;
  const worker = new Worker(path.join(__dirname, "compare-worker.js"));
  compareWorker = worker;
  worker.on("message", (message) => {
    const request = workerRequests.get(message.id);
    if (!request) return;
    if (message.progress) {
      request.onProgress(message.progress);
      return;
    }
    workerRequests.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  worker.on("error", (error) => {
    for (const request of workerRequests.values()) request.reject(error);
    workerRequests.clear();
    if (compareWorker === worker) compareWorker = null;
  });
  worker.on("exit", (code) => {
    if (compareWorker !== worker) return;
    compareWorker = null;
    if (code === 0) return;
    const error = new Error(`Comparison worker stopped unexpectedly (exit code ${code})`);
    for (const request of workerRequests.values()) request.reject(error);
    workerRequests.clear();
  });
  return worker;
}

function requestCompareWorker(type, payload, onProgress) {
  const worker = getCompareWorker();
  const id = nextWorkerRequestId++;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject, onProgress: onProgress || (() => {}) });
    try {
      worker.postMessage({ id, type, ...payload });
    } catch (error) {
      workerRequests.delete(id);
      reject(error);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1f1f1f",
    title: "APK Compare",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#181818",
      symbolColor: "#cccccc",
      height: 34,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("dialog:openDex", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Select APK / bundle / DEX file",
    properties: ["openFile"],
    filters: [
      { name: "All packages", extensions: ["apk", "xapk", "apks", "apkm", "zip", "dex"] },
      { name: "APK", extensions: ["apk"] },
      { name: "Split bundles (XAPK / APKS / APKM)", extensions: ["xapk", "apks", "apkm"] },
      { name: "DEX", extensions: ["dex"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("compare:run", async (event, leftPath, rightPath) => {
  return requestCompareWorker(
    "compare",
    { leftPath, rightPath },
    (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send("compare:progress", progress);
    }
  );
});

ipcMain.handle("get:methodSmali", async (_e, side, descriptor, key) => {
  return requestCompareWorker("methodSmali", { side, descriptor, key });
});

ipcMain.handle("get:classSmali", async (_e, side, descriptor) => {
  return requestCompareWorker("classSmali", { side, descriptor });
});

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node,
}));
