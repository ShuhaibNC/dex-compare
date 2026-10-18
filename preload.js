"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dexapi", {
  openDex: () => ipcRenderer.invoke("dialog:openDex"),
  compare: (leftPath, rightPath) => ipcRenderer.invoke("compare:run", leftPath, rightPath),
  methodSmali: (side, descriptor, key) => ipcRenderer.invoke("get:methodSmali", side, descriptor, key),
  classSmali: (side, descriptor) => ipcRenderer.invoke("get:classSmali", side, descriptor),
  aboutInfo: () => ipcRenderer.invoke("app:info"),
});
