"use strict";
// Headless UI test: loads index.html in a hidden window, feeds a real compare
// result into the renderer, and asserts the tree/detail render without errors.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { compare } = require("./lib/compare");

const W = "C:/Users/Shuha/Downloads/APK LAB/extracted";

ipcMain.handle("app:info", () => ({
  version: require("./package.json").version,
  platform: process.platform,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node,
}));

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
    width: 1400,
    height: 900,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("render-process-gone", (_e, d) => { console.error("RENDERER GONE", JSON.stringify(d)); app.exit(3); });
  await win.loadFile(path.join(__dirname, "index.html"));

  const script = `
    (async () => {
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
        const search = document.getElementById("search");
        const renderFilteredTree = async (query) => {
          search.value = query;
          search.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        };
        await renderFilteredTree(modClass.descriptor);
        const classMatch = [...document.querySelectorAll("#tree .name.descriptor")]
          .find((el) => el.textContent === modClass.descriptor);
        classMatch.parentElement.click();
        const classFilterExpandsMembers =
          classMatch.closest(".node").querySelectorAll(".children > .node").length > 0;
        await renderFilteredTree(m.key);
        const methodClassMatch = [...document.querySelectorAll("#tree .name.descriptor")]
          .find((el) => el.textContent === modClass.descriptor);
        methodClassMatch.parentElement.click();
        const methodFilterShowsMatch = [...methodClassMatch.closest(".node").querySelectorAll(".children .name.sig")]
          .some((el) => el.textContent === m.key);
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        const filters = document.getElementById("filters");
        const filtersHeight = filters.getBoundingClientRect().height;
        const detailHead = document.getElementById("detail-head");
        const detailHeight = detailHead.getBoundingClientRect().height;
        const initialSidebarWidth = document.getElementById("left-pane").getBoundingClientRect().width;
        const mainWidth = document.getElementById("main").getBoundingClientRect().width;
        const sidebarStartsNearQuarter = Math.abs(initialSidebarWidth / mainWidth - 0.25) < 0.03;
        const filtersWrap = getComputedStyle(filters).flexWrap === "wrap" && filtersHeight > detailHeight;
        const splitter = document.getElementById("pane-splitter");
        const splitterAccessible = splitter.getAttribute("role") === "separator" && splitter.tabIndex === 0;
        splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        const splitterKeyboardResizable =
          document.getElementById("left-pane").getBoundingClientRect().width > initialSidebarWidth;
        const explorerStyleHeader = document.getElementById("tree-heading").textContent.trim() === "CLASSES"
          && !document.body.textContent.includes("Explorer");
        const controlsInHeader = document.getElementById("diff-controls").parentElement === detailHead;
        const debugNoteRemoved = !document.querySelector(".norm-note");
        const unifiedByDefault = document.getElementById("unifiedDiff").checked;
        const helpButton = document.getElementById("helpMenuButton");
        const aboutItem = document.getElementById("aboutMenuItem");
        const aboutDialog = document.getElementById("aboutDialog");
        const aboutContent = document.getElementById("aboutContent");
        const aboutFooter = document.querySelector(".about-footer");
        const appMenu = document.getElementById("app-menu");
        const helpIsFirst = appMenu.firstElementChild.classList.contains("help-menu");
        const menuIconsRemoved = !appMenu.querySelector(".about-icon, .help-icon");
        helpButton.click();
        const helpMenuOpens = !document.getElementById("helpMenuItems").classList.contains("hidden");
        aboutItem.click();
        for (let i = 0; i < 40 && !aboutDialog.open; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const aboutOpens = aboutDialog.open;
        const technicalInfoLoaded = document.getElementById("aboutElectron").textContent !== "Loading…";
        const authorOutsideScrollArea = aboutFooter.parentElement === aboutDialog.querySelector(".about-dialog")
          && !aboutContent.contains(aboutFooter);
        const theme = getComputedStyle(document.documentElement);
        const vscodeDarkPalette = theme.getPropertyValue("--bg").trim() === "#1f1f1f"
          && theme.getPropertyValue("--bg2").trim() === "#181818"
          && theme.getPropertyValue("--accent").trim() === "#0078d4";
        const selectiveTextSelection = getComputedStyle(document.body).userSelect === "none"
          && getComputedStyle(document.querySelector("#tree .row")).userSelect === "none"
          && getComputedStyle(document.getElementById("detail")).userSelect === "text"
          && getComputedStyle(document.getElementById("leftPath")).userSelect === "text"
          && getComputedStyle(aboutContent).userSelect === "text";
        return { ok:filtersWrap && controlsInHeader && debugNoteRemoved && unifiedByDefault
                   && helpIsFirst && menuIconsRemoved && helpMenuOpens
                   && aboutOpens && technicalInfoLoaded && authorOutsideScrollArea && vscodeDarkPalette
                   && sidebarStartsNearQuarter && splitterAccessible && splitterKeyboardResizable
                   && explorerStyleHeader && classFilterExpandsMembers && methodFilterShowsMatch
                   && selectiveTextSelection,
                 nodes, meta: document.getElementById("metaLine").textContent,
                 addedPill: pills, diffCells, filtersHeight, detailHeight,
                 controlsInHeader, debugNoteRemoved, unifiedByDefault, helpIsFirst,
                 menuIconsRemoved, helpMenuOpens, aboutOpens,
                 technicalInfoLoaded, authorOutsideScrollArea, vscodeDarkPalette,
                 initialSidebarWidth, mainWidth, sidebarStartsNearQuarter, filtersWrap,
                 splitterAccessible, splitterKeyboardResizable, explorerStyleHeader,
                 classFilterExpandsMembers, methodFilterShowsMatch, selectiveTextSelection };
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
