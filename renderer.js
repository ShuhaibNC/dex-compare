"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  result: null,
  leftPath: null,
  rightPath: null,
  selectedEl: null,
};

const STATUS_LABEL = { modified: "M", added: "A", removed: "R", same: "=" };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------
// Smali syntax highlighting (code formatting)
// ---------------------------------------------------------------------------
const SMALI_MODS = new Set([
  "public", "private", "protected", "static", "final", "synchronized",
  "volatile", "transient", "native", "abstract", "strictfp", "synthetic",
  "interface", "enum", "annotation", "constructor", "declared-synchronized",
  "bridge", "varargs",
]);
const TYPE_RE = /^(\[*L[^;]*;?|[\[VZBCSIJFD]+)$/;

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function tokHTML(cls, v) { return `<span class="${cls}">${escHtml(v)}</span>`; }

// A '#' starts a comment only when not a numeric literal marker (#0x.., #-1, #12)
function findComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "#" && !/[0-9-]/.test(line[i + 1] || "")) return i;
  }
  return -1;
}

function tokenizeSmali(code) {
  const toks = [];
  let i = 0;
  const n = code.length;
  const isWS = (c) => c === " " || c === "\t";
  while (i < n) {
    const c = code[i];
    if (isWS(c)) { let j = i + 1; while (j < n && isWS(code[j])) j++; toks.push({ k: "ws", v: code.slice(i, j) }); i = j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (code[j] === "\\") { j += 2; continue; } if (code[j] === '"') { j++; break; } j++; }
      toks.push({ k: "str", v: code.slice(i, j) }); i = j; continue;
    }
    if (code.startsWith("->", i)) { toks.push({ k: "op", v: "->" }); i += 2; continue; }
    if ("{}();,".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    if (c === ":") {
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(code[j])) j++;
      if (j - i - 1 >= 2) { toks.push({ k: "label", v: code.slice(i, j) }); i = j; continue; }
      toks.push({ k: "op", v: ":" }); i++; continue;
    }
    let j = i;
    while (j < n && !isWS(code[j]) && !"{}();,:".includes(code[j]) && !code.startsWith("->", j)) j++;
    toks.push({ k: "word", v: code.slice(i, j) }); i = j;
  }
  return toks;
}

function renderSmaliCode(code) {
  let out = "";
  let rest = code;
  const am = /^([ \t]*)([0-9a-fA-F]{1,8}):([ \t]?)/.exec(code);
  if (am) {
    out += escHtml(am[1]) + tokHTML("tk-addr", am[2]) + ":" + am[3];
    rest = code.slice(am[0].length);
  }
  const toks = tokenizeSmali(rest);
  let first = true;
  let afterArrow = false;
  for (const t of toks) {
    if (t.k === "ws") { out += t.v; continue; }
    if (t.k === "str") { out += tokHTML("tk-str", t.v); afterArrow = false; continue; }
    if (t.k === "label") { out += tokHTML("tk-label", t.v); afterArrow = false; continue; }
    if (t.k === "op") { out += tokHTML("tk-op", t.v); afterArrow = t.v === "->"; continue; }
    const v = t.v;
    if (afterArrow) { out += tokHTML("tk-member", v); afterArrow = false; continue; }
    if (/^[vp]\d+$/.test(v)) out += tokHTML("tk-reg", v);
    else if (/^#/.test(v)) out += tokHTML("tk-lit", v);
    else if (/^-?(0x[0-9a-fA-F]+|\d+)L?$/.test(v)) out += tokHTML("tk-lit", v);
    else if (SMALI_MODS.has(v)) out += tokHTML("tk-mod", v);
    else if (/^\.\w/.test(v)) out += tokHTML("tk-directive", v);
    else if (TYPE_RE.test(v)) out += tokHTML("tk-type", v);
    else if (first) out += tokHTML("tk-opcode", v);
    else out += tokHTML("tk-name", v);
    first = false;
  }
  return out;
}

function smaliLineHTML(line) {
  if (line == null) return "";
  const ci = findComment(line);
  let code = line, comment = "";
  if (ci >= 0) { code = line.slice(0, ci); comment = line.slice(ci); }
  return renderSmaliCode(code) + (comment ? tokHTML("tk-comment", comment) : "");
}

// ---------------------------------------------------------------------------
// File picking / compare
// ---------------------------------------------------------------------------
$("pickLeft").onclick = async () => {
  const p = await window.dexapi.openDex();
  if (p) { state.leftPath = p; $("leftPath").value = p; updateCompareBtn(); }
};
$("pickRight").onclick = async () => {
  const p = await window.dexapi.openDex();
  if (p) { state.rightPath = p; $("rightPath").value = p; updateCompareBtn(); }
};
$("swap").onclick = () => {
  const l = state.leftPath, r = state.rightPath;
  state.leftPath = r; state.rightPath = l;
  $("leftPath").value = r || "";
  $("rightPath").value = l || "";
  updateCompareBtn();
};
function updateCompareBtn() {
  $("compareBtn").disabled = !(state.leftPath && state.rightPath);
}
function updateComparisonProgress(progress) {
  const current = Number.isFinite(progress.current) ? progress.current : 0;
  const total = Number.isFinite(progress.total) ? progress.total : 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor((current / total) * 100))) : 0;
  const bar = $("progress").querySelector(".progress-bar");
  bar.style.width = `${percent}%`;
  $("progress").setAttribute("aria-valuemin", "0");
  $("progress").setAttribute("aria-valuemax", "100");
  $("progress").setAttribute("aria-valuenow", String(percent));
  if (progress.stage === "compare") {
    $("progressLabel").textContent = `Comparing: ${progress.detail} · ${percent}%`;
  } else if (progress.stage === "parse") {
    const dexNumber = progress.dexTotal ? ` (DEX ${progress.dexIndex}/${progress.dexTotal})` : "";
    $("progressLabel").textContent = `Parsing ${progress.detail}${dexNumber} · ${percent}%`;
  } else {
    $("progressLabel").textContent = `${progress.detail} · ${percent}%`;
  }
  $("progress").setAttribute("aria-valuetext", $("progressLabel").textContent);
}
window.dexapi.onCompareProgress(updateComparisonProgress);
$("compareBtn").onclick = async () => {
    $("compareBtn").disabled = true;
    $("compareBtn").textContent = "Comparing…";
    updateComparisonProgress({ stage: "load", current: 0, total: 1, detail: "Starting comparison" });
    $("progress").classList.remove("hidden");
    $("main").setAttribute("aria-busy", "true");
    try {
      const res = await window.dexapi.compare(state.leftPath, state.rightPath);
      state.result = res;
      renderSummary();
      renderTree();
    } catch (e) {
      alert("Compare failed: " + (e && e.message ? e.message : e));
    } finally {
      $("progress").classList.add("hidden");
      $("main").removeAttribute("aria-busy");
      $("compareBtn").disabled = false;
      $("compareBtn").textContent = "Compare";
    }
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function renderSummary() {
  const r = state.result;
  $("summary").classList.remove("hidden");
  for (const key of ["classes", "methods", "fields"]) {
    for (const st of ["modified", "added", "removed", "same"]) {
      const n = r.summary[key][st];
      document.querySelector(`.pill[data-k="${key}.${st}"]`).textContent = n;
    }
  }
  const m = r.meta;
  const side = (s) => `v${s.version} · ${s.dexes} dex · ${s.classes} classes · ${s.methods} methods`;
  $("metaLine").textContent = `L: ${side(m.left)}   |   R: ${side(m.right)}`;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
function classMatchesFilter(c, q) {
  const onlyDiff = $("onlyDiff").checked && !$("showSame").checked;
  if (onlyDiff && c.status === "same") {
    if (!q) return false;
  }
  if (!q) return true;
  if (c.descriptor.toLowerCase().includes(q)) return true;
  for (const m of c.methods) if (m.key.toLowerCase().includes(q)) return true;
  for (const f of c.fields) if (f.key.toLowerCase().includes(q)) return true;
  return false;
}

let renderToken = 0;
function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  const q = $("search").value.trim().toLowerCase();
  const classes = state.result.classes.filter((c) => classMatchesFilter(c, q));
  $("treeStatus").textContent = `${classes.length} class(es) shown`;

  const token = ++renderToken;
  const CHUNK = 400;
  let i = 0;
  const q2 = q;
  function chunk() {
    if (token !== renderToken) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(i + CHUNK, classes.length);
    for (; i < end; i++) frag.appendChild(classNode(classes[i], q2));
    tree.appendChild(frag);
    if (i < classes.length) requestAnimationFrame(chunk);
  }
  chunk();
}

function classNode(c, q) {
  const node = el("div", "node");
  const row = el("div", "row");
  row._ctx = { cls: c, kind: "class" };
  const tw = el("span", "tw");
  const hasChildren = c.methods.length > 0 || c.fields.length > 0;
  tw.textContent = hasChildren ? "\u25B6" : " ";
  row.appendChild(tw);
  row.appendChild(el("span", "badge " + c.status, STATUS_LABEL[c.status]));
  row.appendChild(el("span", "name descriptor", c.descriptor));
  const mdiff = c.methods.filter((m) => m.status !== "same").length;
  const fdiff = c.fields.filter((f) => f.status !== "same").length;
  if (mdiff || fdiff) row.appendChild(el("span", "counts", `  (m:${mdiff} f:${fdiff})`));
  node.appendChild(row);

  const children = el("div", "children");
  node.appendChild(children);

  let built = false;
  function build() {
    if (built) return;
    built = true;
    const onlyDiff = $("onlyDiff").checked && !$("showSame").checked;
    const classMatchesQuery = q && c.descriptor.toLowerCase().includes(q);
    const fq = (k) => (!q || classMatchesQuery || k.toLowerCase().includes(q));
    const fields = c.fields.filter((f) => (!onlyDiff || f.status !== "same") && fq(f.key));
    const methods = c.methods.filter((m) => (!onlyDiff || m.status !== "same") && fq(m.key));
    if (fields.length) {
      const lbl = el("div", "row");
      lbl.appendChild(el("span", "sig", "— fields —"));
      lbl.style.cursor = "default";
      children.appendChild(lbl);
      for (const f of fields) children.appendChild(leafNode(c, f, "field"));
    }
    if (methods.length) {
      for (const m of methods) children.appendChild(leafNode(c, m, "method"));
    }
  }

  row.onclick = () => {
    selectRow(row);
    const open = node.classList.toggle("open");
    tw.textContent = open ? "\u25BC" : "\u25B6";
    if (open) build();
    showClassDetail(c);
  };
  return node;
}

function leafNode(c, item, kind) {
  const node = el("div", "node");
  const row = el("div", "row");
  row._ctx = { cls: c, item, kind };
  row.appendChild(el("span", "tw", " "));
  row.appendChild(el("span", "badge " + item.status, STATUS_LABEL[item.status]));
  row.appendChild(el("span", "name sig", item.key));
  node.appendChild(row);
  row.onclick = (ev) => {
    ev.stopPropagation();
    selectRow(row);
    if (kind === "method") showMethodDetail(c, item);
    else showFieldDetail(c, item);
  };
  return node;
}

function selectRow(row) {
  if (state.selectedEl) state.selectedEl.classList.remove("selected");
  row.classList.add("selected");
  state.selectedEl = row;
}

// ---------------------------------------------------------------------------
// Detail panes
// ---------------------------------------------------------------------------
function setHead(text) { $("detailTitle").textContent = text; }

// ---------------------------------------------------------------------------
// Diff navigation (up/down buttons in the detail header)
// ---------------------------------------------------------------------------
const diffNav = { items: [], idx: -1 };

function refreshDiffNav() {
  const d = $("detail");
  diffNav.items = Array.from(d.querySelectorAll(
    "#detail .diff .l.rowdel, #detail .diff .r.rowadd, #detail .diff .line.rowdel, #detail .diff .line.rowadd, #detail .smali .del, #detail .smali .add"
  ));
  diffNav.idx = -1;
  updateDiffPos();
}

function updateDiffPos() {
  const n = diffNav.items.length;
  $("diffPos").textContent = n ? `${diffNav.idx < 0 ? 0 : diffNav.idx + 1} / ${n}` : "";
  $("diffPrev").disabled = !n;
  $("diffNext").disabled = !n;
}

function gotoDiff(step) {
  const n = diffNav.items.length;
  if (!n) return;
  diffNav.idx = (diffNav.idx + step + n) % n;
  const item = diffNav.items[diffNav.idx];
  item.scrollIntoView({ block: "center", behavior: "smooth" });
  item.classList.remove("flash");
  void item.offsetWidth;
  item.classList.add("flash");
  updateDiffPos();
}

$("diffPrev").onclick = () => gotoDiff(-1);
$("diffNext").onclick = () => gotoDiff(1);
document.addEventListener("keydown", (e) => {
  if (e.key === "F7") { e.preventDefault(); gotoDiff(e.shiftKey ? -1 : 1); }
});

function showClassDetail(c) {
  setHead(`${c.descriptor}  [${c.status}]`);
  const d = $("detail");
  d.innerHTML = "";
  if (c.status === "added") { d.appendChild(smaliBlock(c.rightHeader.join("\n"))); refreshDiffNav(); return; }
  if (c.status === "removed") { d.appendChild(smaliBlock(c.leftHeader.join("\n"))); refreshDiffNav(); return; }
  if (c.headerChanged) {
    if (Array.isArray(c.headerDiff)) d.appendChild(diffGrid(c.headerDiff, "class header"));
    else d.appendChild(el("div", "notice", "Class header diff too big to compute."));
  } else {
    d.appendChild(el("div", "notice", "Class header unchanged. Expand methods/fields on the left."));
  }
  refreshDiffNav();
}

async function showMethodDetail(c, m) {
  setHead(`${c.descriptor}->${m.key}  [${m.status}]`);
  const d = $("detail");
  d.innerHTML = "";
  if (m.status === "same") { d.appendChild(el("div", "notice", "Identical method body.")); refreshDiffNav(); return; }
  if (m.status === "modified") {
    if (m.tooBig) {
      d.appendChild(el("div", "notice", "Diff too big to compute (matches MT guard: \"Can not calculate diff. File is too big and there are too many changes.\")."));
      refreshDiffNav();
      return;
    }
    d.appendChild(diffGrid(m.diff, "smali"));
    refreshDiffNav();
    return;
  }
  const side = m.status === "added" ? "right" : "left";
  const text = await window.dexapi.methodSmali(side, c.descriptor, m.key);
  const pre = el("pre", "smali");
  for (const line of (text || "(not found)").split("\n")) {
    const span = el("span", m.status === "added" ? "add" : "del");
    span.innerHTML = smaliLineHTML(line) + "\n";
    pre.appendChild(span);
  }
  d.appendChild(pre);
  refreshDiffNav();
}

function showFieldDetail(c, f) {
  setHead(`${c.descriptor} ${f.key}  [${f.status}]`);
  const d = $("detail");
  d.innerHTML = "";
  const rows = [];
  if (f.status === "modified") {
    rows.push({ t: "del", l: f.leftText, r: null });
    rows.push({ t: "add", l: null, r: f.rightText });
  } else if (f.status === "added") {
    rows.push({ t: "add", l: null, r: f.rightText });
  } else if (f.status === "removed") {
    rows.push({ t: "del", l: f.leftText, r: null });
  } else {
    rows.push({ t: "eq", l: f.leftText, r: f.rightText });
  }
  d.appendChild(diffGrid(rows, "field"));
  refreshDiffNav();
}

// side-by-side diff grid
function diffGrid(rows, label) {
  const wrap = el("div", "diff");
  if ($("unifiedDiff") && $("unifiedDiff").checked) wrap.classList.add("unified");
  const hl = el("div", "h old", "LEFT (old)");
  const hr = el("div", "h new", "RIGHT (new)");
  wrap.appendChild(hl); wrap.appendChild(hr);
  for (const r of rows) {
    if ($("unifiedDiff") && $("unifiedDiff").checked) {
      const text = r.l || r.r || "";
      const sign = r.t === "del" ? "- " : r.t === "add" ? "+ " : "  ";
      const cell = el("div", "line" + (r.t === "del" ? " rowdel" : r.t === "add" ? " rowadd" : ""));
      cell.innerHTML = escHtml(sign) + smaliLineHTML(text);
      wrap.appendChild(cell);
      continue;
    }
    const l = el("div", "l" + (r.t === "del" ? " rowdel" : ""));
    l.innerHTML = smaliLineHTML(r.l || "");
    const rr = el("div", "r" + (r.t === "add" ? " rowadd" : ""));
    rr.innerHTML = smaliLineHTML(r.r || "");
    wrap.appendChild(l); wrap.appendChild(rr);
  }
  return wrap;
}

function smaliBlock(text) {
  const pre = el("pre", "smali");
  pre.innerHTML = String(text || "").split("\n").map(smaliLineHTML).join("\n");
  return pre;
}

// filters
$("search").oninput = () => { if (state.result) renderTree(); };
$("onlyDiff").onchange = () => { if (state.result) renderTree(); };
$("showSame").onchange = () => {
  if ($("showSame").checked) $("onlyDiff").checked = false;
  if (state.result) renderTree();
};
$("onlyDiff").onchange = () => {
  if ($("onlyDiff").checked) $("showSame").checked = false;
  if (state.result) renderTree();
};
$("unifiedDiff").onchange = () => {
  const sel = state.selectedEl;
  if (sel && sel._ctx) {
    if (sel._ctx.kind === "method") showMethodDetail(sel._ctx.cls, sel._ctx.item);
    else if (sel._ctx.kind === "field") showFieldDetail(sel._ctx.cls, sel._ctx.item);
    else if (sel._ctx.kind === "class") showClassDetail(sel._ctx.cls);
  }
};

const paneSplitter = $("pane-splitter");
const mainPane = $("main");
const MIN_SIDEBAR_WIDTH = 220;
const MIN_DETAIL_WIDTH = 280;
let resizingSidebar = false;

function setSidebarWidth(width) {
  const mainWidth = mainPane.getBoundingClientRect().width;
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, mainWidth - MIN_DETAIL_WIDTH - paneSplitter.offsetWidth);
  const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, maxWidth));
  mainPane.style.setProperty("--sidebar-width", `${(clampedWidth / mainWidth) * 100}%`);
  paneSplitter.setAttribute("aria-valuemax", String(Math.floor(maxWidth)));
  paneSplitter.setAttribute("aria-valuenow", String(Math.round(clampedWidth)));
}

paneSplitter.onpointerdown = (event) => {
  resizingSidebar = true;
  paneSplitter.focus();
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  event.preventDefault();
};
window.addEventListener("pointermove", (event) => {
  if (!resizingSidebar) return;
  const mainLeft = mainPane.getBoundingClientRect().left;
  setSidebarWidth(event.clientX - mainLeft);
});
window.addEventListener("pointerup", () => {
  resizingSidebar = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});
paneSplitter.onkeydown = (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const currentWidth = $("left-pane").getBoundingClientRect().width;
  setSidebarWidth(currentWidth + (event.key === "ArrowRight" ? 16 : -16));
};
window.addEventListener("resize", () => {
  setSidebarWidth($("left-pane").getBoundingClientRect().width);
});
setSidebarWidth(mainPane.getBoundingClientRect().width * 0.27);

const helpMenuButton = $("helpMenuButton");
const helpMenuItems = $("helpMenuItems");
const aboutDialog = $("aboutDialog");
function closeHelpMenu() {
  helpMenuItems.classList.add("hidden");
  helpMenuButton.setAttribute("aria-expanded", "false");
}
helpMenuButton.onclick = () => {
  const isOpen = !helpMenuItems.classList.contains("hidden");
  helpMenuItems.classList.toggle("hidden", isOpen);
  helpMenuButton.setAttribute("aria-expanded", String(!isOpen));
};
$("aboutMenuItem").onclick = async () => {
  closeHelpMenu();
  const info = await window.dexapi.aboutInfo();
  $("aboutVersion").textContent = info.version;
  $("aboutPlatform").textContent = info.platform;
  $("aboutElectron").textContent = info.electron;
  $("aboutChromium").textContent = info.chromium;
  $("aboutNode").textContent = info.node;
  aboutDialog.showModal();
};
$("closeAbout").onclick = () => aboutDialog.close();
aboutDialog.onclick = (event) => {
  if (event.target === aboutDialog) aboutDialog.close();
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".help-menu")) closeHelpMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeHelpMenu();
});

window.__dex = { state, renderSummary, renderTree, showClassDetail, showMethodDetail, showFieldDetail, refreshDiffNav, gotoDiff, smaliLineHTML, updateComparisonProgress };
