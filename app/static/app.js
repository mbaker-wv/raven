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

async function loadProjects() {
  projects = await api("/projects");
}

function projectName(id) {
  const p = projects.find((p) => p.id === id);
  return p ? p.name : null;
}

async function loadReminders() {
  const today = todayISO();
  const reminders = await api("/entries?has_reminder=true");
  const due = reminders.filter((r) => r.reminder_date <= today);
  const list = document.getElementById("reminders-list");
  list.innerHTML = "";
  if (due.length === 0) {
    list.innerHTML = '<li class="empty">No reminders due.</li>';
    return;
  }
  for (const r of due) {
    const li = document.createElement("li");
    li.className = "task-item";
    const overdue = r.reminder_date < today;
    li.innerHTML = `
      <input type="checkbox" data-id="${r.id}">
      <span class="task-title">${escapeHtml(r.content)}</span>
      <span class="due ${overdue ? "overdue" : ""}">${r.reminder_date}</span>
    `;
    li.querySelector("input[type=checkbox]").addEventListener("change", async () => {
      await api(`/entries/${r.id}`, { method: "PUT", body: JSON.stringify({ reminder_date: null }) });
      loadReminders();
    });
    list.appendChild(li);
  }
}

async function loadEntries() {
  const start = todayISO();
  const end = addDays(start, 1);
  const [entries, tasks] = await Promise.all([api(`/entries?start=${start}&end=${end}`), api("/tasks")]);
  const completedToday = tasks.filter((t) => t.completed_at && t.completed_at.slice(0, 10) === start);

  const items = [
    ...entries.map((e) => ({
      time: e.created_at,
      html: `
        <div class="entry-meta">
          <span>${new Date(e.created_at + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="badge ${e.entry_type}">${e.entry_type}</span>
          ${projectName(e.project_id) ? `<span class="project-tag">${projectName(e.project_id)}</span>` : ""}
        </div>
        <div>${escapeHtml(e.content)}</div>
      `,
    })),
    ...completedToday.map((t) => ({
      time: t.completed_at,
      html: `
        <div class="entry-meta">
          <span>${new Date(t.completed_at + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span class="badge status-closed">completed</span>
          ${projectName(t.project_id) ? `<span class="project-tag">${projectName(t.project_id)}</span>` : ""}
        </div>
        <div>${escapeHtml(t.title)}</div>
      `,
    })),
  ].sort((a, b) => new Date(a.time) - new Date(b.time));

  const list = document.getElementById("entries-list");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = '<li class="empty">Nothing logged yet today.</li>';
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = item.html;
    list.appendChild(li);
  }
}

async function loadTasks() {
  const today = todayISO();
  const cutoff = addDays(today, 3);
  const tasks = await api("/tasks");
  const open = tasks.filter((t) => t.status !== "closed" && (!t.due_date || t.due_date <= cutoff));
  const list = document.getElementById("tasks-list");
  list.innerHTML = "";
  if (open.length === 0) {
    list.innerHTML = '<li class="empty">No open tasks.</li>';
    return;
  }
  for (const t of open) {
    const li = document.createElement("li");
    li.className = "task-item";
    const overdue = t.due_date && t.due_date < today;
    const pname = projectName(t.project_id);
    li.innerHTML = `
      <a class="task-title-link" href="/tasks?task_id=${t.id}">${escapeHtml(t.title)}</a>
      <span class="badge status-${t.status}">${t.status}</span>
      ${pname ? `<span class="project-tag">${pname}</span>` : ""}
      ${t.recurrence && t.recurrence !== "none" ? `<span class="tag-badge">↻ ${escapeHtml(t.recurrence)}</span>` : ""}
      ${overdue ? `<span class="tag-badge overdue">Overdue</span>` : ""}
      ${t.due_date ? `<span class="due ${overdue ? "overdue" : ""}">${t.due_date}</span>` : ""}
    `;
    list.appendChild(li);
  }
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

const todayDateText = new Date().toLocaleDateString([], {
  weekday: "long",
  month: "long",
  day: "numeric",
});
document.getElementById("today-date").textContent = `${todayDateText} · Week ${isoWeekNumber(new Date())}`;

function timeOfDayGreeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

async function loadGreeting() {
  const greeting = timeOfDayGreeting(new Date().getHours());
  const el = document.getElementById("greeting");
  el.textContent = greeting;
  try {
    const settings = await api("/admin/settings");
    if (settings.profile_name) {
      el.textContent = `${greeting}, ${settings.profile_name.split(" ")[0]}`;
    }
  } catch (e) {
    // no profile set yet — plain greeting is fine
  }
}

(async function init() {
  loadGreeting();
  await loadProjects();
  await loadReminders();
  await loadEntries();
  await loadTasks();
})();
