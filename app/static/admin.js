const API = "/api";

async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `${options?.method || "GET"} ${path} failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function flash(elId, message, isError) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.style.color = isError ? "var(--danger)" : "var(--ok)";
  setTimeout(() => (el.textContent = ""), 3000);
}

let currentSettings = null;

// ---- Collapsible admin-group sections: remember open/closed state per section ----

function initCollapsibleGroups() {
  document.querySelectorAll(".admin-group[data-group-id]").forEach((el) => {
    const key = `admin-group-${el.dataset.groupId}`;
    const saved = localStorage.getItem(key);
    if (saved === "open") el.open = true;
    else if (saved === "closed") el.open = false;
    el.addEventListener("toggle", () => localStorage.setItem(key, el.open ? "open" : "closed"));
  });
}

// ---- At-a-glance status shown in each section's header, even while collapsed ----

function updateProfileSummary() {
  const sub = document.getElementById("profile-group-sub");
  const bits = [currentSettings.profile_name, currentSettings.profile_role].filter(Boolean);
  sub.textContent = bits.length ? bits.join(" · ") : "Not set";
}

function updateProviderSummary() {
  const sub = document.getElementById("provider-group-sub");
  if ((currentSettings.ai_provider || "ollama") === "claude") {
    const status =
      currentSettings.claude_status === "ok"
        ? "connected"
        : currentSettings.claude_status === "error"
        ? "connection error"
        : currentSettings.claude_api_key_set
        ? "key saved, not tested"
        : "no key saved";
    sub.textContent = `Claude · ${status}`;
  } else {
    sub.textContent = `Ollama · ${currentSettings.ollama_model || "no model selected"}`;
  }
}

function updateBackupsSummary() {
  const sub = document.getElementById("backups-group-sub");
  const schedule = currentSettings.backup_schedule || "off";
  const scheduleBit = schedule === "off" ? "automatic backups off" : `${schedule} backups`;
  const b2Bit =
    currentSettings.b2_status === "ok"
      ? "B2 connected"
      : currentSettings.b2_key_id
      ? "B2 saved, not tested"
      : "B2 not configured";
  sub.textContent = `${scheduleBit} · ${b2Bit}`;
}

function updateUpdatesSummary(data) {
  const sub = document.getElementById("updates-group-sub");
  if (!data || data.error) {
    sub.textContent = "Not checked yet";
    return;
  }
  const versionBit = data.current_version ? `v${data.current_version}` : "";
  if (data.dirty_files && data.dirty_files.length > 0) {
    sub.textContent = `${versionBit} · local changes present`;
  } else if (data.available) {
    sub.textContent = `${versionBit} · ${data.commits_behind} commit${data.commits_behind === 1 ? "" : "s"} behind`;
  } else {
    sub.textContent = `${versionBit} · up to date`;
  }
}

function updateSecuritySummary(report) {
  const sub = document.getElementById("security-group-sub");
  if (!report || !report.results || report.results.length === 0) {
    sub.textContent = "Not checked yet";
    return;
  }
  const failCount = report.results.filter((r) => r.status === "fail" || r.status === "error").length;
  const summary = failCount > 0 ? `${failCount} issue${failCount === 1 ? "" : "s"} found` : "All clear";
  const when = report.checked_at
    ? new Date(report.checked_at + "Z").toLocaleDateString([], { month: "short", day: "numeric" })
    : null;
  sub.textContent = when ? `${summary} · checked ${when}` : summary;
}

async function loadSettings() {
  currentSettings = await api("/admin/settings");
  document.getElementById("profile-name").value = currentSettings.profile_name || "";
  document.getElementById("profile-role").value = currentSettings.profile_role || "";
  document.getElementById("profile-context").value = currentSettings.profile_context || "";
  updateProfileSummary();

  const provider = currentSettings.ai_provider || "ollama";
  document.getElementById(provider === "claude" ? "provider-claude" : "provider-ollama").checked = true;
  setProviderUI(provider);
  renderClaudeStatus();

  document.getElementById("backup-schedule-select").value = currentSettings.backup_schedule || "off";
  document.getElementById("backup-retention-input").value = currentSettings.backup_local_retention || 10;
  document.getElementById("b2-key-id").value = currentSettings.b2_key_id || "";
  document.getElementById("b2-bucket-name").value = currentSettings.b2_bucket_name || "";
  renderBackupScheduleNote();
  renderB2Status();
}

function renderBackupScheduleNote() {
  const note = document.getElementById("backup-schedule-note");
  if (!currentSettings.backup_last_run_at) {
    note.textContent = "No automatic backup has run yet.";
    note.style.color = "var(--muted)";
    updateBackupsSummary();
    return;
  }
  const when = new Date(currentSettings.backup_last_run_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  note.textContent = `Last run ${when}: ${currentSettings.backup_last_detail || ""}`;
  note.style.color = currentSettings.backup_last_status === "error" ? "var(--danger)" : "var(--ok)";
  updateBackupsSummary();
}

function renderB2Status() {
  const note = document.getElementById("b2-status-note");
  const input = document.getElementById("b2-application-key");
  input.placeholder = currentSettings.b2_application_key_set ? "•••• saved (enter a new key to replace)" : "Application Key";
  const checked = currentSettings.b2_status_checked_at
    ? new Date(currentSettings.b2_status_checked_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  if (currentSettings.b2_status === "ok") {
    note.textContent = checked ? `Connected (last checked ${checked})` : "Connected";
    note.style.color = "var(--ok)";
  } else if (currentSettings.b2_status === "error") {
    note.textContent = `${currentSettings.b2_status_detail || "Connection failed"}${checked ? ` (last checked ${checked})` : ""}`;
    note.style.color = "var(--danger)";
  } else if (currentSettings.b2_key_id) {
    note.textContent = "Saved, but not tested yet.";
    note.style.color = "var(--muted)";
  } else {
    note.textContent = "Not configured.";
    note.style.color = "var(--muted)";
  }
  updateBackupsSummary();
}

async function saveBackupSchedule() {
  const btn = document.getElementById("save-backup-schedule-btn");
  const backup_schedule = document.getElementById("backup-schedule-select").value;
  const backup_local_retention = parseInt(document.getElementById("backup-retention-input").value, 10) || 10;
  btn.disabled = true;
  try {
    await api("/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ backup_schedule, backup_local_retention }),
    });
    Object.assign(currentSettings, { backup_schedule, backup_local_retention });
    flash("backup-status", "Schedule saved.", false);
  } catch (err) {
    flash("backup-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveB2() {
  const b2_key_id = document.getElementById("b2-key-id").value.trim() || null;
  const b2_application_key = document.getElementById("b2-application-key").value.trim();
  const b2_bucket_name = document.getElementById("b2-bucket-name").value.trim() || null;
  const body = { b2_key_id, b2_bucket_name };
  if (b2_application_key) body.b2_application_key = b2_application_key;
  await api("/admin/settings", { method: "PUT", body: JSON.stringify(body) });
  document.getElementById("b2-application-key").value = "";
  currentSettings.b2_key_id = b2_key_id;
  currentSettings.b2_bucket_name = b2_bucket_name;
  if (b2_application_key) currentSettings.b2_application_key_set = true;
  currentSettings.b2_status = null;
  currentSettings.b2_status_detail = null;
  renderB2Status();
}

async function testB2Connection() {
  const key_id = document.getElementById("b2-key-id").value.trim();
  const application_key = document.getElementById("b2-application-key").value.trim();
  const bucket_name = document.getElementById("b2-bucket-name").value.trim();
  const btn = document.getElementById("test-b2-btn");
  const note = document.getElementById("b2-status-note");
  btn.disabled = true;
  note.textContent = "Testing…";
  note.style.color = "var(--muted)";
  try {
    await api("/admin/backup/b2-test", {
      method: "POST",
      body: JSON.stringify({ key_id: key_id || null, application_key: application_key || null, bucket_name: bucket_name || null }),
    });
    currentSettings = await api("/admin/settings");
    renderB2Status();
  } catch (err) {
    note.textContent = err.message;
    note.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

function setProviderUI(provider) {
  document.getElementById("ollama-section").style.display = provider === "claude" ? "none" : "";
  document.getElementById("claude-section").style.display = provider === "claude" ? "" : "none";
}

function renderClaudeStatus() {
  const note = document.getElementById("claude-status-note");
  const input = document.getElementById("claude-api-key");
  input.placeholder = currentSettings.claude_api_key_set ? "•••• saved (enter a new key to replace)" : "sk-ant-...";
  const checked = currentSettings.claude_status_checked_at
    ? new Date(currentSettings.claude_status_checked_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  if (currentSettings.claude_status === "ok") {
    note.textContent = checked ? `Connected (last checked ${checked})` : "Connected";
    note.style.color = "var(--ok)";
  } else if (currentSettings.claude_status === "error") {
    note.textContent = `${currentSettings.claude_status_detail || "Connection failed"}${checked ? ` (last checked ${checked})` : ""}`;
    note.style.color = "var(--danger)";
  } else if (currentSettings.claude_api_key_set) {
    note.textContent = "Key saved, but not tested yet.";
    note.style.color = "var(--muted)";
  } else {
    note.textContent = "No API key saved yet.";
    note.style.color = "var(--muted)";
  }
  updateProviderSummary();
}

async function changeProvider(provider) {
  setProviderUI(provider);
  await api("/admin/settings", { method: "PUT", body: JSON.stringify({ ai_provider: provider }) });
  currentSettings.ai_provider = provider;
  updateProviderSummary();
}

async function saveClaudeKey() {
  const input = document.getElementById("claude-api-key");
  const key = input.value.trim();
  if (!key) {
    flash("claude-status-note", "Enter a key to save.", true);
    return;
  }
  await api("/admin/settings", { method: "PUT", body: JSON.stringify({ claude_api_key: key }) });
  input.value = "";
  currentSettings.claude_api_key_set = true;
  currentSettings.claude_status = null;
  currentSettings.claude_status_detail = null;
  renderClaudeStatus();
}

async function testClaudeConnection() {
  const input = document.getElementById("claude-api-key");
  const typedKey = input.value.trim();
  const btn = document.getElementById("test-claude-btn");
  const note = document.getElementById("claude-status-note");
  btn.disabled = true;
  note.textContent = "Testing…";
  note.style.color = "var(--muted)";
  try {
    await api("/admin/claude/test", { method: "POST", body: JSON.stringify({ api_key: typedKey || null }) });
    currentSettings = await api("/admin/settings");
    renderClaudeStatus();
  } catch (err) {
    note.textContent = err.message;
    note.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

async function saveProfile() {
  const profile_name = document.getElementById("profile-name").value.trim() || null;
  const profile_role = document.getElementById("profile-role").value.trim() || null;
  const profile_context = document.getElementById("profile-context").value.trim() || null;
  await api("/admin/settings", { method: "PUT", body: JSON.stringify({ profile_name, profile_role, profile_context }) });
  Object.assign(currentSettings, { profile_name, profile_role, profile_context });
  updateProfileSummary();
  flash("model-status", "", false);
  const btn = document.getElementById("save-profile-btn");
  const original = btn.textContent;
  btn.textContent = "Saved!";
  setTimeout(() => (btn.textContent = original), 1500);
}

async function loadModels() {
  const select = document.getElementById("model-select");
  const note = document.getElementById("model-empty-note");
  select.innerHTML = "";
  note.textContent = "";
  try {
    const { models } = await api("/admin/ollama-models");
    if (models.length === 0) {
      note.textContent = "Ollama is reachable but no models are pulled yet. Run: ollama pull llama3.2:3b";
    }
    const current = currentSettings?.ollama_model;
    if (current && !models.includes(current)) {
      models.unshift(current);
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    }
    if (current) select.value = current;
  } catch (err) {
    note.textContent = err.message;
  }
}

async function saveModel() {
  const ollama_model = document.getElementById("model-select").value;
  if (!ollama_model) return;
  await api("/admin/settings", { method: "PUT", body: JSON.stringify({ ollama_model }) });
  currentSettings.ollama_model = ollama_model;
  updateProviderSummary();
  flash("model-status", "Saved!", false);
}

async function backupNow() {
  const btn = document.getElementById("backup-now-btn");
  const status = document.getElementById("backup-status");
  btn.disabled = true;
  status.textContent = "Running…";
  status.style.color = "var(--muted)";
  try {
    const result = await api("/admin/backup/run", { method: "POST" });
    flash("backup-status", result.detail || "Backup complete!", result.status === "error");
    currentSettings.backup_last_run_at = new Date().toISOString();
    currentSettings.backup_last_status = result.status;
    currentSettings.backup_last_detail = result.detail;
    renderBackupScheduleNote();
    loadBackups();
  } catch (err) {
    flash("backup-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadBackups() {
  const backups = await api("/admin/backups");
  const list = document.getElementById("backups-list");
  list.innerHTML = "";
  if (backups.length === 0) {
    list.innerHTML = '<div class="empty">No backups yet.</div>';
    return;
  }
  for (const b of backups) {
    const row = document.createElement("div");
    row.className = "backup-row";
    const modified = new Date(b.modified).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `
      <span class="backup-name">${escapeHtml(b.file)}</span>
      <span class="project-tag">${b.size_kb} KB &middot; ${modified}</span>
      <button class="secondary" style="padding: 4px 8px; font-size: 12px; color: var(--danger); border-color: var(--danger);" data-file="${escapeHtml(b.file)}">Delete</button>
    `;
    row.querySelector("button").addEventListener("click", () => deleteBackup(b.file));
    list.appendChild(row);
  }
}

async function deleteBackup(file) {
  if (!confirm(`Delete backup "${file}"?`)) return;
  try {
    await api(`/admin/backups/${encodeURIComponent(file)}`, { method: "DELETE" });
    loadBackups();
  } catch (err) {
    flash("backup-status", err.message, true);
  }
}

async function deleteAllBackups() {
  if (!confirm("Delete all backups? This does not touch your live data, only the saved snapshots.")) return;
  const btn = document.getElementById("delete-all-backups-btn");
  btn.disabled = true;
  try {
    const result = await api("/admin/backups", { method: "DELETE" });
    flash("backup-status", `Deleted ${result.deleted} backup(s).`, false);
    loadBackups();
  } catch (err) {
    flash("backup-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderSecurityReport(report) {
  const results = document.getElementById("check-results");
  const note = document.getElementById("last-checked-note");
  const regressedEl = document.getElementById("check-regressed");

  results.innerHTML = "";
  for (const r of report.results) {
    const row = document.createElement("div");
    row.className = "check-row";
    row.innerHTML = `
      <span class="check-status ${r.status}">${r.status}</span>
      <div>
        <div><strong>${escapeHtml(r.check)}</strong></div>
        <div style="font-size: 13px; color: var(--muted);">${escapeHtml(r.detail)}</div>
      </div>
    `;
    results.appendChild(row);
  }

  if (report.checked_at) {
    const when = new Date(report.checked_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    note.textContent = `Last checked ${when}`;
  }

  if (report.regressed && report.regressed.length > 0) {
    regressedEl.innerHTML = `<div class="check-row" style="border-color: var(--danger);"><span class="check-status fail">new</span><div>Regressed since last check: ${report.regressed.map(escapeHtml).join(", ")}</div></div>`;
  } else {
    regressedEl.innerHTML = "";
  }

  updateSecuritySummary(report);
}

async function loadLatestSecurityCheck() {
  const report = await api("/admin/security-check/latest");
  if (report.results.length === 0) {
    document.getElementById("check-results").innerHTML = '<div class="empty">No checks run yet. Click "Run Security Check" or wait for the automatic background check.</div>';
    updateSecuritySummary(null);
    return;
  }
  renderSecurityReport(report);
}

async function runSecurityCheck() {
  const btn = document.getElementById("run-check-btn");
  const results = document.getElementById("check-results");
  btn.disabled = true;
  results.innerHTML = '<div class="empty">Running checks...</div>';
  try {
    const report = await api("/admin/security-check", { method: "POST" });
    renderSecurityReport(report);
    flash("check-status", "Done", false);
    loadSecurityCheckHistory();
  } catch (err) {
    results.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function loadSecurityCheckHistory() {
  const list = document.getElementById("check-history-list");
  const runs = await api("/admin/security-check/history");
  list.innerHTML = "";
  if (runs.length === 0) {
    list.innerHTML = '<li class="empty">No runs yet.</li>';
    return;
  }
  for (const r of runs) {
    const li = document.createElement("li");
    const time = new Date(r.created_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const failCount = r.results.filter((x) => x.status === "fail" || x.status === "error").length;
    const summary = failCount > 0 ? `${failCount} issue${failCount === 1 ? "" : "s"} found` : "All clear";
    li.innerHTML = `<div class="note-time">${time}</div>${escapeHtml(summary)}`;
    list.appendChild(li);
  }
}

function renderUpdateInfo(data) {
  const info = document.getElementById("update-info");
  const applyBtn = document.getElementById("apply-update-btn");

  if (data.error) {
    info.innerHTML = `<div class="error-text">${escapeHtml(data.error)}</div>`;
    applyBtn.disabled = true;
    return;
  }

  if (data.dirty_files && data.dirty_files.length > 0) {
    info.innerHTML = `<div class="error-text">Local changes present in: ${data.dirty_files.map(escapeHtml).join(", ")}. Resolve these before updating.</div>`;
    applyBtn.disabled = true;
    return;
  }

  if (!data.available) {
    info.innerHTML = `<div class="empty">Up to date — v${escapeHtml(data.current_version || "?")} (${escapeHtml(data.current_commit || "")}) on <strong>${escapeHtml(data.branch || "")}</strong>.</div>`;
    applyBtn.disabled = true;
    return;
  }

  const commitList = data.commits.map((c) => `<div style="font-size: 13px; color: var(--muted);">${escapeHtml(c)}</div>`).join("");
  info.innerHTML = `
    <div style="margin-bottom: 6px;">v${escapeHtml(data.current_version)} → v${escapeHtml(data.latest_version)} available — ${data.commits_behind} commit${data.commits_behind === 1 ? "" : "s"} behind on <strong>${escapeHtml(data.branch)}</strong> (${escapeHtml(data.current_commit)} → ${escapeHtml(data.latest_commit)}):</div>
    ${commitList}
  `;
  applyBtn.disabled = false;
}

async function checkForUpdate() {
  const btn = document.getElementById("check-update-btn");
  const info = document.getElementById("update-info");
  btn.disabled = true;
  document.getElementById("apply-update-btn").disabled = true;
  info.innerHTML = '<div class="empty">Checking GitHub...</div>';
  try {
    const data = await api("/admin/update/check");
    renderUpdateInfo(data);
    updateUpdatesSummary(data);
  } catch (err) {
    info.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function applyUpdate() {
  if (!confirm("Pull the latest app code from GitHub? You'll need to restart Raven afterward to apply it.")) return;
  const btn = document.getElementById("apply-update-btn");
  btn.disabled = true;
  try {
    const result = await api("/admin/update/apply", { method: "POST" });
    let msg = `Updated to v${result.new_version} (${result.new_commit}). Restart Raven to apply the changes.`;
    if (result.deps_updated) msg += " New Python dependencies were installed.";
    if (result.pip_error) {
      msg = `Code updated to v${result.new_version} (${result.new_commit}), but installing new dependencies failed: ${result.pip_error}. Restart Raven, then run: .venv/bin/pip install -r requirements.txt`;
    }
    document.getElementById("update-info").innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    document.getElementById("updates-group-sub").textContent = "Restart required";
    flash("update-status", "Done", false);
  } catch (err) {
    flash("update-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteAllTasks() {
  if (!confirm("Delete all tasks? A backup will be made first, but this can't be undone from the app.")) return;
  const btn = document.getElementById("delete-tasks-btn");
  btn.disabled = true;
  try {
    const result = await api("/admin/tasks", { method: "DELETE" });
    flash("delete-tasks-status", `Deleted ${result.deleted} task(s). Backup: ${result.backup_file}`, false);
    loadBackups();
  } catch (err) {
    flash("delete-tasks-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteAllEntries() {
  if (!confirm("Delete all entries? A backup will be made first, but this can't be undone from the app.")) return;
  const btn = document.getElementById("delete-entries-btn");
  btn.disabled = true;
  try {
    const result = await api("/admin/entries", { method: "DELETE" });
    flash("delete-entries-status", `Deleted ${result.deleted} entr${result.deleted === 1 ? "y" : "ies"}. Backup: ${result.backup_file}`, false);
    loadBackups();
  } catch (err) {
    flash("delete-entries-status", err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function openResetModal() {
  document.getElementById("reset-db-confirm-input").value = "";
  document.getElementById("reset-db-confirm-btn").disabled = true;
  document.getElementById("reset-db-modal-backdrop").classList.remove("hidden");
}

function closeResetModal() {
  document.getElementById("reset-db-modal-backdrop").classList.add("hidden");
}

async function resetDatabase() {
  const btn = document.getElementById("reset-db-confirm-btn");
  btn.disabled = true;
  try {
    const result = await api("/admin/reset", { method: "POST" });
    closeResetModal();
    flash("reset-db-status", `Database reset. Backup: ${result.backup_file}`, false);
    loadBackups();
  } catch (err) {
    flash("reset-db-status", err.message, true);
    btn.disabled = false;
  }
}

document.getElementById("save-profile-btn").addEventListener("click", saveProfile);
document.getElementById("save-model-btn").addEventListener("click", saveModel);
document.getElementById("provider-ollama").addEventListener("change", () => changeProvider("ollama"));
document.getElementById("provider-claude").addEventListener("change", () => changeProvider("claude"));
document.getElementById("save-claude-key-btn").addEventListener("click", saveClaudeKey);
document.getElementById("test-claude-btn").addEventListener("click", testClaudeConnection);
document.getElementById("refresh-models-btn").addEventListener("click", loadModels);
document.getElementById("backup-now-btn").addEventListener("click", backupNow);
document.getElementById("delete-all-backups-btn").addEventListener("click", deleteAllBackups);
document.getElementById("save-backup-schedule-btn").addEventListener("click", saveBackupSchedule);
document.getElementById("save-b2-btn").addEventListener("click", saveB2);
document.getElementById("test-b2-btn").addEventListener("click", testB2Connection);
document.getElementById("check-update-btn").addEventListener("click", checkForUpdate);
document.getElementById("apply-update-btn").addEventListener("click", applyUpdate);
document.getElementById("run-check-btn").addEventListener("click", runSecurityCheck);
document.getElementById("check-history-details").addEventListener(
  "toggle",
  (ev) => {
    if (ev.target.open) loadSecurityCheckHistory();
  },
  { once: true }
);
document.getElementById("delete-tasks-btn").addEventListener("click", deleteAllTasks);
document.getElementById("delete-entries-btn").addEventListener("click", deleteAllEntries);
document.getElementById("reset-db-btn").addEventListener("click", openResetModal);
document.getElementById("reset-db-close-btn").addEventListener("click", closeResetModal);
document.getElementById("reset-db-confirm-input").addEventListener("input", (ev) => {
  document.getElementById("reset-db-confirm-btn").disabled = ev.target.value !== "DELETE";
});
document.getElementById("reset-db-confirm-btn").addEventListener("click", resetDatabase);
document.getElementById("open-security-help-btn").addEventListener("click", () => {
  document.getElementById("security-help-backdrop").classList.add("open");
});
document.getElementById("close-security-help-btn").addEventListener("click", () => {
  document.getElementById("security-help-backdrop").classList.remove("open");
});
document.getElementById("security-help-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "security-help-backdrop") ev.target.classList.remove("open");
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") document.getElementById("security-help-backdrop").classList.remove("open");
});

initCollapsibleGroups();

(async function init() {
  await loadSettings();
  await loadModels();
  await loadBackups();
  await loadLatestSecurityCheck();
})();
