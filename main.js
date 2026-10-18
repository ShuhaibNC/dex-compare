"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { comparePaths } = require("./lib/compare");

let win = null;
let session = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1e1f22",
    title: "APK Compare",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#26282c",
      symbolColor: "#d7dae0",
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

ipcMain.handle("compare:run", async (_e, leftPath, rightPath) => {
  session = comparePaths(leftPath, rightPath);
  return session.result;
});

ipcMain.handle("get:methodSmali", async (_e, side, descriptor, key) => {
  if (!session) return null;
  return session.getMethodSmali(side, descriptor, key);
});

ipcMain.handle("get:classSmali", async (_e, side, descriptor) => {
  if (!session) return null;
  return session.getClassSmali(side, descriptor);
});

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node,
}));
