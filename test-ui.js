"use strict";
// Headless UI test: loads index.html in a hidden window, feeds a real compare
// result into the renderer, and asserts the tree/detail render without errors.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { compare } = require("./lib/compare");

const W = "C:/Users/Shuha/Downloads/APK LAB/extracted";

app.whenReady().then(async () => {
  let result;
  try {
    const s = compare(
      fs.readFileSync(path.join(W, "classes2.dex")),
      fs.readFileSync(path.join(W, "classes2b.dex")),
      "classes2.dex", "classes2b.dex"
    );
    result = s.result;
  } catch (e) {
    console.error("ENGINE ERROR", e);
    app.exit(2); return;
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("render-process-gone", (_e, d) => { console.error("RENDERER GONE", JSON.stringify(d)); app.exit(3); });
  await win.loadFile(path.join(__dirname, "index.html"));

  const script = `
    (() => {
      try {
        const res = ${JSON.stringify(result)};
        const x = window.__dex;
        if (!x) return { ok:false, err:"no __dex hook" };
        x.state.result = res;
        x.renderSummary();
        x.renderTree();
        const nodes = document.querySelectorAll("#tree .node").length;
        const pills = document.querySelector('#summary .pill.added').textContent;
        const modClass = res.classes.find(c => c.status === "modified");
        x.showClassDetail(modClass);
        const m = modClass.methods.find(mm => mm.status === "modified");
        x.showMethodDetail(modClass, m);
        const diffCells = document.querySelectorAll("#detail .diff .l, #detail .diff .r").length;
        const filtersHeight = document.getElementById("filters").getBoundingClientRect().height;
        const detailHead = document.getElementById("detail-head");
        const detailHeight = detailHead.getBoundingClientRect().height;
        const controlsInHeader = document.getElementById("diff-controls").parentElement === detailHead;
        const debugNoteRemoved = !document.querySelector(".norm-note");
        return { ok:filtersHeight === detailHeight && controlsInHeader && debugNoteRemoved,
                 nodes, meta: document.getElementById("metaLine").textContent,
                 addedPill: pills, diffCells, filtersHeight, detailHeight,
                 controlsInHeader, debugNoteRemoved };
      } catch (e) { return { ok:false, err: String(e && e.stack || e) }; }
    })()
  `;
  try {
    const out = await win.webContents.executeJavaScript(script);
    console.log("UI TEST:", JSON.stringify(out, null, 2));
    app.exit(out.ok ? 0 : 1);
  } catch (e) {
    console.error("EXEC ERROR", e);
    app.exit(4);
  }
});
