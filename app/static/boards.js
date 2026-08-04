const API = "/api";
const AUTOSAVE_DELAY_MS = 800;

async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`${options?.method || "GET"} ${path} failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    background: "#0f1115",
    primaryColor: "#1c202a",
    primaryTextColor: "#e6e8ec",
    primaryBorderColor: "#5b8cff",
    lineColor: "#5b8cff",
    secondaryColor: "#171a21",
    tertiaryColor: "#171a21",
    edgeLabelBackground: "#0f1115",
    clusterBkg: "#171a21",
    fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    fontSize: "14px",
  },
  flowchart: { curve: "basis", htmlLabels: false },
});

let boards = [];
let currentBoardId = null;
let nodes = [], edges = [], groups = [];
let direction = "TD";
let nextId = 1, nextGroupId = 1;
let selectedShape = "stadium";
let selectedNodeId = null, selectedEdge = null, selectedGroupId = null;
let checkedNodeIds = new Set();
let activeTab = "steps";
let newEdgeStyle = "solid";
let undoStack = [];
const MAX_UNDO = 30;
let renderCounter = 0;
let saveTimer = null, dirty = false;

const SHAPES = [
  { key: "stadium", label: "Start/End" },
  { key: "rect", label: "Step" },
  { key: "diamond", label: "Decision" },
  { key: "subroutine", label: "Subroutine" },
  { key: "cylinder", label: "Database" },
  { key: "parallelogram", label: "Input/Output" },
  { key: "hexagon", label: "Note" },
];

const emptyStateEl = document.getElementById("board-empty-state");
const workspaceEl = document.getElementById("boards-workspace");
const canvasFrame = document.getElementById("canvas-frame");
const codeOutput = document.getElementById("code-output");
const boardPopover = document.getElementById("board-popover");
const boardPopoverList = document.getElementById("board-popover-list");
const boardSwitchBtn = document.getElementById("board-switch-btn");
const boardTitleInput = document.getElementById("board-title-input");
const undoBtn = document.getElementById("undo-btn");
const inspectorBody = document.getElementById("inspector-body");

function sanitize(text) { return text.replace(/"/g, "'").replace(/\n/g, " ").trim(); }
function sanitizeEdgeLabel(text) { return sanitize(text).replace(/\|/g, "/"); }

function shapeSwatchSvg(shape) {
  const svgs = {
    rect: '<rect x="1" y="1" width="38" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2"></rect>',
    diamond: '<polygon points="20,1 39,11 20,21 1,11" fill="none" stroke="currentColor" stroke-width="2"></polygon>',
    stadium: '<rect x="1" y="1" width="38" height="20" rx="10" fill="none" stroke="currentColor" stroke-width="2"></rect>',
    subroutine: '<rect x="1" y="1" width="38" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2"></rect><line x1="5" y1="1" x2="5" y2="21" stroke="currentColor" stroke-width="2"></line><line x1="35" y1="1" x2="35" y2="21" stroke="currentColor" stroke-width="2"></line>',
    cylinder: '<path d="M1 5 C1 2 39 2 39 5 L39 17 C39 20 1 20 1 17 Z" fill="none" stroke="currentColor" stroke-width="2"></path><path d="M1 5 C1 8 39 8 39 5" fill="none" stroke="currentColor" stroke-width="2"></path>',
    parallelogram: '<polygon points="10,1 39,1 30,21 1,21" fill="none" stroke="currentColor" stroke-width="2"></polygon>',
    hexagon: '<polygon points="10,1 30,1 39,11 30,21 10,21 1,11" fill="none" stroke="currentColor" stroke-width="2"></polygon>',
  };
  return `<svg class="shape-swatch" viewBox="0 0 40 22">${svgs[shape] || svgs.rect}</svg>`;
}

function arrowSvg(style) {
  const dash = style === "dashed" ? ' stroke-dasharray="6 4"' : style === "dotted" ? ' stroke-dasharray="1.5 4"' : "";
  return `<svg viewBox="0 0 44 16" width="44" height="16"><line x1="1" y1="8" x2="34" y2="8" stroke="currentColor" stroke-width="2"${dash} stroke-linecap="round"></line><polygon points="34,3 42,8 34,13" fill="currentColor"></polygon></svg>`;
}

function wrapLabel(id, label, shape) {
  const safe = sanitize(label) || id;
  switch (shape) {
    case "rect": return `${id}["${safe}"]`;
    case "diamond": return `${id}{"${safe}"}`;
    case "subroutine": return `${id}[["${safe}"]]`;
    case "cylinder": return `${id}[("${safe}")]`;
    case "parallelogram": return `${id}[/"${safe}"/]`;
    case "hexagon": return `${id}{{"${safe}"}}`;
    default: return `${id}(["${safe}"])`;
  }
}

function buildMermaidText() {
  const lines = [`flowchart ${direction}`];
  const byGroup = {};
  for (const n of nodes) {
    if (n.groupId && groups.some((g) => g.id === n.groupId)) (byGroup[n.groupId] ||= []).push(n);
  }
  const grouped = new Set();
  for (const g of groups) {
    const members = byGroup[g.id];
    if (!members || !members.length) continue;
    lines.push(`  subgraph ${g.id}["${sanitize(g.label)}"]`);
    for (const n of members) { lines.push(`    ${wrapLabel(n.id, n.label, n.shape)}`); grouped.add(n.id); }
    lines.push("  end");
  }
  for (const n of nodes) if (!grouped.has(n.id)) lines.push(`  ${wrapLabel(n.id, n.label, n.shape)}`);
  for (const e of edges) {
    const lbl = sanitizeEdgeLabel(e.label || "");
    const arrow = e.style === "dotted" ? "-.->" : "-->";
    lines.push(lbl ? `  ${e.from} ${arrow}|${lbl}| ${e.to}` : `  ${e.from} ${arrow} ${e.to}`);
  }
  for (const g of groups) {
    if (byGroup[g.id] && byGroup[g.id].length) {
      const rounded = g.shape === "rounded" ? ",rx:16,ry:16" : "";
      lines.push(`  style ${g.id} stroke-dasharray: 6 4,fill:transparent,stroke:#5b8cff${rounded}`);
    }
  }
  edges.forEach((e, i) => { if (e.style === "dashed") lines.push(`  linkStyle ${i} stroke-dasharray: 6 4`); });
  return lines.join("\n");
}

async function renderDiagram() {
  codeOutput.textContent = nodes.length ? buildMermaidText() : "flowchart " + direction;
  if (nodes.length === 0) {
    canvasFrame.innerHTML = '<div class="board-canvas-empty"><strong>Nothing here yet</strong>Add a step from the panel on the right.</div>';
    return;
  }
  const id = "board-graph-" + renderCounter++;
  try {
    const { svg } = await mermaid.render(id, buildMermaidText());
    canvasFrame.innerHTML = svg;
    attachNodeClickHandlers();
    highlightSvgSelection();
  } catch (err) {
    canvasFrame.innerHTML = '<div class="board-canvas-empty" style="color: var(--danger);"><strong>Could not render</strong>' + (err && err.message ? err.message : "Check labels for unsupported characters.") + "</div>";
  }
}

function highlightSvgSelection() {
  const svgEl = canvasFrame.querySelector("svg");
  if (!svgEl) return;
  svgEl.querySelectorAll(".node").forEach((g) => g.classList.remove("rc-selected"));
  if (!selectedNodeId) return;
  const g = svgEl.querySelector(`.node[id^="flowchart-${selectedNodeId}-"]`);
  if (g) g.classList.add("rc-selected");
}

function attachNodeClickHandlers() {
  const svgEl = canvasFrame.querySelector("svg");
  if (!svgEl) return;
  svgEl.querySelectorAll(".node").forEach((g) => {
    const m = /^flowchart-(.+)-\d+$/.exec(g.id);
    if (!m) return;
    g.addEventListener("click", (ev) => { ev.stopPropagation(); selectNode(m[1]); });
  });
  svgEl.addEventListener("click", () => selectNode(null));
}

/* ---------------- undo ---------------- */
function snapshotState() {
  return { nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)), groups: JSON.parse(JSON.stringify(groups)), direction };
}
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButtonState();
}
function updateUndoButtonState() {
  undoBtn.disabled = undoStack.length === 0;
}
function undo() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  nodes = prev.nodes; edges = prev.edges; groups = prev.groups; direction = prev.direction;
  selectedNodeId = null; selectedGroupId = null; selectedEdge = null; checkedNodeIds = new Set();
  syncDirToggle();
  updateUndoButtonState();
  refreshAndSave();
}
undoBtn.addEventListener("click", undo);
document.addEventListener("keydown", (ev) => {
  const tag = document.activeElement?.tagName;
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z" && tag !== "INPUT" && tag !== "TEXTAREA") {
    ev.preventDefault();
    undo();
  }
});

function syncDirToggle() {
  document.querySelectorAll("#dir-seg button").forEach((b) => b.classList.toggle("active", b.dataset.dir === direction));
}
document.getElementById("dir-seg").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-dir]");
  if (!btn) return;
  pushUndo();
  direction = btn.dataset.dir;
  syncDirToggle();
  refreshAndSave();
});

/* ---------------- mutations ---------------- */
function computeNextId(arr) {
  let max = 0;
  for (const n of arr) { const m = /^n(\d+)$/.exec(n.id); if (m) max = Math.max(max, +m[1]); }
  return max + 1;
}
function computeNextGroupId(arr) {
  let max = 0;
  for (const g of arr) { const m = /^g(\d+)$/.exec(g.id); if (m) max = Math.max(max, +m[1]); }
  return max + 1;
}

function addNode(label, shape) {
  const clean = sanitize(label);
  if (!clean) return;
  pushUndo();
  const id = "n" + nextId++;
  nodes.push({ id, label: clean, shape });
  refreshAndSave();
}
function removeNode(id) {
  pushUndo();
  nodes = nodes.filter((n) => n.id !== id);
  if (selectedEdge && (selectedEdge.from === id || selectedEdge.to === id)) selectedEdge = null;
  edges = edges.filter((e) => e.from !== id && e.to !== id);
  checkedNodeIds.delete(id);
  if (selectedNodeId === id) selectedNodeId = null;
  refreshAndSave();
}
function selectNode(id) {
  selectedNodeId = selectedNodeId === id ? null : (nodes.some((n) => n.id === id) ? id : null);
  highlightSvgSelection();
  activeTab = "steps"; syncTabButtons();
  renderInspector();
}

function addEdge(from, to, label, style) {
  if (!from || !to || from === to) return;
  pushUndo();
  edges.push({ from, to, label: sanitize(label || ""), style: style || "solid" });
  newEdgeStyle = "solid";
  refreshAndSave();
}
function removeEdge(edge) {
  pushUndo();
  edges = edges.filter((e) => e !== edge);
  if (selectedEdge === edge) selectedEdge = null;
  refreshAndSave();
}
function selectEdge(edge) {
  selectedEdge = selectedEdge === edge ? null : edge;
  activeTab = "connections"; syncTabButtons();
  renderInspector();
}

function removeGroup(id) {
  pushUndo();
  groups = groups.filter((g) => g.id !== id);
  nodes.forEach((n) => { if (n.groupId === id) n.groupId = null; });
  if (selectedGroupId === id) selectedGroupId = null;
  refreshAndSave();
}
function selectGroup(id) {
  selectedGroupId = selectedGroupId === id ? null : id;
  activeTab = "groups"; syncTabButtons();
  renderInspector();
}
function applyGroupToChecked(groupId) {
  for (const nid of checkedNodeIds) {
    const node = nodes.find((n) => n.id === nid);
    if (node) node.groupId = groupId;
  }
  checkedNodeIds.clear();
  refreshAndSave();
}

function refreshUI() {
  renderInspector();
  renderDiagram();
}
function refreshAndSave() {
  refreshUI();
  scheduleSave();
}

/* ---------------- board switcher (popover) ---------------- */
function renderBoardPopover() {
  boardPopoverList.innerHTML = "";
  for (const b of boards) {
    const li = document.createElement("li");
    li.className = "board-popover-item" + (b.id === currentBoardId ? " active" : "");
    li.innerHTML = `<span class="dot"></span><span class="nm">${b.name}</span>`;
    li.addEventListener("click", () => { selectBoard(b.id); closePopover(); });
    li.addEventListener("dblclick", (ev) => { ev.stopPropagation(); startRenamePopoverItem(li, b); });
    boardPopoverList.appendChild(li);
  }
}
function startRenamePopoverItem(li, board) {
  li.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = board.name;
  li.appendChild(input);
  input.focus();
  input.select();
  const commit = async () => {
    const name = input.value.trim();
    if (name && name !== board.name) {
      const updated = await api(`/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ name }) });
      board.name = updated.name;
      if (board.id === currentBoardId) boardTitleInput.value = board.name;
    }
    renderBoardPopover();
  };
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    if (ev.key === "Escape") { input.removeEventListener("blur", commit); renderBoardPopover(); }
  });
}
async function renameCurrentBoard(name) {
  const board = boards.find((b) => b.id === currentBoardId);
  if (!board || !name || name === board.name) return;
  const updated = await api(`/boards/${currentBoardId}`, { method: "PUT", body: JSON.stringify({ name }) });
  board.name = updated.name;
  renderBoardPopover();
}
boardTitleInput.addEventListener("blur", () => renameCurrentBoard(boardTitleInput.value.trim()));
boardTitleInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") boardTitleInput.blur(); });

function openPopover() { boardPopover.classList.add("open"); }
function closePopover() { boardPopover.classList.remove("open"); }
boardSwitchBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  boardPopover.classList.contains("open") ? closePopover() : openPopover();
});
document.addEventListener("click", (ev) => {
  if (!boardPopover.contains(ev.target) && ev.target !== boardSwitchBtn) closePopover();
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePopover(); });

function loadBoardIntoBuilder(board) {
  currentBoardId = board.id;
  nodes = board.nodes.map((n) => ({ ...n }));
  edges = board.edges.map((e) => ({ ...e }));
  groups = (board.groups || []).map((g) => ({ ...g }));
  direction = board.direction;
  nextId = computeNextId(nodes);
  nextGroupId = computeNextGroupId(groups);
  selectedNodeId = null; selectedGroupId = null; selectedEdge = null;
  checkedNodeIds = new Set();
  newEdgeStyle = "solid";
  undoStack = [];
  updateUndoButtonState();
  boardTitleInput.value = board.name;
  syncDirToggle();
  renderBoardPopover();
  refreshUI();
  setSaveStatus("");
  localStorage.setItem("boards-active-board", String(board.id));
}
async function selectBoard(id) {
  if (id === currentBoardId) return;
  await flushSave();
  const board = boards.find((b) => b.id === id);
  if (board) loadBoardIntoBuilder(board);
}

async function createBoard() {
  await flushSave();
  const created = await api("/boards", {
    method: "POST",
    body: JSON.stringify({ name: `Board ${boards.length + 1}`, direction: "TD", nodes: [], edges: [], groups: [] }),
  });
  boards.push(created);
  emptyStateEl.style.display = "none";
  workspaceEl.style.display = "flex";
  loadBoardIntoBuilder(created);
}
document.getElementById("new-board-btn").addEventListener("click", () => { createBoard(); closePopover(); });
document.getElementById("empty-new-board-btn").addEventListener("click", createBoard);

document.getElementById("delete-board-btn").addEventListener("click", async () => {
  if (currentBoardId == null) return;
  const board = boards.find((b) => b.id === currentBoardId);
  if (!board) return;
  if (!confirm(`Delete board "${board.name}"? This can't be undone.`)) return;
  await api(`/boards/${currentBoardId}`, { method: "DELETE" });
  boards = boards.filter((b) => b.id !== currentBoardId);
  if (boards.length > 0) {
    loadBoardIntoBuilder(boards[0]);
  } else {
    currentBoardId = null;
    emptyStateEl.style.display = "flex";
    workspaceEl.style.display = "none";
  }
});

function setSaveStatus(text) { document.getElementById("board-save-status").textContent = text; }
function scheduleSave() {
  dirty = true;
  setSaveStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || currentBoardId == null) return;
  dirty = false;
  const updated = await api(`/boards/${currentBoardId}`, {
    method: "PUT",
    body: JSON.stringify({ direction, nodes, edges, groups }),
  });
  const board = boards.find((b) => b.id === currentBoardId);
  if (board) {
    board.nodes = updated.nodes;
    board.edges = updated.edges;
    board.direction = updated.direction;
    board.groups = updated.groups;
  }
  setSaveStatus("Saved");
}
window.addEventListener("beforeunload", () => { if (dirty) flushSave(); });

/* ---------------- inspector tabs ---------------- */
function syncTabButtons() {
  document.querySelectorAll(".inspector-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === activeTab));
}
document.querySelector(".inspector-tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-tab]");
  if (!btn) return;
  activeTab = btn.dataset.tab;
  syncTabButtons();
  renderInspector();
});

const backIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';

function shapeGridHtml(activeShapeKey, actionName) {
  return `<div class="shape-grid">${SHAPES.map((s) => `<button type="button" class="shape-cell${s.key === activeShapeKey ? " active" : ""}" data-action="${actionName}" data-shape="${s.key}">${shapeSwatchSvg(s.key)}<span>${s.label}</span></button>`).join("")}</div>`;
}

function renderInspector() {
  if (activeTab === "steps") renderStepsTab(inspectorBody);
  else if (activeTab === "connections") renderConnectionsTab(inspectorBody);
  else renderGroupsTab(inspectorBody);
}

/* ---- Steps tab: accordion ---- */
function stepRowHtml(n) {
  const expanded = n.id === selectedNodeId;
  return `
    <li class="accordion-item${expanded ? " expanded" : ""}">
      <div class="accordion-head" data-action="toggle-step" data-id="${n.id}">
        <span class="swatch">${shapeSwatchSvg(n.shape)}</span>
        <span class="lbl">${n.label}</span>
        <span class="chev${expanded ? " rot" : ""}">›</span>
      </div>
      ${expanded ? `
        <div class="accordion-body">
          <input class="edit-title-input" id="step-name-input" value="${n.label.replace(/"/g, "&quot;")}">
          ${shapeGridHtml(n.shape, "pick-step-shape")}
          <button class="btn-danger-block" data-action="delete-step">Delete step</button>
        </div>` : ""}
    </li>`;
}
function renderStepsTab(body) {
  body.innerHTML = `
    <div class="insp-section">
      <div class="insp-section-label">Add a step</div>
      ${shapeGridHtml(selectedShape, "pick-new-shape")}
      <div class="insp-row">
        <input type="text" id="new-step-input" placeholder="e.g. Task created" maxlength="60">
        <button class="btn-primary" data-action="add-step">Add</button>
      </div>
    </div>
    <div class="insp-section">
      <div class="insp-section-label">Steps (${nodes.length})</div>
      <ul class="accordion-list">
        ${nodes.length ? nodes.map(stepRowHtml).join("") : '<li class="insp-empty">No steps yet.</li>'}
      </ul>
    </div>`;
  document.getElementById("new-step-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.querySelector('[data-action="add-step"]').click(); });
  if (selectedNodeId) {
    const node = nodes.find((n) => n.id === selectedNodeId);
    const nameInput = document.getElementById("step-name-input");
    nameInput.addEventListener("focus", () => pushUndo());
    nameInput.addEventListener("input", () => { node.label = sanitize(nameInput.value) || node.label; });
    nameInput.addEventListener("blur", () => refreshAndSave());
    nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") nameInput.blur(); });
  }
}

/* ---- Connections tab: connector-row add form + accordion list ---- */
function connectorRowHtml(fromId, toId, style, idPrefix) {
  const opts = (selId) => nodes.map((n) => `<option value="${n.id}"${n.id === selId ? " selected" : ""}>${n.label}</option>`).join("");
  return `
    <div class="connector-row">
      <select id="${idPrefix}-from">${opts(fromId)}</select>
      <button type="button" class="arrow-btn" id="${idPrefix}-swap" title="Swap direction">${arrowSvg(style)}</button>
      <select id="${idPrefix}-to">${opts(toId)}</select>
    </div>`;
}
function edgeRowHtml(e, idx) {
  const expanded = e === selectedEdge;
  const f = nodes.find((n) => n.id === e.from), t = nodes.find((n) => n.id === e.to);
  const sub = e.label ? ` <span class="sub">(${e.label})</span>` : "";
  return `
    <li class="accordion-item${expanded ? " expanded" : ""}">
      <div class="accordion-head" data-action="toggle-edge" data-idx="${idx}">
        <span class="lbl">${f ? f.label : "?"} → ${t ? t.label : "?"}${sub}</span>
        <span class="chev${expanded ? " rot" : ""}">›</span>
      </div>
      ${expanded ? `
        <div class="accordion-body">
          ${connectorRowHtml(e.from, e.to, e.style || "solid", "edit-edge")}
          <input class="edit-title-input" id="edge-label-input-v2" placeholder="Label (optional)" value="${(e.label || "").replace(/"/g, "&quot;")}" style="font-weight:400;">
          <div class="seg-row" id="edit-edge-style-seg">
            <button class="seg-btn${(e.style || "solid") === "solid" ? " active" : ""}" data-action="pick-edge-style" data-style="solid">Solid</button>
            <button class="seg-btn${e.style === "dashed" ? " active" : ""}" data-action="pick-edge-style" data-style="dashed">Dashed</button>
            <button class="seg-btn${e.style === "dotted" ? " active" : ""}" data-action="pick-edge-style" data-style="dotted">Dotted</button>
          </div>
          <button class="btn-danger-block" data-action="delete-edge">Delete connection</button>
        </div>` : ""}
    </li>`;
}
function renderConnectionsTab(body) {
  const canConnect = nodes.length >= 2;
  body.innerHTML = `
    <div class="insp-section">
      <div class="insp-section-label">Connect steps</div>
      ${canConnect ? connectorRowHtml(nodes[0].id, nodes[1].id, newEdgeStyle, "new-edge") : '<div class="insp-empty">Add at least two steps first.</div>'}
      ${canConnect ? `
        <div class="seg-row" id="new-edge-style-seg">
          <button class="seg-btn${newEdgeStyle === "solid" ? " active" : ""}" data-action="pick-new-edge-style" data-style="solid">Solid</button>
          <button class="seg-btn${newEdgeStyle === "dashed" ? " active" : ""}" data-action="pick-new-edge-style" data-style="dashed">Dashed</button>
          <button class="seg-btn${newEdgeStyle === "dotted" ? " active" : ""}" data-action="pick-new-edge-style" data-style="dotted">Dotted</button>
        </div>
        <div class="insp-row">
          <input type="text" id="new-edge-label" placeholder="Label (optional)">
          <button class="btn-primary" data-action="add-edge">Connect</button>
        </div>` : ""}
    </div>
    <div class="insp-section">
      <div class="insp-section-label">Connections (${edges.length})</div>
      <ul class="accordion-list">
        ${edges.length ? edges.map(edgeRowHtml).join("") : '<li class="insp-empty">No connections yet.</li>'}
      </ul>
    </div>`;

  if (canConnect) {
    document.getElementById("new-edge-label").addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.querySelector('[data-action="add-edge"]').click(); });
  }
  if (selectedEdge) {
    const e = selectedEdge;
    document.getElementById("edit-edge-from").addEventListener("change", (ev) => { pushUndo(); e.from = ev.target.value; refreshAndSave(); });
    document.getElementById("edit-edge-to").addEventListener("change", (ev) => { pushUndo(); e.to = ev.target.value; refreshAndSave(); });
    document.getElementById("edit-edge-swap").addEventListener("click", () => { pushUndo(); const t = e.from; e.from = e.to; e.to = t; refreshAndSave(); });
    const lbl = document.getElementById("edge-label-input-v2");
    lbl.addEventListener("focus", () => pushUndo());
    lbl.addEventListener("input", () => { e.label = sanitize(lbl.value); });
    lbl.addEventListener("blur", () => refreshAndSave());
    lbl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") lbl.blur(); });
  }
}

/* ---- Groups tab: accordion list + always-visible assign section ---- */
function groupRowHtml(g) {
  const expanded = g.id === selectedGroupId;
  const count = nodes.filter((n) => n.groupId === g.id).length;
  return `
    <li class="accordion-item${expanded ? " expanded" : ""}">
      <div class="accordion-head" data-action="toggle-group" data-id="${g.id}">
        <span class="lbl">${g.label} <span class="sub">(${count})</span></span>
        <span class="chev${expanded ? " rot" : ""}">›</span>
      </div>
      ${expanded ? `
        <div class="accordion-body">
          <input class="edit-title-input" id="group-name-input" value="${g.label.replace(/"/g, "&quot;")}">
          <div class="seg-row">
            <button class="seg-btn${(g.shape || "square") === "square" ? " active" : ""}" data-action="pick-group-shape" data-shape="square">Square</button>
            <button class="seg-btn${g.shape === "rounded" ? " active" : ""}" data-action="pick-group-shape" data-shape="rounded">Rounded</button>
          </div>
          <button class="btn-danger-block" data-action="delete-group">Delete group</button>
        </div>` : ""}
    </li>`;
}
function renderGroupsTab(body) {
  const checkedCount = checkedNodeIds.size;
  body.innerHTML = `
    <div class="insp-section">
      <div class="insp-section-label">Groups (${groups.length})</div>
      <ul class="accordion-list">
        ${groups.length ? groups.map(groupRowHtml).join("") : '<li class="insp-empty">No groups yet.</li>'}
      </ul>
    </div>
    <div class="insp-section">
      <div class="insp-section-label">Draw a boundary around steps</div>
      <div class="checklist-frame">
        ${nodes.length ? nodes.map((n) => `<label class="check-row"><input type="checkbox" data-action="toggle-check" data-id="${n.id}" ${checkedNodeIds.has(n.id) ? "checked" : ""}><span class="swatch">${shapeSwatchSvg(n.shape)}</span><span class="lbl">${n.label}</span></label>`).join("") : '<div class="insp-empty">No steps yet.</div>'}
      </div>
      <div class="insp-empty" style="padding: 0 0 8px;">${checkedCount} step${checkedCount === 1 ? "" : "s"} checked</div>
      <div class="insp-row">
        <input type="text" id="new-group-input" placeholder="New group name">
        <button class="btn-primary" data-action="create-group" ${checkedCount ? "" : "disabled"}>Create</button>
      </div>
      <div class="insp-row">
        <select id="assign-group-select">${groups.length ? groups.map((g) => `<option value="${g.id}">${g.label}</option>`).join("") : '<option value="">No groups yet</option>'}</select>
        <button class="btn-primary" data-action="assign-group" ${checkedCount && groups.length ? "" : "disabled"}>Add</button>
      </div>
      <button class="btn-ghost-danger" style="width:100%;" data-action="ungroup-checked" ${checkedCount ? "" : "disabled"}>Remove checked from group</button>
    </div>`;
  const newGroupInput = document.getElementById("new-group-input");
  newGroupInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.querySelector('[data-action="create-group"]').click(); });
  if (selectedGroupId) {
    const g = groups.find((x) => x.id === selectedGroupId);
    const nameInput = document.getElementById("group-name-input");
    nameInput.addEventListener("focus", () => pushUndo());
    nameInput.addEventListener("input", () => { g.label = sanitize(nameInput.value) || g.label; });
    nameInput.addEventListener("blur", () => refreshAndSave());
    nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") nameInput.blur(); });
  }
}

/* ---- delegated actions across all inspector views ---- */
inspectorBody.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "toggle-step") {
    selectNode(el.dataset.id);
  } else if (action === "pick-new-shape") {
    selectedShape = el.dataset.shape;
    renderInspector();
    document.getElementById("new-step-input")?.focus();
  } else if (action === "add-step") {
    addNode(document.getElementById("new-step-input").value, selectedShape);
  } else if (action === "pick-step-shape") {
    const node = nodes.find((n) => n.id === selectedNodeId);
    if (node) { pushUndo(); node.shape = el.dataset.shape; refreshAndSave(); }
  } else if (action === "delete-step") {
    if (selectedNodeId) removeNode(selectedNodeId);
  } else if (action === "toggle-edge") {
    selectEdge(edges[+el.dataset.idx]);
  } else if (action === "pick-new-edge-style") {
    newEdgeStyle = el.dataset.style;
    document.querySelectorAll("#new-edge-style-seg .seg-btn").forEach((b) => b.classList.toggle("active", b === el));
    document.getElementById("new-edge-swap").innerHTML = arrowSvg(newEdgeStyle);
  } else if (action === "add-edge") {
    const from = document.getElementById("new-edge-from").value;
    const to = document.getElementById("new-edge-to").value;
    const label = document.getElementById("new-edge-label").value;
    addEdge(from, to, label, newEdgeStyle);
  } else if (action === "pick-edge-style") {
    if (selectedEdge) { pushUndo(); selectedEdge.style = el.dataset.style; refreshAndSave(); }
  } else if (action === "delete-edge") {
    if (selectedEdge) removeEdge(selectedEdge);
  } else if (action === "toggle-group") {
    selectGroup(el.dataset.id);
  } else if (action === "pick-group-shape") {
    const g = groups.find((x) => x.id === selectedGroupId);
    if (g) { pushUndo(); g.shape = el.dataset.shape; refreshAndSave(); }
  } else if (action === "delete-group") {
    if (selectedGroupId) removeGroup(selectedGroupId);
  } else if (action === "create-group") {
    const nameInput = document.getElementById("new-group-input");
    const clean = sanitize(nameInput.value);
    if (!clean || !checkedNodeIds.size) return;
    pushUndo();
    const id = "g" + nextGroupId++;
    groups.push({ id, label: clean, shape: "square" });
    applyGroupToChecked(id);
  } else if (action === "assign-group") {
    const groupId = document.getElementById("assign-group-select").value;
    if (!groupId || !checkedNodeIds.size) return;
    pushUndo();
    applyGroupToChecked(groupId);
  } else if (action === "ungroup-checked") {
    if (!checkedNodeIds.size) return;
    pushUndo();
    applyGroupToChecked(null);
  }
});
inspectorBody.addEventListener("change", (ev) => {
  if (ev.target.dataset.action === "toggle-check") {
    const id = ev.target.dataset.id;
    if (ev.target.checked) checkedNodeIds.add(id); else checkedNodeIds.delete(id);
    renderGroupsTab(inspectorBody);
  }
});

/* ---------------- init ---------------- */
async function init() {
  boards = await api("/boards");
  if (boards.length === 0) {
    emptyStateEl.style.display = "flex";
    workspaceEl.style.display = "none";
  } else {
    emptyStateEl.style.display = "none";
    workspaceEl.style.display = "flex";
    const stored = Number(localStorage.getItem("boards-active-board"));
    const initial = boards.find((b) => b.id === stored) || boards[0];
    loadBoardIntoBuilder(initial);
  }
}

init();
