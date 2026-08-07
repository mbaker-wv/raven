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
          ${projectName(e.project_id) ? `<span class="project-tag">${escapeHtml(projectName(e.project_id))}</span>` : ""}
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
          ${projectName(t.project_id) ? `<span class="project-tag">${escapeHtml(projectName(t.project_id))}</span>` : ""}
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

// Builds a smoothed sparkline path by drawing quadratic curves through the midpoints
// of each pair of points — rounds off the joins without needing full spline math.
function smoothSparkPath(points) {
  let line = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const mx = (prev.x + curr.x) / 2;
    const my = (prev.y + curr.y) / 2;
    line += ` Q${prev.x},${prev.y} ${mx},${my}`;
  }
  const last = points[points.length - 1];
  line += ` L${last.x},${last.y}`;
  const area = `${line} L${last.x},20 L${points[0].x},20 Z`;
  return { line, area };
}

// A simple, robust "is this trending up or down" heuristic: compare the average of the
// first half of the window to the average of the second half, rather than comparing
// single days (which one noisy day could flip either direction).
function trendDirection(daily) {
  const mid = Math.floor(daily.length / 2);
  const firstAvg = daily.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid);
  const secondAvg = daily.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, daily.length - mid);
  if (secondAvg > firstAvg * 1.15) return "up";
  if (secondAvg < firstAvg * 0.85) return "down";
  return "flat";
}

function kpiRowMarkup(name, countLabel, daily) {
  // Square-root scale, same reasoning as the daily activity bars: a single outlier day
  // shouldn't flatten the rest of the week into an indistinguishable line.
  const maxCount = Math.max(1, ...daily);
  const points = daily.map((count, i) => {
    const norm = count === 0 ? 0 : Math.sqrt(count) / Math.sqrt(maxCount);
    return { x: (i / (daily.length - 1)) * 60, y: 18 - norm * 16 };
  });
  const { line, area } = smoothSparkPath(points);
  const last = points[points.length - 1];
  const trend = trendDirection(daily);
  const glyph = trend === "up" ? "▲" : trend === "down" ? "▼" : "–";

  return `
    <div class="kpi-row">
      <span class="kpi-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <svg class="sparkline" viewBox="0 0 60 20" preserveAspectRatio="none">
        <path class="spark-area" d="${area}"></path>
        <path class="spark-line" d="${line}"></path>
        <circle class="spark-dot" cx="${last.x}" cy="${last.y}" r="2.2"></circle>
      </svg>
      <span class="kpi-trend${trend === "flat" ? " flat" : ""}" title="${trend[0].toUpperCase() + trend.slice(1)} over the last 7 days">${glyph}</span>
      <span class="kpi-count">${countLabel}</span>
    </div>
  `;
}

const SKILL_NARRATIVE_PHRASES = {
  create_task: (n) => `created <b>${n}</b> task${n === 1 ? "" : "s"}`,
  complete_task: (n) => `closed <b>${n}</b> task${n === 1 ? "" : "s"}`,
  log_entry: (n) => `logged <b>${n}</b> ${n === 1 ? "entry" : "entries"}`,
};

function buildSkillNarrative(skillCounts) {
  const parts = Object.entries(SKILL_NARRATIVE_PHRASES)
    .filter(([tool]) => skillCounts[tool])
    .map(([tool, phrase]) => phrase(skillCounts[tool]));
  if (parts.length === 0) return null;
  if (parts.length === 1) return `Agents ${parts[0]} for you this week.`;
  if (parts.length === 2) return `Agents ${parts[0]} and ${parts[1]} for you this week.`;
  return `Agents ${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]} for you this week.`;
}

async function loadStats() {
  const stats = await api("/reports/stats");
  document.getElementById("stat-open-tasks").textContent = stats.open_tasks;
  document.getElementById("stat-due-week").textContent = stats.due_this_week;
  document.getElementById("stat-done-week").textContent = stats.done_this_week;
  document.getElementById("stat-streak").textContent = stats.streak_days;
  document.getElementById("stat-actions-week").textContent = stats.actions_taken_week;
  document.getElementById("stat-actions-today").textContent = stats.actions_taken_today;

  // Square-root scale so a single outlier day (e.g. 17 vs 1) doesn't flatten every
  // other bar down to an indistinguishable sliver.
  const maxCount = Math.max(1, ...stats.daily_activity.map((d) => d.count));
  const bars = document.getElementById("activity-bars");
  const labels = document.getElementById("activity-labels");
  bars.innerHTML = "";
  labels.innerHTML = "";
  for (const day of stats.daily_activity) {
    const bar = document.createElement("div");
    const heightPct = day.count === 0 ? 6 : Math.max(10, (Math.sqrt(day.count) / Math.sqrt(maxCount)) * 100);
    bar.className = "bar" + (day.count > 0 ? " active" : "");
    bar.style.height = `${heightPct}%`;
    bar.title = `${day.date}: ${day.count}`;
    bars.appendChild(bar);

    const label = document.createElement("span");
    label.textContent = new Date(day.date + "T00:00:00").toLocaleDateString([], { weekday: "short" }).slice(0, 3);
    labels.appendChild(label);
  }

  const agentRows = document.getElementById("agent-kpi-rows");
  agentRows.innerHTML =
    stats.top_agents.length === 0
      ? '<div class="empty">No agents run yet.</div>'
      : stats.top_agents.map((a) => kpiRowMarkup(a.name, `${a.run_count} run${a.run_count === 1 ? "" : "s"}`, a.daily)).join("");

  const skillRows = document.getElementById("skill-kpi-rows");
  skillRows.innerHTML =
    stats.top_skills.length === 0
      ? '<div class="empty">No skills used yet.</div>'
      : stats.top_skills.map((s) => kpiRowMarkup(s.name, String(s.call_count), s.daily)).join("");

  const narrativeEl = document.getElementById("skill-narrative");
  const narrative = buildSkillNarrative(stats.skill_counts);
  narrativeEl.classList.toggle("hidden", !narrative);
  if (narrative) narrativeEl.innerHTML = narrative;
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
  loadStats();
  await loadProjects();
  await loadReminders();
  await loadEntries();
})();
