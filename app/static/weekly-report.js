const API = "/api";

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function api(path, options) {
  const res = await fetch(API + path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `${options?.method || "GET"} ${path} failed: ${res.status}`);
  }
  return res.json();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let lastDigest = null;
let lastPolished = null;
let currentStart = null;
let currentEnd = null;
let projects = [];

async function loadProjects() {
  projects = await api("/projects");
}

function projectName(id) {
  const p = projects.find((p) => p.id === id);
  return p ? p.name : null;
}

function entryLabel(entryType) {
  if (entryType === "update") return "Update: ";
  if (entryType === "decision") return "Decision: ";
  if (entryType === "blocker") return "Blocker: ";
  return "Notes: ";
}

function formatShortDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
}

function flatItems(digest) {
  const items = [];
  for (const e of digest.entries) {
    const pname = projectName(e.project_id);
    const prefix = pname ? `<span class="project-tag">${escapeHtml(pname)}</span> ` : "";
    const label = entryLabel(e.entry_type);
    const taskSuffix = e.entry_type === "note" && e.task_title ? ` — task: ${e.task_title}` : "";
    items.push({
      html: `${prefix}${label}${escapeHtml(e.content)}${escapeHtml(taskSuffix)}`,
      text: `${pname ? `[${pname}] ` : ""}${label}${e.content}${taskSuffix}`,
    });
  }
  for (const t of digest.completed_tasks) {
    const pname = projectName(t.project_id);
    const prefix = pname ? `<span class="project-tag">${escapeHtml(pname)}</span> ` : "";
    items.push({
      html: `${prefix}Completed: ${escapeHtml(t.title)}`,
      text: `${pname ? `[${pname}] ` : ""}Completed: ${t.title}`,
    });
  }
  const today = todayISO();
  for (const t of digest.open_tasks) {
    const pname = projectName(t.project_id);
    const prefix = pname ? `<span class="project-tag">${escapeHtml(pname)}</span> ` : "";
    const overdue = t.due_date && t.due_date < today;
    const dueLabel = t.due_date ? `${formatShortDate(t.due_date)}${overdue ? " (OVERDUE)" : ""}` : null;
    items.push({
      html: `${prefix}Open: ${escapeHtml(t.title)}${dueLabel ? ` — <span class="due ${overdue ? "overdue" : ""}">due ${escapeHtml(dueLabel)}</span>` : ""}`,
      text: `${pname ? `[${pname}] ` : ""}Open: ${t.title}${dueLabel ? ` — due ${dueLabel}` : ""}`,
    });
  }
  return items;
}

function renderList(items, emptyText) {
  const ul = document.createElement("ul");
  ul.className = "list";
  ul.innerHTML = items.length
    ? items.map((i) => `<li>${i.html}</li>`).join("")
    : `<li class="empty">${emptyText}</li>`;
  return ul;
}

async function generateReport() {
  const digest = await api(`/reports/weekly?start=${currentStart}&end=${currentEnd}`);
  lastDigest = digest;

  const output = document.getElementById("report-output");
  output.innerHTML = "";
  output.appendChild(renderList(flatItems(digest), "Nothing logged in this range."));

  lastPolished = null;
  document.getElementById("polished-output").innerHTML = '<div class="empty">Click "Generate Report" above once the digest looks right.</div>';
}

function digestToText() {
  if (!lastDigest) return "";
  const items = flatItems(lastDigest);
  const lines = [`Weekly Report: ${lastDigest.start} to ${lastDigest.end}`, ""];
  lines.push(...(items.length ? items.map((i) => `- ${i.text}`) : ["Nothing logged in this range."]));
  return lines.join("\n").trim();
}

async function copyText(text, label) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  flashStatus("polish-status", `${label} copied!`);
}

function flashStatus(elId, message, isError) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.style.color = isError ? "var(--danger)" : "var(--ok)";
  setTimeout(() => (el.textContent = ""), 3000);
}

async function polishReport() {
  if (!lastDigest) return;
  const btn = document.getElementById("polish-btn");
  const output = document.getElementById("polished-output");
  btn.disabled = true;
  flashStatus("polish-status", "Asking Ollama...", false);
  output.innerHTML = '<div class="empty">Generating...</div>';
  try {
    const result = await api(`/reports/weekly/polish?start=${currentStart}&end=${currentEnd}`, { method: "POST" });
    lastPolished = result.polished;
    output.innerHTML = `<div class="polished-text">${renderMarkdown(result.polished)}</div>`;
    document.getElementById("polish-status").textContent = "";
  } catch (err) {
    output.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
    flashStatus("polish-status", "Failed", true);
  } finally {
    btn.disabled = false;
  }
}

function setActivePreset(days) {
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.days) === days);
  });
}

function applyPreset(days) {
  currentEnd = todayISO();
  currentStart = addDays(currentEnd, -(days - 1));
  setActivePreset(days);
  generateReport();
}

document.getElementById("polish-btn").addEventListener("click", polishReport);
document.getElementById("copy-raw-btn").addEventListener("click", () => copyText(digestToText(), "Raw digest"));
document.getElementById("copy-polished-btn").addEventListener("click", () => copyText(lastPolished, "Polished report"));
document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(Number(btn.dataset.days)));
});

(async function init() {
  await loadProjects();
  applyPreset(7);
})();
