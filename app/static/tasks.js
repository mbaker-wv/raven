const API = "/api";
const STATUSES = ["new", "inprogress", "blocked", "closed"];
const STATUS_LABELS = { new: "New", inprogress: "In Progress", blocked: "Blocked", closed: "Closed" };

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let projects = [];
let currentTaskId = null;
let currentTags = [];
let currentFilter = "all";
let currentView = "active";
let currentSearch = "";

function parseTags(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAY_LABELS = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

function renderDayToggles(row, values, labels, selected) {
  row.innerHTML = "";
  for (const value of values) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary day-toggle";
    btn.textContent = labels ? labels[value] : value;
    btn.dataset.value = value;
    if (selected.includes(value)) btn.classList.add("active");
    btn.addEventListener("click", () => btn.classList.toggle("active"));
    row.appendChild(btn);
  }
}

function getSelectedDays(row) {
  return Array.from(row.querySelectorAll(".day-toggle.active")).map((b) => b.dataset.value);
}

function updateRecurrenceUI(prefix, recurrence, selectedDays) {
  const weekdaysWrap = document.getElementById(`${prefix}-weekdays`);
  const monthdaysWrap = document.getElementById(`${prefix}-monthdays`);
  const weekdaysRow = weekdaysWrap.querySelector(".day-toggle-row");
  const monthdaysRow = monthdaysWrap.querySelector(".day-toggle-row");

  weekdaysWrap.classList.toggle("hidden", recurrence !== "weekly");
  monthdaysWrap.classList.toggle("hidden", recurrence !== "monthly");

  renderDayToggles(weekdaysRow, WEEKDAYS, WEEKDAY_LABELS, recurrence === "weekly" ? selectedDays : []);
  renderDayToggles(monthdaysRow, MONTH_DAYS, null, recurrence === "monthly" ? selectedDays : []);
}

function collectRecurrenceDay(prefix, recurrence) {
  if (recurrence === "weekly") {
    const days = getSelectedDays(document.querySelector(`#${prefix}-weekdays .day-toggle-row`));
    return days.length ? days.join(",") : null;
  }
  if (recurrence === "monthly") {
    const days = getSelectedDays(document.querySelector(`#${prefix}-monthdays .day-toggle-row`));
    return days.length ? days.join(",") : null;
  }
  return null;
}

async function loadTagSuggestions() {
  const { tags } = await api("/tasks/tags");
  const datalist = document.getElementById("tag-suggestions");
  datalist.innerHTML = tags.map((t) => `<option value="${escapeHtml(t)}"></option>`).join("");
}

async function loadProjects() {
  projects = await api("/projects");
}

function projectName(id) {
  const p = projects.find((p) => p.id === id);
  return p ? p.name : null;
}

async function loadTasks() {
  const archived = currentView === "archived";
  const params = new URLSearchParams({ archived: String(archived) });
  if (!archived && currentFilter !== "all") params.set("status", currentFilter);
  if (currentSearch) params.set("q", currentSearch);
  const tasks = await api(`/tasks?${params.toString()}`);
  const today = todayISO();

  document.getElementById("status-filter").classList.toggle("hidden", archived);

  const container = document.getElementById("tasks-container");
  container.innerHTML = "";

  const list = document.createElement("ul");
  list.className = "list";
  if (tasks.length === 0) {
    list.innerHTML = '<li class="empty">Nothing here.</li>';
  } else {
    for (const t of tasks) {
      const li = document.createElement("li");
      li.className = "task-item";
      const overdue = t.due_date && t.due_date < today && t.status !== "closed";
      const pname = projectName(t.project_id);
      const tags = parseTags(t.tags);
      li.innerHTML = `
        <span class="task-title-link ${t.status === "closed" ? "task-title done" : ""}" data-id="${t.id}">${escapeHtml(t.title)}</span>
        ${pname ? `<span class="project-tag">${escapeHtml(pname)}</span>` : ""}
        ${t.recurrence && t.recurrence !== "none" ? `<span class="tag-badge">↻ ${escapeHtml(t.recurrence)}</span>` : ""}
        ${tags.map((tag) => `<span class="tag-badge">${escapeHtml(tag)}</span>`).join("")}
        ${t.due_date ? `<span class="due ${overdue ? "overdue" : ""}">${t.due_date}</span>` : ""}
        ${archived
          ? `<button class="secondary restore-btn" data-id="${t.id}">Restore</button>`
          : `<select class="status-select" data-id="${t.id}">
              ${STATUSES.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
            </select>`}
      `;
      li.querySelector(".task-title-link").addEventListener("click", () => openTaskModal(t.id));
      if (archived) {
        li.querySelector(".restore-btn").addEventListener("click", async () => {
          await api(`/tasks/${t.id}/restore`, { method: "PUT" });
          loadTasks();
        });
      } else {
        li.querySelector(".status-select").addEventListener("change", async (ev) => {
          await api(`/tasks/${t.id}`, { method: "PUT", body: JSON.stringify({ status: ev.target.value }) });
          loadTasks();
        });
      }
      list.appendChild(li);
    }
  }
  container.appendChild(list);
}

function setStatusFilter(status) {
  currentFilter = status;
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === status);
  });
  loadTasks();
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  loadTasks();
}

let searchDebounceTimer = null;
function onSearchInput(value) {
  currentSearch = value.trim();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(loadTasks, 250);
}

function openAddTaskModal() {
  document.getElementById("new-task-title").value = "";
  document.getElementById("new-task-due").value = "";
  document.getElementById("new-task-recurrence").value = "none";
  updateRecurrenceUI("new-task", "none", []);
  document.getElementById("new-task-tags").value = "";
  document.getElementById("new-task-note").value = "";
  document.getElementById("add-task-modal-backdrop").classList.remove("hidden");
  document.getElementById("new-task-title").focus();
}

function closeAddTaskModal() {
  document.getElementById("add-task-modal-backdrop").classList.add("hidden");
}

async function createTask() {
  const title = document.getElementById("new-task-title").value.trim();
  if (!title) return;
  const due_date = document.getElementById("new-task-due").value || null;
  const recurrence = document.getElementById("new-task-recurrence").value;
  const recurrence_day = collectRecurrenceDay("new-task", recurrence);
  if ((recurrence === "weekly" || recurrence === "monthly") && !recurrence_day) return;
  const tags = parseTags(document.getElementById("new-task-tags").value).join(",") || null;
  const note = document.getElementById("new-task-note").value.trim();
  const task = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title, due_date, recurrence, recurrence_day, tags }),
  });
  if (note) {
    await api("/entries", {
      method: "POST",
      body: JSON.stringify({ content: note, entry_type: "note", task_id: task.id, project_id: task.project_id }),
    });
  }
  closeAddTaskModal();
  loadTasks();
  loadTagSuggestions();
}

async function openTaskModal(taskId) {
  currentTaskId = taskId;
  const task = await api(`/tasks/${taskId}`);

  document.getElementById("modal-task-title").textContent = task.title;

  const statusSelect = document.getElementById("modal-status");
  statusSelect.innerHTML = STATUSES.map((s) => `<option value="${s}" ${s === task.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("");

  document.getElementById("modal-due").value = task.due_date || "";
  document.getElementById("modal-recurrence").value = task.recurrence || "none";
  updateRecurrenceUI("modal", task.recurrence || "none", parseTags(task.recurrence_day));

  currentTags = parseTags(task.tags);
  renderTagChips();
  document.getElementById("modal-tag-input").value = "";
  loadTagSuggestions();

  await loadNotes(taskId);

  document.getElementById("task-modal-backdrop").classList.remove("hidden");
}

function closeTaskModal() {
  document.getElementById("task-modal-backdrop").classList.add("hidden");
  currentTaskId = null;
  currentTags = [];
}

function renderTagChips() {
  const container = document.getElementById("modal-tag-chips");
  container.innerHTML = "";
  if (currentTags.length === 0) {
    container.innerHTML = '<span class="empty">No tags yet.</span>';
    return;
  }
  for (const tag of currentTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `${escapeHtml(tag)} <button type="button">&times;</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      currentTags = currentTags.filter((t) => t !== tag);
      renderTagChips();
    });
    container.appendChild(chip);
  }
}

function addTagFromInput() {
  const input = document.getElementById("modal-tag-input");
  const value = input.value.trim();
  if (!value) return;
  if (!currentTags.some((t) => t.toLowerCase() === value.toLowerCase())) {
    currentTags.push(value);
    renderTagChips();
  }
  input.value = "";
}

async function loadNotes(taskId) {
  const notes = await api(`/entries?task_id=${taskId}`);
  const list = document.getElementById("modal-notes");
  list.innerHTML = "";
  if (notes.length === 0) {
    list.innerHTML = '<li class="empty">No notes yet.</li>';
    return;
  }
  for (const n of notes.slice().reverse()) {
    const li = document.createElement("li");
    const time = new Date(n.created_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `<div class="note-time">${time}</div><div>${escapeHtml(n.content)}</div>`;
    list.appendChild(li);
  }
}

async function saveTaskFromModal() {
  if (!currentTaskId) return;
  addTagFromInput();
  const status = document.getElementById("modal-status").value;
  const due_date = document.getElementById("modal-due").value || null;
  const recurrence = document.getElementById("modal-recurrence").value;
  const recurrence_day = collectRecurrenceDay("modal", recurrence);
  if ((recurrence === "weekly" || recurrence === "monthly") && !recurrence_day) return;
  const tags = currentTags.length ? currentTags.join(",") : null;
  await api(`/tasks/${currentTaskId}`, {
    method: "PUT",
    body: JSON.stringify({ status, due_date, recurrence, recurrence_day, tags }),
  });
  closeTaskModal();
  loadTasks();
}

async function deleteTaskFromModal() {
  if (!currentTaskId) return;
  if (!confirm("Delete this task and its notes?")) return;
  await api(`/tasks/${currentTaskId}`, { method: "DELETE" });
  closeTaskModal();
  loadTasks();
}

async function addNoteFromModal() {
  if (!currentTaskId) return;
  const input = document.getElementById("modal-note-input");
  const content = input.value.trim();
  if (!content) return;
  const task = await api(`/tasks/${currentTaskId}`);
  await api("/entries", {
    method: "POST",
    body: JSON.stringify({ content, entry_type: "note", task_id: currentTaskId, project_id: task.project_id }),
  });
  input.value = "";
  loadNotes(currentTaskId);
}

document.getElementById("open-add-task-btn").addEventListener("click", openAddTaskModal);
document.getElementById("add-task-close-btn").addEventListener("click", closeAddTaskModal);
document.getElementById("create-task-btn").addEventListener("click", createTask);
document.getElementById("add-task-modal-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "add-task-modal-backdrop") closeAddTaskModal();
});
for (const id of ["new-task-title", "new-task-due", "new-task-tags"]) {
  document.getElementById(id).addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") createTask();
  });
}
document.getElementById("new-task-recurrence").addEventListener("change", (ev) => {
  updateRecurrenceUI("new-task", ev.target.value, []);
});
document.getElementById("modal-recurrence").addEventListener("change", (ev) => {
  updateRecurrenceUI("modal", ev.target.value, []);
});
document.getElementById("modal-close-btn").addEventListener("click", closeTaskModal);
document.getElementById("modal-save-btn").addEventListener("click", saveTaskFromModal);
document.getElementById("modal-delete-btn").addEventListener("click", deleteTaskFromModal);
document.getElementById("modal-add-note-btn").addEventListener("click", addNoteFromModal);
document.getElementById("modal-tag-input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === ",") {
    ev.preventDefault();
    addTagFromInput();
  }
});
document.getElementById("task-modal-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "task-modal-backdrop") closeTaskModal();
});
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => setStatusFilter(btn.dataset.status));
});
document.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});
document.getElementById("task-search").addEventListener("input", (ev) => onSearchInput(ev.target.value));

(async function init() {
  await loadProjects();
  await loadTasks();
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get("task_id");
  if (taskId) openTaskModal(Number(taskId));
})();
