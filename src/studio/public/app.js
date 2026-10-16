const editor = document.getElementById("editor");
const tree = document.getElementById("tree");
const fileMenu = document.getElementById("file-menu");
const stage = document.getElementById("stage");
const menu = document.getElementById("menu");
const statusEl = document.getElementById("status");
const testLogsEl = document.getElementById("test-logs");
const sectionLogsEl = document.getElementById("section-logs");
const appLogsEl = document.getElementById("app-logs");
const appLogListEl = document.getElementById("app-log-list");
const logSearchEl = document.getElementById("log-search");
let logTab = "test";
let logPoll = 0;
const expandedSections = new Set();
const fileLabel = document.getElementById("file-label");

let currentPath = "";
let treeState = { name: "Workspace", children: [] };
let expanded = null;
let selectedDir = "";
let pendingCreate = null;
let committing = false;
let menuPath = "";
let menuKind = "dir";
let nodes = [];
let imageSize = { width: 1, height: 1 };
let poll = 0;
let selected = null;
let mode = "inspect";
const channel = new BroadcastChannel("solidFlow-studio");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + (kind || "muted");
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function yamlStep(command, selector) {
  const needsQuotes = /[:#\n"']|\s/.test(selector);
  const value = needsQuotes ? JSON.stringify(selector) : selector;
  if (command === "inputText") return `- inputText: ${JSON.stringify(selector + "|")}`;
  if (command === "launchApp" || command === "stopApp" || command === "clearState") return `- ${command}`;
  if (!selector) return `- ${command}`;
  return `- ${command}: ${value}`;
}

function insertLine(line) {
  pushHistory("insert");
  const value = editor.value;
  const pos = editor.selectionStart ?? value.length;
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  const prefix = before.endsWith("\n") || before.length === 0 ? "" : "\n";
  const suffix = after.startsWith("\n") || after.length === 0 ? "\n" : "\n";
  const next = (before + prefix + line).length;
  editor.value = before + prefix + line + suffix + after;
  // Assigning value parks the caret at the end. Focusing first would scroll
  // that caret into view, so the editor jumps to the last line.
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(next, next);
  revealEditorCaret(next);
  noteCommitted();
  updateDirty();
}

function revealEditorCaret(index) {
  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || editor.scrollHeight / Math.max(1, editor.value.split("\n").length);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText = "position:absolute;visibility:hidden;left:0;top:0;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;pointer-events:none";
  mirror.style.boxSizing = style.boxSizing;
  mirror.style.width = editor.clientWidth + "px";
  mirror.style.padding = style.padding;
  mirror.style.borderTopWidth = style.borderTopWidth;
  mirror.style.borderRightWidth = style.borderRightWidth;
  mirror.style.borderBottomWidth = style.borderBottomWidth;
  mirror.style.borderLeftWidth = style.borderLeftWidth;
  mirror.style.borderStyle = "solid";
  mirror.style.font = style.font;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.tabSize = style.tabSize;
  mirror.textContent = editor.value.slice(0, index);
  const mark = document.createElement("span");
  mark.textContent = ".";
  mirror.append(mark);
  document.body.append(mirror);
  const top = mark.offsetTop;
  mirror.remove();
  const bottom = top + lineHeight;
  const viewTop = editor.scrollTop;
  const viewBottom = viewTop + editor.clientHeight;
  if (top < viewTop) editor.scrollTop = top;
  else if (bottom > viewBottom) editor.scrollTop = bottom - editor.clientHeight;
}

let savedContent = "";
let history = [];
let redo = [];
let historyLock = false;
let burst = null;
let shortcutHistory = false;
let committed = null;
let inputNoted = false;

function editorSnapshot() {
  return {
    value: editor.value,
    start: editor.selectionStart ?? 0,
    end: editor.selectionEnd ?? 0,
    scroll: editor.scrollTop
  };
}

function updateDirty() {
  const dot = document.getElementById("save");
  dot.hidden = !currentPath || editor.value === savedContent;
}

function markClean() {
  savedContent = editor.value;
  updateDirty();
}

function resetHistory() {
  history = [];
  redo = [];
  burst = null;
}

function noteCommitted() {
  committed = editorSnapshot();
}

function pushHistory(kind, snap = editorSnapshot()) {
  if (historyLock) return;
  const now = Date.now();
  if ((kind === "type" || kind === "delete") && burst && burst.kind === kind && now < burst.until && Math.abs(snap.start - burst.caret) <= 1) {
    burst.until = now + 450;
    burst.caret = snap.start;
    return;
  }
  const last = history[history.length - 1];
  if (last && last.value === snap.value && last.start === snap.start && last.end === snap.end) {
    burst = null;
    return;
  }
  history.push(snap);
  if (history.length > 300) history.shift();
  redo = [];
  burst = kind === "type" || kind === "delete" ? { kind, until: now + 450, caret: snap.start } : null;
}

function restoreSnapshot(snap) {
  historyLock = true;
  burst = null;
  editor.value = snap.value;
  editor.focus({ preventScroll: true });
  const end = Math.min(snap.end, editor.value.length);
  const start = Math.min(snap.start, end);
  editor.setSelectionRange(start, end);
  editor.scrollTop = snap.scroll;
  historyLock = false;
  noteCommitted();
  updateDirty();
}

function undoEdit() {
  if (!history.length) return;
  redo.push(editorSnapshot());
  restoreSnapshot(history.pop());
}

function redoEdit() {
  if (!redo.length) return;
  history.push(editorSnapshot());
  restoreSnapshot(redo.pop());
}

function applyEditorText(next) {
  if (next === editor.value) return false;
  const snap = editorSnapshot();
  pushHistory("format");
  historyLock = true;
  editor.value = next;
  const caret = Math.min(snap.start, editor.value.length);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(caret, caret);
  revealEditorCaret(caret);
  historyLock = false;
  noteCommitted();
  updateDirty();
  return true;
}

function formatStatus(issues, changed) {
  if (issues.length) {
    const preview = issues.slice(0, 2).join("; ");
    const more = issues.length > 2 ? ` (+${issues.length - 2} more)` : "";
    return preview + more;
  }
  return changed ? "Formatted" : "No spacing changes";
}

async function formatDocument() {
  try {
    const before = editor.value;
    const result = await api("/api/format", {
      method: "POST",
      body: JSON.stringify({ content: before })
    });
    const changed = result.content !== before;
    if (changed) applyEditorText(result.content);
    setStatus(formatStatus(result.issues || [], changed), "ok");
  } catch (err) {
    setStatus(err.message, "bad");
  }
}

async function loadTree() {
  treeState = await api("/api/tree");
  if (!expanded) {
    expanded = new Set([""]);
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        if (node.kind !== "dir") continue;
        if (depth < 3) expanded.add(node.path);
        walk(node.children || [], depth + 1);
      }
    };
    walk(treeState.children || [], 0);
  }
  renderTree();
}

function renderTree() {
  tree.innerHTML = "";
  appendNode({ name: treeState.name || "Workspace", path: "", kind: "dir", children: treeState.children || [] }, 0);
}

function appendNode(node, depth) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  row.dataset.path = node.path;
  row.dataset.kind = node.kind;
  row.setAttribute("role", "treeitem");
  row.style.paddingLeft = `${6 + depth * 14}px`;
  if (node.kind === "file" && node.path === currentPath) row.classList.add("active");
  if (node.kind === "dir" && node.path === selectedDir) row.classList.add("selected");
  const open = node.kind === "dir" && expanded.has(node.path);
  if (node.kind === "dir") row.setAttribute("aria-expanded", open ? "true" : "false");

  const twist = document.createElement("span");
  twist.className = "twist" + (node.kind === "dir" ? (open ? " open" : "") : " leaf");
  twist.append(document.createElement("i"));
  const icon = document.createElement("span");
  icon.className = "tree-icon " + (node.kind === "dir" ? "dir" : "file");
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name;
  row.append(twist, icon, label);
  row.onclick = event => {
    if (node.kind === "dir") {
      selectedDir = node.path;
      if (event.target.closest(".twist") || event.detail === 2) {
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
      }
      renderTree();
      return;
    }
    openFile(node.path).catch(err => setStatus(err.message, "bad"));
  };
  tree.append(row);

  if (node.kind !== "dir" || !open) return;
  if (pendingCreate && pendingCreate.parent === node.path) appendCreateRow(depth + 1);
  for (const child of node.children || []) appendNode(child, depth + 1);
}

function appendCreateRow(depth) {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.style.paddingLeft = `${6 + depth * 14}px`;
  const twist = document.createElement("span");
  twist.className = "twist leaf";
  twist.append(document.createElement("i"));
  const icon = document.createElement("span");
  icon.className = "tree-icon " + (pendingCreate.kind === "folder" ? "dir" : "file");
  const input = document.createElement("input");
  input.className = "tree-input";
  input.value = pendingCreate.kind === "folder" ? "new-folder" : "untitled.yaml";
  input.spellcheck = false;
  row.append(twist, icon, input);
  tree.append(row);
  queueMicrotask(() => {
    input.focus();
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      pendingCreate = null;
      renderTree();
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitCreate(input.value).catch(err => setStatus(err.message, "bad"));
    }
  });
  input.addEventListener("blur", () => {
    if (committing || !pendingCreate) return;
    commitCreate(input.value).catch(err => setStatus(err.message, "bad"));
  });
}

function createParent() {
  if (menuKind === "file") return parentDir(menuPath);
  return menuPath;
}

function defaultParent() {
  if (selectedDir) return selectedDir;
  if ((treeState.children || []).some(node => node.kind === "dir" && node.name === "flows")) return "flows";
  return "";
}

function parentDir(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function beginCreate(kind, parent) {
  fileMenu.hidden = true;
  if (!expanded) expanded = new Set([""]);
  pendingCreate = { kind, parent };
  expanded.add(parent);
  let cursor = parent;
  while (cursor) {
    expanded.add(cursor);
    cursor = parentDir(cursor);
  }
  expanded.add("");
  renderTree();
}

async function commitCreate(raw) {
  if (!pendingCreate || committing) return;
  const name = raw.trim();
  if (!name) {
    pendingCreate = null;
    renderTree();
    return;
  }
  committing = true;
  const { kind, parent } = pendingCreate;
  pendingCreate = null;
  try {
    const path = parent ? `${parent}/${name}` : name;
    if (kind === "folder") {
      const created = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
      expanded.add(created.path);
      selectedDir = created.path;
      await loadTree();
    } else {
      const created = await api("/api/file", { method: "POST", body: JSON.stringify({ path }) });
      await openFile(created.path);
    }
  } catch (err) {
    setStatus(err.message, "bad");
    await loadTree();
  } finally {
    committing = false;
  }
}

function findPreferredFlow(nodes) {
  const flows = (nodes || []).find(node => node.kind === "dir" && node.name === "flows");
  const inFlows = flows ? findFile(flows.children || [], node => /\.ya?ml$/i.test(node.name)) : null;
  if (inFlows) return inFlows;
  return findFile(nodes || [], node => /\.ya?ml$/i.test(node.name) && !node.path.startsWith(".solidflow/"));
}

function findFile(nodes, pred) {
  for (const node of nodes) {
    if (node.kind === "file" && pred(node)) return node;
    if (node.children) {
      const found = findFile(node.children, pred);
      if (found) return found;
    }
  }
  return null;
}

function showFileMenu(x, y) {
  fileMenu.hidden = false;
  fileMenu.style.left = "0px";
  fileMenu.style.top = "0px";
  const rect = fileMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  fileMenu.style.left = Math.max(8, left) + "px";
  fileMenu.style.top = Math.max(8, top) + "px";
}

async function openFile(path) {
  const data = await api("/api/file?path=" + encodeURIComponent(path));
  currentPath = path;
  fileLabel.textContent = path;
  historyLock = true;
  editor.value = data.content;
  historyLock = false;
  resetHistory();
  markClean();
  noteCommitted();
  selectedDir = parentDir(path);
  await loadTree();
}

async function save() {
  if (!currentPath) {
    setStatus("Create or open a flow first", "bad");
    return;
  }
  const result = await api("/api/file", {
    method: "PUT",
    body: JSON.stringify({ path: currentPath, content: editor.value })
  });
  if (result.content !== undefined) applyEditorText(result.content);
  markClean();
  const issues = result.issues || [];
  setStatus(issues.length ? `Saved ${currentPath} — ${formatStatus(issues, true)}` : `Saved ${currentPath}`, "ok");
}

function renderSnapshot(snap) {
  nodes = snap.nodes || [];
  stage.innerHTML = "";
  if (!snap.image) {
    stage.style.removeProperty("--stage-ratio");
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = snap.error || "Connect the app, then click a control in this preview to insert a YAML command.";
    stage.append(empty);
    return;
  }
  // Size the stage to the captured window (e.g. portrait popup) immediately so it is not
  // letterboxed inside the default landscape --stage-ratio.
  if (snap.width > 0 && snap.height > 0) {
    imageSize = { width: snap.width, height: snap.height };
    stage.style.setProperty("--stage-ratio", String(snap.width / snap.height));
  }
  const img = document.createElement("img");
  img.src = snap.image;
  img.alt = "Device screenshot";
  img.onload = () => {
    imageSize = { width: img.naturalWidth, height: img.naturalHeight };
    if (imageSize.height > 0) stage.style.setProperty("--stage-ratio", String(imageSize.width / imageSize.height));
  };
  img.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = img.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    void pickElement(nx, ny, event.clientX, event.clientY);
  });
  stage.append(img);
  const box = solidFlowCreateHighlight();
  stage.append(box);
  img.onmousemove = event => {
    const rect = img.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * (imageSize.width || rect.width);
    const y = ((event.clientY - rect.top) / rect.height) * (imageSize.height || rect.height);
    solidFlowPlaceHighlight(box, hitTest(x, y), imageSize, rect);
  };
}

function hitTest(x, y) {
  return solidFlowHitTest(nodes, x, y, imageSize);
}

async function pickElement(nx, ny, clientX, clientY) {
  window.clearInterval(poll);
  poll = 0;
  const local = hitTest(nx * (imageSize.width || 1), ny * (imageSize.height || 1));
  try {
    const hit = local && local.selector
      ? local
      : await api("/api/pick", { method: "POST", body: JSON.stringify({ nx, ny }) });
    if (!hit || !hit.selector) {
      setStatus("No element under the pointer. Click a button, field, or radio.", "bad");
      return;
    }
    selected = hit;
    setStatus("Choose a command for " + (hit.label || hit.selector), "ok");
    await showMenu(clientX, clientY, hit);
  } catch (err) {
    setStatus(err.message, "bad");
  } finally {
    if (menu.hidden && !poll) startPoll();
  }
}

function showMenu(x, y, node) {
  selected = node;
  return window.SolidFlowMenu.open(menu, x, y, {
    selector: node.selector,
    label: node.label,
    onInsert: yaml => {
      insertLine(yaml);
      hideMenu();
    },
    onRun: yaml => {
      insertLine(yaml);
      hideMenu();
      document.getElementById("run").click();
    },
    onStatus: text => setStatus(text, "ok")
  });
}

function hideMenu() {
  menu.hidden = true;
  if (!poll) startPoll();
}

function startPoll() {
  window.clearInterval(poll);
  poll = window.setInterval(refresh, mode === "record" ? 400 : 1500);
}

async function setMode(next) {
  mode = next;
  const workspace = document.querySelector(".workspace");
  const shell = document.querySelector(".app");
  workspace.classList.toggle("inspect", mode === "inspect");
  workspace.classList.toggle("record", mode === "record");
  shell.classList.toggle("inspect", mode === "inspect");
  shell.classList.toggle("record", mode === "record");
  document.getElementById("inspect-panel").hidden = mode !== "inspect";
  document.getElementById("preview-split").hidden = mode !== "inspect";
  document.getElementById("record-panel").hidden = mode !== "record";
  document.getElementById("popout").hidden = mode !== "inspect";
  document.getElementById("mode-inspect").classList.toggle("active", mode === "inspect");
  document.getElementById("mode-record").classList.toggle("active", mode === "record");
  document.getElementById("mode-inspect").setAttribute("aria-selected", mode === "inspect" ? "true" : "false");
  document.getElementById("mode-record").setAttribute("aria-selected", mode === "record" ? "true" : "false");
  document.getElementById("mode-status").textContent = mode === "record"
    ? "Record — use the CIM window"
    : "Inspect — click the preview";
  await api("/api/record/pause", {
    method: "POST",
    body: JSON.stringify({ paused: mode !== "record" })
  }).catch(() => {});
  startPoll();
  if (mode === "inspect") void refresh();
  void api("/api/logs", {
    method: "POST",
    body: JSON.stringify({ message: `Switched to ${mode} mode` })
  }).catch(() => {});
}

function appendRecorded(line) {
  pushHistory("insert");
  const value = editor.value.replace(/\s*$/, "");
  const stop = value.lastIndexOf("\n- stopApp");
  if (stop >= 0) {
    editor.value = value.slice(0, stop) + "\n" + line + value.slice(stop) + "\n";
  } else {
    editor.value = (value ? value + "\n" : "") + line + "\n";
  }
  noteCommitted();
  updateDirty();
}

async function connect() {
  setStatus("Connecting app…");
  try {
    if (!currentPath) {
      setStatus("Open a flow and set appPath to the exe.", "bad");
      return;
    }
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ path: currentPath, content: editor.value })
    });
    await setMode(mode);
    if (mode === "inspect") {
      const snap = await api("/api/session");
      renderSnapshot(snap);
    }
  } catch (err) {
    setStatus(err.message, "bad");
  }
}

async function refresh() {
  if (mode === "record") {
    try {
      const data = await api("/api/record");
      for (const line of data.lines || []) {
        appendRecorded(line);
      }
    } catch {
      // keep recording if one poll fails
    }
    return;
  }
  if (menu.hidden === false) return;
  try {
    const snap = await api("/api/session");
    if (snap.image || snap.error) renderSnapshot(snap);
  } catch {
    // keep the last frame if a refresh fails
  }
}

function fillCommands() {
  window.SolidFlowMenu.currentSelector = () => (selected ? selected.selector : "");
  return window.SolidFlowMenu.renderSidebar(document.getElementById("commands"), insertLine);
}

document.getElementById("mode-inspect").onclick = () => setMode("inspect");
document.getElementById("mode-record").onclick = () => setMode("record");
document.getElementById("popout").onclick = () => {
  window.open("/preview.html", "solidFlow-preview", "popup,width=1100,height=820");
};
channel.onmessage = event => {
  if (event.data?.type === "insert" && event.data.line) {
    insertLine(event.data.line);
    if (event.data.run) document.getElementById("run").click();
  }
};
document.getElementById("connect-app").onclick = () => connect();
document.getElementById("disconnect").onclick = async () => {
  window.clearInterval(poll);
  await api("/api/session", { method: "DELETE" });
  renderSnapshot({ nodes: [] });
  setStatus("Disconnected");
};
document.getElementById("save").onclick = () => save().catch(err => setStatus(err.message, "bad"));

let testRunning = false;
const runBtn = document.getElementById("run");

function setRunButton(mode) {
  if (mode === "stop") {
    runBtn.textContent = "Stop test";
    runBtn.classList.remove("btn-primary");
    runBtn.classList.add("btn-stop");
  } else {
    runBtn.textContent = "Run test";
    runBtn.classList.remove("btn-stop");
    runBtn.classList.add("btn-primary");
  }
}

runBtn.onclick = async () => {
  if (testRunning) {
    setStatus("Stopping after the current step…");
    try {
      await api("/api/run/stop", { method: "POST" });
    } catch (err) {
      setStatus(err.message, "bad");
    }
    return;
  }
  if (!currentPath) {
    setStatus("Open a flow first", "bad");
    return;
  }
  if (!/\.ya?ml$/i.test(currentPath)) {
    setStatus("Open a YAML flow to run it", "bad");
    return;
  }
  testRunning = true;
  setRunButton("stop");
  setStatus("Running on the app window…");
  showLogTab("test");
  window.clearInterval(poll);
  poll = 0;
  let previewSeq = -1;
  const liveTimer = window.setInterval(() => {
    void refreshLogs();
    void refreshRunPreview();
  }, 400);
  async function refreshRunPreview() {
    if (menu.hidden === false) return;
    try {
      const snap = await api("/api/session");
      if (!snap.image || snap.seq == null || snap.seq === previewSeq) return;
      previewSeq = snap.seq;
      renderSnapshot(snap);
    } catch {
      // Keep the last frame if one refresh fails.
    }
  }
  try {
    const result = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ path: currentPath, content: editor.value })
    });
    if (result.status === "passed") {
      setStatus("Passed", "ok");
    } else if (result.status === "stopped") {
      setStatus("Stopped", "muted");
    } else {
      setStatus(result.error || "Failed", "bad");
    }
  } catch (err) {
    setStatus(err.message, "bad");
  } finally {
    testRunning = false;
    setRunButton("run");
    window.clearInterval(liveTimer);
    startPoll();
    void refreshLogs();
  }
};

function showLogTab(next) {
  logTab = next;
  document.getElementById("tab-test").classList.toggle("active", next === "test");
  document.getElementById("tab-sections").classList.toggle("active", next === "sections");
  document.getElementById("tab-app").classList.toggle("active", next === "app");
  testLogsEl.hidden = next !== "test";
  sectionLogsEl.hidden = next !== "sections";
  appLogsEl.hidden = next !== "app";
}

function formatDuration(ms) {
  if (ms == null) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function formatClock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

let testSignature = "";
let sectionSignature = "";
let latestTestRuns = [];

function statusMark(status) {
  if (status === "failed") return "✕";
  if (status === "running" || status === "stopping") return "…";
  if (status === "stopped") return "■";
  if (status === "skipped" || status === "pending") return "–";
  return "✓";
}

function formatStatusLabel(status, completed, total) {
  const label =
    status === "pending" ? "Pending" : status.charAt(0).toUpperCase() + status.slice(1);
  if (total == null) return label;
  return label + " (" + completed + "/" + total + ")";
}

function renderTestLogs(runs) {
  const signature = JSON.stringify(runs);
  if (signature === testSignature) return;
  testSignature = signature;
  const scroll = testLogsEl.scrollTop;
  testLogsEl.innerHTML = "";
  if (!runs.length) {
    testLogsEl.textContent = "No test runs yet.";
    return;
  }
  for (const run of runs) {
    const block = document.createElement("article");
    block.className = "log-run";
    const total = run.steps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
    const title = document.createElement("div");
    title.className = "log-run-title";
    title.textContent = run.name;
    const meta = document.createElement("div");
    meta.className = "log-run-meta";
    const clock = document.createElement("span");
    clock.textContent = formatClock(run.startedAt);
    const mark = document.createElement("span");
    mark.className = "mark " + run.status;
    mark.textContent = statusMark(run.status);
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = run.status === "running" && !total ? "" : formatDuration(total);
    meta.append(clock, mark, time);
    block.append(title, meta);
    for (const step of run.steps) {
      const row = document.createElement("div");
      row.className = "log-step " + step.status;
      const icon = document.createElement("span");
      icon.className = "mark";
      icon.textContent = statusMark(step.status);
      const label = document.createElement("span");
      label.textContent = step.label || step.command;
      const secs = document.createElement("span");
      secs.className = "secs";
      secs.textContent = step.durationMs == null ? "" : formatDuration(step.durationMs);
      row.append(icon, label, secs);
      if (step.error) {
        const err = document.createElement("div");
        err.className = "err";
        err.textContent = step.error;
        row.append(err);
      }
      block.append(row);
    }
    testLogsEl.append(block);
  }
  testLogsEl.scrollTop = scroll;
}

function shortCommand(command) {
  if (!command) return "";
  const match = /^(\w+)/.exec(command);
  return match ? match[1] : command;
}

function renderSectionLogs(runs) {
  const signature = JSON.stringify(
    runs.map(run => ({
      id: run.id,
      status: run.status,
      sections: run.sections
    }))
  );
  if (signature === sectionSignature) return;
  sectionSignature = signature;
  const scroll = sectionLogsEl.scrollTop;
  sectionLogsEl.innerHTML = "";
  if (!runs.length) {
    sectionLogsEl.textContent = "No test runs yet.";
    return;
  }
  for (const run of runs) {
    const block = document.createElement("article");
    block.className = "log-run";
    const title = document.createElement("div");
    title.className = "log-run-title";
    title.textContent = run.name;
    const meta = document.createElement("div");
    meta.className = "log-run-meta";
    const clock = document.createElement("span");
    clock.textContent = formatClock(run.startedAt);
    const mark = document.createElement("span");
    mark.className = "mark " + run.status;
    mark.textContent = statusMark(run.status);
    meta.append(clock, mark);
    block.append(title, meta);

    const sections = (run.sections || []).slice().sort((a, b) => a.number - b.number);
    if (!sections.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "No sections in this run.";
      block.append(empty);
      sectionLogsEl.append(block);
      continue;
    }

    const table = document.createElement("div");
    table.className = "section-table";
    const head = document.createElement("div");
    head.className = "section-row section-head";
    head.innerHTML =
      "<span></span><span>Number</span><span>Name</span><span>Description</span><span>Status</span>";
    table.append(head);

    for (const section of sections) {
      const key = run.id + ":" + section.number;
      const open = expandedSections.has(key);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "section-row section-summary " + section.status;
      row.setAttribute("aria-expanded", open ? "true" : "false");
      const toggle = document.createElement("span");
      toggle.className = "section-toggle";
      toggle.textContent = open ? "▼" : "▶";
      const number = document.createElement("span");
      number.textContent = String(section.number);
      const name = document.createElement("span");
      name.textContent = section.name;
      const description = document.createElement("span");
      description.textContent = section.description || "";
      const status = document.createElement("span");
      status.className = "section-status mark " + section.status;
      status.textContent = formatStatusLabel(
        section.status,
        section.completedSteps,
        section.totalSteps
      );
      row.append(toggle, number, name, description, status);
      row.onclick = () => {
        if (expandedSections.has(key)) expandedSections.delete(key);
        else expandedSections.add(key);
        sectionSignature = "";
        renderSectionLogs(latestTestRuns);
      };
      table.append(row);

      if (open) {
        const details = document.createElement("div");
        details.className = "section-details";
        for (const step of section.steps || []) {
          const stepRow = document.createElement("div");
          stepRow.className = "log-step section-step " + step.status;
          const icon = document.createElement("span");
          icon.className = "mark";
          icon.textContent = statusMark(step.status);
          const label = document.createElement("span");
          label.textContent = step.label || shortCommand(step.command) || step.command;
          stepRow.append(icon, label);
          details.append(stepRow);
        }
        if (section.failure) {
          const fail = document.createElement("div");
          fail.className = "section-failure";
          fail.innerHTML =
            "<strong>Failed Command:</strong> " +
            escapeHtml(section.failure.command) +
            "<br/><strong>Error:</strong> " +
            escapeHtml(section.failure.error) +
            "<br/><strong>Timestamp:</strong> " +
            escapeHtml(formatFailureTime(section.failure.timestamp));
          details.append(fail);
        }
        table.append(details);
      }
    }
    block.append(table);
    sectionLogsEl.append(block);
  }
  sectionLogsEl.scrollTop = scroll;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFailureTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds())
  );
}

let appSignature = "";
let latestAppEntries = [];

function renderAppLogs(entries) {
  const query = (logSearchEl.value || "").trim().toLowerCase();
  const signature = query + "\n" + JSON.stringify(entries);
  if (signature === appSignature) return;
  appSignature = signature;
  const rows = query
    ? entries.filter(entry => (entry.message + " " + entry.level).toLowerCase().includes(query))
    : entries;
  appLogListEl.innerHTML = "";
  if (!rows.length) {
    appLogListEl.textContent = query ? "No app logs match that search." : "No app logs yet.";
    return;
  }
  for (const entry of rows) {
    const row = document.createElement("div");
    row.className = "app-line " + entry.level;
    const time = document.createElement("span");
    time.textContent = formatClock(entry.at);
    const level = document.createElement("span");
    level.textContent = entry.level;
    const message = document.createElement("span");
    message.textContent = entry.message;
    row.append(time, level, message);
    appLogListEl.append(row);
  }
}

async function refreshLogs() {
  try {
    const [tests, apps] = await Promise.all([
      api("/api/logs?kind=test"),
      api("/api/logs?kind=app")
    ]);
    latestTestRuns = tests.runs || [];
    renderTestLogs(latestTestRuns);
    renderSectionLogs(latestTestRuns);
    latestAppEntries = apps.entries || [];
    renderAppLogs(latestAppEntries);
  } catch {
    // the panel updates again on the next poll
  }
}

document.getElementById("tab-test").onclick = () => showLogTab("test");
document.getElementById("tab-sections").onclick = () => showLogTab("sections");
document.getElementById("tab-app").onclick = () => showLogTab("app");
logSearchEl.addEventListener("input", () => {
  renderAppLogs(latestAppEntries);
});
document.getElementById("clear-logs").onclick = async () => {
  const kind = logTab === "sections" ? "test" : logTab;
  await api("/api/logs?kind=" + kind, { method: "DELETE" });
  void refreshLogs();
};
logPoll = window.setInterval(() => {
  void refreshLogs();
}, 1000);
void refreshLogs();
function shortcutTarget(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement) return false;
  if (target instanceof HTMLTextAreaElement && target !== editor) return false;
  return true;
}

document.addEventListener("keydown", event => {
  if (!shortcutTarget(event) || event.isComposing) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey && !event.altKey && event.code === "KeyS") {
    event.preventDefault();
    save().catch(err => setStatus(err.message, "bad"));
    return;
  }
  if (!mod && event.shiftKey && event.altKey && event.code === "KeyF") {
    if (event.repeat) return;
    event.preventDefault();
    formatDocument();
    return;
  }
  if (mod && !event.shiftKey && !event.altKey && event.code === "KeyZ") {
    event.preventDefault();
    shortcutHistory = true;
    undoEdit();
    queueMicrotask(() => {
      shortcutHistory = false;
    });
    return;
  }
  if (mod && (event.code === "KeyY" || (event.shiftKey && event.code === "KeyZ")) && !event.altKey) {
    event.preventDefault();
    shortcutHistory = true;
    redoEdit();
    queueMicrotask(() => {
      shortcutHistory = false;
    });
  }
});
editor.addEventListener("beforeinput", event => {
  if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
    event.preventDefault();
    if (!shortcutHistory) {
      if (event.inputType === "historyUndo") undoEdit();
      else redoEdit();
    }
    inputNoted = true;
    return;
  }
  inputNoted = true;
  const kind = event.inputType && event.inputType.startsWith("delete")
    ? "delete"
    : event.inputType === "insertText" || event.inputType === "insertLineBreak" || event.inputType === "insertCompositionText"
      ? "type"
      : "edit";
  pushHistory(kind);
});
editor.addEventListener("input", () => {
  if (historyLock) return;
  if (!inputNoted && committed && committed.value !== editor.value) pushHistory("edit", committed);
  inputNoted = false;
  noteCommitted();
  updateDirty();
});
noteCommitted();
document.addEventListener("click", event => {
  if (!menu.contains(event.target)) hideMenu();
});

const LAYOUT_KEY = "solidFlow.studio.layout";
const layout = { side: 380, flows: 240, log: 280, preview: 220 };
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  for (const key of ["side", "flows", "log", "preview"]) {
    if (Number.isFinite(saved[key])) layout[key] = saved[key];
  }
} catch {
  // keep the defaults when storage is unavailable
}

function applyLayout() {
  const root = document.documentElement;
  root.style.setProperty("--side-width", layout.side + "px");
  root.style.setProperty("--flows-width", layout.flows + "px");
  root.style.setProperty("--log-height", layout.log + "px");
  root.style.setProperty("--preview-height", layout.preview + "px");
}

function clampSize(value, min, max) {
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(min, value));
}

function layoutLimits() {
  const app = document.querySelector(".app");
  const work = document.querySelector(".work");
  return {
    side: app.clientWidth - layout.flows - 300,
    flows: work.clientWidth - 280,
    log: work.clientHeight - 160,
    preview: document.querySelector(".side").clientHeight - 180
  };
}

function installSplitters() {
  applyLayout();
  const defaults = { side: 380, flows: 240, log: 280, preview: 220 };
  for (const handle of document.querySelectorAll(".split")) {
    const kind = handle.dataset.split;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("active");
      document.body.classList.add("resizing");
      document.body.style.cursor = kind === "side" || kind === "flows" ? "col-resize" : "row-resize";
      const origin = { x: event.clientX, y: event.clientY, ...layout };
      const move = ev => {
        const limits = layoutLimits();
        if (kind === "side") layout.side = clampSize(origin.side + (ev.clientX - origin.x), 200, limits.side);
        if (kind === "flows") layout.flows = clampSize(origin.flows - (ev.clientX - origin.x), 160, limits.flows);
        if (kind === "log") layout.log = clampSize(origin.log - (ev.clientY - origin.y), 120, limits.log);
        if (kind === "preview") layout.preview = clampSize(origin.preview + (ev.clientY - origin.y), 120, limits.preview);
        applyLayout();
      };
      const stop = () => {
        handle.classList.remove("active");
        document.body.classList.remove("resizing");
        document.body.style.cursor = "";
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
        } catch {
          // ignore private-mode storage failures
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
    handle.addEventListener("dblclick", () => {
      layout[kind] = defaults[kind];
      applyLayout();
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        // ignore private-mode storage failures
      }
    });
    handle.addEventListener("keydown", event => {
      const step = event.shiftKey ? 48 : 16;
      const limits = layoutLimits();
      let changed = false;
      if (kind === "side" && event.key === "ArrowRight") {
        layout.side = clampSize(layout.side + step, 200, limits.side);
        changed = true;
      } else if (kind === "side" && event.key === "ArrowLeft") {
        layout.side = clampSize(layout.side - step, 200, limits.side);
        changed = true;
      } else if (kind === "flows" && event.key === "ArrowLeft") {
        layout.flows = clampSize(layout.flows + step, 160, limits.flows);
        changed = true;
      } else if (kind === "flows" && event.key === "ArrowRight") {
        layout.flows = clampSize(layout.flows - step, 160, limits.flows);
        changed = true;
      } else if (kind === "log" && event.key === "ArrowUp") {
        layout.log = clampSize(layout.log + step, 120, limits.log);
        changed = true;
      } else if (kind === "log" && event.key === "ArrowDown") {
        layout.log = clampSize(layout.log - step, 120, limits.log);
        changed = true;
      } else if (kind === "preview" && event.key === "ArrowDown") {
        layout.preview = clampSize(layout.preview + step, 120, limits.preview);
        changed = true;
      } else if (kind === "preview" && event.key === "ArrowUp") {
        layout.preview = clampSize(layout.preview - step, 120, limits.preview);
        changed = true;
      }
      if (!changed) return;
      event.preventDefault();
      applyLayout();
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        // ignore private-mode storage failures
      }
    });
  }
  window.addEventListener("resize", () => {
    const limits = layoutLimits();
    layout.flows = clampSize(layout.flows, 160, limits.flows);
    layout.side = clampSize(layout.side, 200, document.querySelector(".app").clientWidth - layout.flows - 300);
    layout.log = clampSize(layout.log, 120, limits.log);
    layout.preview = clampSize(layout.preview, 120, limits.preview);
    applyLayout();
  });
}

const folderModal = document.getElementById("folder-modal");
const folderLabel = document.getElementById("folder-label");
const folderCurrent = document.getElementById("folder-current");
const folderPlaces = document.getElementById("folder-places");
const folderClear = document.getElementById("folder-clear");
const folderDone = document.getElementById("folder-done");
let folderRequired = false;
let pendingFolder = "";
let workspaceState = { path: "", chosen: false, recent: [], places: [] };

function folderName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path;
}

function renderFolderDialog() {
  const selected = Boolean(pendingFolder);
  folderCurrent.classList.toggle("selected", selected);
  folderLabel.textContent = selected ? folderName(pendingFolder) : "Choose a folder";
  folderCurrent.title = selected ? pendingFolder : "Opens File Explorer";
  folderClear.hidden = !selected;
  folderDone.disabled = !selected;
  folderPlaces.innerHTML = "";
  const cards = [];
  for (const path of workspaceState.recent || []) {
    if (cards.length >= 2) break;
    cards.push({ path, name: folderName(path), detail: "Recent" });
  }
  for (const path of workspaceState.places || []) {
    if (cards.length >= 2) break;
    if (cards.some(card => card.path.toLowerCase() === path.toLowerCase())) continue;
    cards.push({ path, name: folderName(path), detail: "Folder" });
  }
  cards.push({ browse: true, name: "Browse", detail: "File Explorer" });
  for (const card of cards.slice(0, 3)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-place" + (!card.browse && pendingFolder && card.path.toLowerCase() === pendingFolder.toLowerCase() ? " selected" : "");
    const icon = document.createElement("span");
    icon.className = "folder-place-icon";
    const title = document.createElement("strong");
    title.textContent = card.name;
    const detail = document.createElement("span");
    detail.textContent = card.detail;
    button.append(icon, title, detail);
    button.onclick = () => {
      if (card.browse) browseForFolder();
      else setPendingFolder(card.path);
    };
    folderPlaces.append(button);
  }
}

function setPendingFolder(path) {
  pendingFolder = path || "";
  renderFolderDialog();
}

function openFolderDialog(required) {
  folderRequired = required;
  pendingFolder = required ? "" : (workspaceState.chosen ? workspaceState.path : "");
  renderFolderDialog();
  document.body.classList.add("picking");
  folderModal.hidden = false;
}

function closeFolderDialog() {
  if (folderRequired && !workspaceState.chosen) return;
  folderModal.hidden = true;
  document.body.classList.remove("picking");
  if (location.search.includes("welcome=1")) history.replaceState(null, "", "/");
}

function browseForFolder() {
  const host = window.chrome && window.chrome.webview;
  if (host) {
    host.postMessage({ type: "pick-folder", path: pendingFolder || workspaceState.path || "" });
    return;
  }
  const next = window.prompt("Workspace folder", pendingFolder || workspaceState.path || "");
  if (next) setPendingFolder(next);
}

async function confirmFolder() {
  if (!pendingFolder) return;
  folderDone.disabled = true;
  try {
    workspaceState = await api("/api/workspace", {
      method: "POST",
      body: JSON.stringify({ path: pendingFolder })
    });
    const host = window.chrome && window.chrome.webview;
    if (host) host.postMessage({ type: "workspace-opened", path: workspaceState.path });
    folderRequired = false;
    closeFolderDialog();
    const button = document.getElementById("workspace");
    document.getElementById("workspace-name").textContent = folderName(workspaceState.path);
    button.title = workspaceState.path;
    button.setAttribute("aria-label", "Select workspace, " + workspaceState.path);
    currentPath = "";
    historyLock = true;
    editor.value = "";
    historyLock = false;
    resetHistory();
    markClean();
    noteCommitted();
    fileLabel.textContent = "No file";
    expanded = null;
    selectedDir = "";
    pendingCreate = null;
    await loadTree();
    const preferred = findPreferredFlow(treeState.children);
    if (preferred) await openFile(preferred.path);
    const created = workspaceState.created || [];
    setStatus((created.length ? "Created workspace " : "Workspace ") + folderName(workspaceState.path), "ok");
  } catch (err) {
    folderDone.disabled = false;
    setStatus(err.message, "bad");
  }
}

async function refreshWorkspace() {
  workspaceState = await api("/api/workspace");
  const button = document.getElementById("workspace");
  const workspaceName = document.getElementById("workspace-name");
  if (workspaceState.chosen) {
    workspaceName.textContent = folderName(workspaceState.path);
    button.title = workspaceState.path;
    button.setAttribute("aria-label", "Select workspace, " + workspaceState.path);
    if (!folderModal.hidden && !pendingFolder) {
      folderRequired = false;
      closeFolderDialog();
    } else if (!folderModal.hidden) {
      renderFolderDialog();
    }
  } else {
    workspaceName.textContent = "Select workspace";
    button.title = "Select workspace";
    button.setAttribute("aria-label", "Select workspace");
    if (folderModal.hidden) openFolderDialog(true);
    else renderFolderDialog();
  }
}

document.querySelector(".flows-pane").addEventListener("contextmenu", event => {
  event.preventDefault();
  const row = event.target.closest(".tree-row");
  if (row && row.dataset.kind) {
    menuPath = row.dataset.path || "";
    menuKind = row.dataset.kind;
    if (menuKind === "dir") selectedDir = menuPath;
  } else {
    menuPath = selectedDir;
    menuKind = "dir";
  }
  showFileMenu(event.clientX, event.clientY);
});
fileMenu.addEventListener("click", event => {
  event.stopPropagation();
  const action = event.target.closest("button")?.dataset.action;
  if (!action) return;
  fileMenu.hidden = true;
  if (action === "file") beginCreate("file", createParent());
  if (action === "folder") beginCreate("folder", createParent());
  if (action === "reveal") {
    api("/api/reveal", { method: "POST", body: JSON.stringify({ path: menuPath }) }).catch(err => setStatus(err.message, "bad"));
  }
});
document.getElementById("new-file").onclick = () => beginCreate("file", defaultParent());
document.addEventListener("click", () => {
  fileMenu.hidden = true;
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    fileMenu.hidden = true;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && !event.shiftKey && !event.altKey) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    if (!folderModal.hidden) return;
    event.preventDefault();
    beginCreate("file", fileMenu.hidden ? defaultParent() : createParent());
  }
});
document.getElementById("workspace").onclick = () => openFolderDialog(false);
folderCurrent.onclick = () => browseForFolder();
folderClear.onclick = () => setPendingFolder("");
folderDone.onclick = () => {
  confirmFolder().catch(err => setStatus(err.message, "bad"));
};
folderModal.addEventListener("click", event => {
  if (event.target === folderModal) closeFolderDialog();
});
function postWindow(message) {
  const host = window.chrome && window.chrome.webview;
  if (host) host.postMessage(message);
}

function resizeEdge(x, y) {
  if (document.body.classList.contains("maximized")) return "";
  const margin = 6;
  const left = x <= margin;
  const right = x >= window.innerWidth - margin;
  const top = y <= margin;
  const bottom = y >= window.innerHeight - margin;
  if (top && left) return "top-left";
  if (top && right) return "top-right";
  if (bottom && left) return "bottom-left";
  if (bottom && right) return "bottom-right";
  if (left) return "left";
  if (right) return "right";
  if (top) return "top";
  if (bottom) return "bottom";
  return "";
}

function setWindowMaximized(maximized) {
  document.body.classList.toggle("maximized", maximized);
  const button = document.getElementById("win-max");
  if (button) button.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  if (maximized) delete document.documentElement.dataset.edge;
}

function installWindowFrame() {
  const controls = document.querySelector(".window-controls");
  const titlebar = document.querySelector(".titlebar");
  if (!controls || !titlebar) return;
  controls.hidden = false;
  document.body.classList.add("desktop-frame");
  document.getElementById("win-min").onclick = () => postWindow({ type: "window", action: "minimize" });
  document.getElementById("win-max").onclick = () => postWindow({ type: "window", action: "maximize" });
  document.getElementById("win-close").onclick = () => postWindow({ type: "window", action: "close" });
  document.addEventListener("pointermove", event => {
    const edge = resizeEdge(event.clientX, event.clientY);
    if (edge) document.documentElement.dataset.edge = edge;
    else delete document.documentElement.dataset.edge;
  });
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const edge = resizeEdge(event.clientX, event.clientY);
    if (!edge) return;
    event.preventDefault();
    event.stopPropagation();
    postWindow({ type: "window", action: "resize", edge });
  }, true);
  titlebar.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.detail > 1) return;
    if (event.target.closest("button")) return;
    if (resizeEdge(event.clientX, event.clientY)) return;
    const startX = event.screenX;
    const startY = event.screenY;
    const move = ev => {
      if (Math.abs(ev.screenX - startX) + Math.abs(ev.screenY - startY) < 4) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      postWindow({ type: "window", action: "drag" });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  titlebar.addEventListener("dblclick", event => {
    if (event.target.closest("button")) return;
    postWindow({ type: "window", action: "maximize" });
  });
}

if (window.chrome && window.chrome.webview) {
  window.chrome.webview.addEventListener("message", event => {
    const data = event.data;
    if (!data) return;
    if (data.type === "folder-picked" && data.path) setPendingFolder(data.path);
    if (data.type === "window-state") setWindowMaximized(Boolean(data.maximized));
  });
  installWindowFrame();
}
if (new URLSearchParams(location.search).get("welcome") === "1") openFolderDialog(true);

installSplitters();
fillCommands();
refreshWorkspace().catch(err => setStatus(err.message, "bad"));
loadTree().then(async () => {
  const preferred = findPreferredFlow(treeState.children);
  if (preferred) await openFile(preferred.path);
}).catch(err => setStatus(err.message, "bad"));
