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

let tabs = [];
let currentTabId = null;
let saveTimer = null;
let dirty = false;

function setSaveStatus(text) {
  document.getElementById("save-status").textContent = text;
}

function looksLikeHtml(content) {
  return /<[a-z][\s\S]*>/i.test(content);
}

async function loadTabs() {
  tabs = await api("/note-tabs");
  const stored = Number(localStorage.getItem("notes-active-tab"));
  currentTabId = tabs.some((t) => t.id === stored) ? stored : tabs[0]?.id ?? null;
  renderTabs();
  loadCurrentNote();
}

function renderTabs() {
  const container = document.getElementById("note-tabs");
  container.innerHTML = "";
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary filter-btn" + (tab.id === currentTabId ? " active" : "");
    btn.textContent = tab.name;
    btn.dataset.id = tab.id;
    btn.addEventListener("click", () => selectTab(tab.id));
    btn.addEventListener("dblclick", () => startRenameTab(btn, tab));
    container.appendChild(btn);
  }
}

async function selectTab(id) {
  if (id === currentTabId) return;
  await flushSave();
  currentTabId = id;
  localStorage.setItem("notes-active-tab", String(id));
  renderTabs();
  loadCurrentNote();
}

function loadCurrentNote() {
  const tab = tabs.find((t) => t.id === currentTabId);
  const content = tab ? tab.content : "";
  const editor = document.getElementById("note-content");
  // Notes saved before the rich-text editor was added are stored as raw markdown text;
  // render them once so they display correctly, same as any other note.
  editor.innerHTML = content && !looksLikeHtml(content) ? renderMarkdown(content) : content;
  setSaveStatus("");
}

function startRenameTab(btn, tab) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = tab.name;
  input.style.width = "120px";
  btn.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const name = input.value.trim();
    if (name && name !== tab.name) {
      await api(`/note-tabs/${tab.id}`, { method: "PUT", body: JSON.stringify({ name }) });
      tab.name = name;
    }
    renderTabs();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") input.blur();
    if (ev.key === "Escape") {
      input.removeEventListener("blur", commit);
      renderTabs();
    }
  });
}

function scheduleSave() {
  dirty = true;
  setSaveStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || currentTabId == null) return;
  const content = document.getElementById("note-content").innerHTML;
  const tab = tabs.find((t) => t.id === currentTabId);
  dirty = false;
  const updated = await api(`/note-tabs/${currentTabId}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  if (tab) tab.content = updated.content;
  setSaveStatus("Saved");
}

function normalizeEmpty() {
  const editor = document.getElementById("note-content");
  if (editor.textContent.trim() === "") editor.innerHTML = "";
}

function exec(command, value = null) {
  const editor = document.getElementById("note-content");
  editor.focus();
  document.execCommand(command, false, value);
  scheduleSave();
}

for (const id of ["md-bold-btn", "md-italic-btn", "md-heading-btn", "md-bullet-btn", "md-numbered-btn"]) {
  document.getElementById(id).addEventListener("mousedown", (ev) => ev.preventDefault());
}
document.getElementById("md-bold-btn").addEventListener("click", () => exec("bold"));
document.getElementById("md-italic-btn").addEventListener("click", () => exec("italic"));
document.getElementById("md-heading-btn").addEventListener("click", () => exec("formatBlock", "<h4>"));
document.getElementById("md-bullet-btn").addEventListener("click", () => exec("insertUnorderedList"));
document.getElementById("md-numbered-btn").addEventListener("click", () => exec("insertOrderedList"));

document.getElementById("note-content").addEventListener("input", () => {
  normalizeEmpty();
  scheduleSave();
});
document.getElementById("note-content").addEventListener("blur", flushSave);

window.addEventListener("beforeunload", () => {
  if (dirty) flushSave();
});

(async function init() {
  await loadTabs();
})();
