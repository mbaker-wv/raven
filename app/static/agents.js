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

// Swaps our CSS-class-based markup for inline styles, since pasting into another app
// (an email compose box, Word, Docs) only carries inline styles and semantic tags —
// classes referencing our own stylesheet don't travel with the clipboard. Light colors
// throughout since the destination is almost always a white background, not our dark theme.
function _emailSafeHtml(html) {
  return html
    .replace(/<div class="md-table-wrap">/g, '<div style="overflow-x:auto;margin:0 0 10px;">')
    .replace(/<table class="md-table">/g, '<table style="border-collapse:collapse;width:100%;font-size:13px;color:#111;">')
    .replace(
      /<th>/g,
      '<th style="border:1px solid #ccc;padding:6px 10px;text-align:left;background:#f2f2f2;font-size:11px;text-transform:uppercase;letter-spacing:0.03em;color:#555;">'
    )
    .replace(/<td>/g, '<td style="border:1px solid #ccc;padding:6px 10px;text-align:left;">')
    .replace(
      /<div class="vuln-report-header">/g,
      '<div style="display:flex;flex-wrap:wrap;gap:6px 20px;border:1px solid #ccc;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#111;">'
    )
    .replace(/<span>/g, '<span style="display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;color:#777;margin-bottom:1px;">')
    .replace(/<h3 class="vuln-report-title">/g, '<h3 style="font-size:18px;font-weight:600;margin:0 0 12px;color:#111;">')
    .replace(/<div class="vuln-report-meta">/g, '<div style="font-size:12px;color:#555;margin:4px 0 14px;">')
    .replace(/<div class="section-heading">/g, '<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#777;margin:18px 0 8px;">')
    .replace(/<div class="polished-text">/g, '<div style="color:#111;line-height:1.5;">');
}

// Writes both HTML and plain-text to the clipboard when html is given, so pasting into a
// rich destination (email, Word, Docs) preserves real tables instead of literal pipe
// characters; plain-text-only destinations still get the readable markdown fallback.
async function copyText(text, btn, html) {
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([_emailSafeHtml(html)], { type: "text/html" }),
        }),
      ]);
    } else {
      throw new Error("rich copy unavailable");
    }
  } catch (err) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err2) {
      // Clipboard API can be unavailable outside a secure context; fall back to the
      // old hidden-textarea + execCommand trick rather than failing silently.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }
  const original = btn.textContent;
  btn.textContent = "Copied!";
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1500);
}

function renderToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return "";
  const items = toolCalls
    .map((tc) => `<li class="${tc.is_error ? "tool-call-error" : ""}">${escapeHtml(tc.result)}</li>`)
    .join("");
  return `<div class="actions-taken"><div class="actions-taken-label">Actions taken</div><ul>${items}</ul></div>`;
}

function _mdTable(headers, rows) {
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`;
}

// Renders the deterministic vuln-report numbers as real tables — computed directly by
// the parser, not dependent on the agent's narrative choosing to mention them.
function renderVulnReportTables(data) {
  if (!data) return "";
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

  let html = '<div class="vuln-report-tables">';
  html += '<div class="vuln-report-header">';
  if (data.prepared_by) html += `<div><span>Prepared by</span>${escapeHtml(data.prepared_by)}</div>`;
  if (data.report_date) html += `<div><span>Date</span>${data.report_date}</div>`;
  html += `<div><span>Source</span>${escapeHtml(data.source_path.split("/").pop())} (${data.file_modified})</div>`;
  html += "</div>";
  html += _mdTable(
    ["Severity", "Open", `Open past threshold`],
    [
      ["Critical", data.critical_open, `${data.critical_open_over_15d} (${data.critical_pct}%)`],
      ["Severe", data.severe_open, `${data.severe_open_over_30d} (${data.severe_pct}%)`],
    ]
  );
  html += `<div class="vuln-report-meta">Total open findings: <b>${data.total_open}</b>${
    data.skipped_rows ? ` &middot; ${data.skipped_rows} row(s) skipped from aging (missing/unparseable published date)` : ""
  }</div>`;

  if (data.backlog) {
    const b = data.backlog;
    html += `<div class="section-heading">Backlog vs ${escapeHtml(b.previous_source)} (${b.previous_modified})</div>`;
    html += _mdTable(
      ["", "Previous", "Current", "Change"],
      [
        ["Total open", b.previous_total, data.total_open, signed(b.delta_total)],
        ["Critical", b.previous_critical, data.critical_open, signed(b.delta_critical)],
        ["Severe", b.previous_severe, data.severe_open, signed(b.delta_severe)],
      ]
    );
  }

  if (data.top_critical_titles.length) {
    html += '<div class="section-heading">What\'s driving the Critical backlog</div>';
    html += _mdTable(
      ["Finding", "Findings", "% of Critical"],
      data.top_critical_titles.map((t) => [t.title, t.finding_count, `${t.pct_of_tier}%`])
    );
  }

  if (data.top_severe_titles.length) {
    html += '<div class="section-heading">What\'s driving the Severe backlog</div>';
    html += _mdTable(
      ["Finding", "Findings", "% of Severe"],
      data.top_severe_titles.map((t) => [t.title, t.finding_count, `${t.pct_of_tier}%`])
    );
  }

  if (data.top_assets.length) {
    html += '<div class="section-heading">Systems to prioritize</div>';
    html += _mdTable(
      ["System", "Critical", "Severe", "Total open", "Risk score"],
      data.top_assets.map((a) => [a.label, a.critical_count, a.severe_count, a.finding_count, a.risk_score.toLocaleString()])
    );
  }

  html += "</div>";
  return html;
}

// Pulls a leading "# Title" line (if the agent's narrative opens with one) out of the raw
// output so it can be hoisted above the deterministic header/tables instead of getting
// stuck below them — reuses markdown.js's own heading pattern (_MD_HEADING).
function extractLeadingHeading(text) {
  if (!text) return { title: null, rest: text };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const match = i < lines.length ? lines[i].match(_MD_HEADING) : null;
  if (!match) return { title: null, rest: text };
  return { title: match[2], rest: lines.slice(i + 1).join("\n") };
}

// The agent's own instructions sometimes have it restate "Prepared by" / "Report date" /
// "Source" itself, worded a different way each time ("By ...", "Prepared by:", "Report
// authored by ...") — matching label wording is a losing game, so strip by two signals
// instead: known label patterns, and (separately) any short line containing the exact
// byline text we already know from the deterministic header, whatever leads into it.
const _REDUNDANT_METADATA_LINE = /^\*{0,2}(prepared by|report date|reporting period|data source|source|by)\*{0,2}\s*:?\s*.*/i;
const _SHORT_LINE_MAX_CHARS = 100;

function stripRedundantMetadataLines(text, preparedBy) {
  if (!text) return text;
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (_REDUNDANT_METADATA_LINE.test(trimmed)) return false;
      if (preparedBy && trimmed.length <= _SHORT_LINE_MAX_CHARS && trimmed.toLowerCase().includes(preparedBy.toLowerCase())) return false;
      return true;
    })
    .join("\n");
}

let agents = [];

function populateRunAfterSelect(excludeAgentId) {
  const select = document.getElementById("agent-runafter");
  const previous = select.value;
  select.innerHTML = '<option value="">— Independent, runs on its own —</option>';
  for (const a of agents) {
    if (excludeAgentId && a.id === excludeAgentId) continue;
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    select.appendChild(opt);
  }
  select.value = previous;
  updateChainPreview();
}

function updateChainPreview() {
  const select = document.getElementById("agent-runafter");
  const preview = document.getElementById("chain-preview");
  if (!select.value) {
    preview.classList.remove("visible");
    return;
  }
  const label = select.options[select.selectedIndex].text;
  preview.innerHTML = `When <b>${escapeHtml(label)}</b> finishes a run, its output is appended to this agent's context and it runs automatically.`;
  preview.classList.add("visible");
}

async function loadAgents() {
  agents = await api("/agents");
  populateRunAfterSelect();
  const container = document.getElementById("agents-container");
  container.innerHTML = "";
  if (agents.length === 0) {
    container.innerHTML = '<div class="empty">No agents yet. Create one to get started.</div>';
  } else {
    for (const agent of agents) {
      container.appendChild(renderAgentCard(agent));
    }
  }
  renderSkillUsage();
}

// Built-in skills only ever change by editing tools.py, so there's no API for this list —
// just keep these keys in sync with SKILLS in app/tools.py.
const SKILL_KEYS = ["create_task", "complete_task", "log_entry", "search_emails"];

function renderSkillUsage() {
  for (const key of SKILL_KEYS) {
    const el = document.getElementById(`skill-used-by-${key}`);
    if (!el) continue;
    const users = agents.filter((a) => (a.enabled_skills || "").split(",").includes(key)).map((a) => a.name);
    el.textContent = users.length === 0 ? "Not used by any agent yet." : `Used by ${users.length} agent${users.length === 1 ? "" : "s"} — ${users.join(", ")}`;
  }
}

function renderAgentCard(agent) {
  const card = document.createElement("div");
  card.className = "agent-card";
  const isDigest = agent.context_mode === "digest";
  const end = todayISO();
  const start = addDays(end, -6);

  card.innerHTML = `
    <div>
      <span class="agent-card-title agent-title-link">${escapeHtml(agent.name)}</span>
      <span class="provider-chip ${agent.ai_provider}">${agent.ai_provider === "claude" ? "Claude" : "Ollama"}</span>
    </div>
    ${agent.description ? `<div class="agent-card-desc">${escapeHtml(agent.description)}</div>` : ""}
    ${agent.run_after_agent_name ? `<div class="agent-card-chain">↳ runs after <b>${escapeHtml(agent.run_after_agent_name)}</b></div>` : ""}
    <div class="row agent-card-actions">
      ${isDigest ? `<input type="date" class="run-start" value="${start}"><input type="date" class="run-end" value="${end}">` : ""}
      <button class="run-btn">Run</button>
      <button class="secondary delete-btn" style="color: var(--danger); border-color: var(--danger);">Delete</button>
    </div>
    <div class="agent-output"></div>
    <details class="agent-history">
      <summary>Run history</summary>
      <ul class="history-list"><li class="empty">Loading...</li></ul>
    </details>
  `;

  card.querySelector(".agent-title-link").addEventListener("click", () => openAgentModal(agent));
  card.querySelector(".run-btn").addEventListener("click", () => runAgent(agent, card));
  card.querySelector(".delete-btn").addEventListener("click", () => deleteAgent(agent, card));
  card.querySelector("details.agent-history").addEventListener(
    "toggle",
    (ev) => {
      if (ev.target.open) loadHistory(agent.id, card);
    },
    { once: true }
  );

  return card;
}

async function runAgent(agent, card) {
  const btn = card.querySelector(".run-btn");
  const output = card.querySelector(".agent-output");
  btn.disabled = true;
  output.innerHTML = '<div class="empty">Running...</div>';
  try {
    let url = `/agents/${agent.id}/run`;
    if (agent.context_mode === "digest") {
      const start = card.querySelector(".run-start").value;
      const end = card.querySelector(".run-end").value;
      url += `?start=${start}&end=${end}`;
    }
    const run = await api(url, { method: "POST" });
    let { title, rest } = run.vuln_report_data ? extractLeadingHeading(run.output) : { title: null, rest: run.output };
    if (run.vuln_report_data) rest = stripRedundantMetadataLines(rest, run.vuln_report_data.prepared_by);
    const reportHtml =
      (title ? `<h3 class="vuln-report-title">${escapeHtml(title)}</h3>` : "") +
      renderVulnReportTables(run.vuln_report_data) +
      `<div class="polished-text">${renderMarkdown(rest)}</div>`;
    output.innerHTML = `
      <div class="copy-row"><button class="secondary copy-btn" type="button">Copy</button></div>
      ${reportHtml}${renderToolCalls(run.tool_calls)}
    `;
    output.querySelector(".copy-btn").addEventListener("click", (ev) => copyText(run.output, ev.currentTarget, reportHtml));
    const details = card.querySelector("details.agent-history");
    if (details.open) loadHistory(agent.id, card);
  } catch (err) {
    output.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function loadHistory(agentId, card) {
  const list = card.querySelector(".history-list");
  const runs = await api(`/agents/${agentId}/runs`);
  list.innerHTML = "";
  if (runs.length === 0) {
    list.innerHTML = '<li class="empty">No runs yet.</li>';
    return;
  }
  for (const r of runs) {
    const li = document.createElement("li");
    const time = new Date(r.created_at + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    let { title, rest } = r.vuln_report_data ? extractLeadingHeading(r.output) : { title: null, rest: r.output };
    if (r.vuln_report_data) rest = stripRedundantMetadataLines(rest, r.vuln_report_data.prepared_by);
    const reportHtml =
      (title ? `<h3 class="vuln-report-title">${escapeHtml(title)}</h3>` : "") +
      renderVulnReportTables(r.vuln_report_data) +
      `<div class="polished-text">${renderMarkdown(rest)}</div>`;
    li.innerHTML = `
      <div class="row between">
        <div class="note-time">${time}</div>
        <div class="row">
          <button class="secondary run-copy-btn" type="button" style="padding: 2px 8px; font-size: 11px;">Copy</button>
          <button class="secondary run-delete-btn" style="padding: 2px 8px; font-size: 11px; color: var(--danger); border-color: var(--danger);">Delete</button>
        </div>
      </div>
      ${reportHtml}${renderToolCalls(r.tool_calls)}
    `;
    li.querySelector(".run-copy-btn").addEventListener("click", (ev) => copyText(r.output, ev.currentTarget, reportHtml));
    li.querySelector(".run-delete-btn").addEventListener("click", async () => {
      if (!confirm("Delete this run? This can't be undone.")) return;
      await api(`/agents/${agentId}/runs/${r.id}`, { method: "DELETE" });
      li.remove();
      if (!list.querySelector("li")) {
        list.innerHTML = '<li class="empty">No runs yet.</li>';
      }
    });
    list.appendChild(li);
  }
}

async function deleteAgent(agent, card) {
  if (!confirm(`Delete agent "${agent.name}"? This also removes its run history.`)) return;
  await api(`/agents/${agent.id}`, { method: "DELETE" });
  card.remove();
  loadAgents();
}

function selectProvider(provider) {
  document.getElementById("agent-provider").value = provider;
  document.getElementById("card-ollama").classList.toggle("selected", provider === "ollama");
  document.getElementById("card-claude").classList.toggle("selected", provider === "claude");
  const isClaude = provider === "claude";
  document.querySelectorAll(".agent-skill").forEach((cb) => (cb.disabled = !isClaude));
  document.getElementById("skills-ollama-hint").classList.toggle("visible", !isClaude);
}

function updateVulnReportPathVisibility() {
  const contextMode = document.getElementById("agent-context-mode").value;
  const show = contextMode === "vuln_report";
  document.getElementById("vuln-report-path-group").classList.toggle("hidden", !show);
  document.getElementById("vuln-report-previous-path-group").classList.toggle("hidden", !show);
}

// Native file picker via pywebview (only available when running through the actual
// Raven desktop app, not a plain browser tab — falls back to manual typing otherwise).
async function pickReportFile(targetInputId) {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.pick_file) {
    alert("File picker is only available in the Raven desktop app. Type or paste the path directly.");
    return;
  }
  const path = await window.pywebview.api.pick_file();
  if (path) document.getElementById(targetInputId).value = path;
}

document.querySelectorAll(".path-browse-btn").forEach((btn) => {
  btn.addEventListener("click", () => pickReportFile(btn.dataset.target));
});

let editingAgentId = null;

function openAgentModal(agent) {
  editingAgentId = agent ? agent.id : null;
  document.getElementById("agent-modal-title").textContent = agent ? "Edit agent" : "New agent";
  document.getElementById("create-agent-btn").textContent = agent ? "Save changes" : "Create agent";

  document.getElementById("agent-name").value = agent ? agent.name : "";
  document.getElementById("agent-description").value = agent ? (agent.description || "") : "";
  document.getElementById("agent-prompt").value = agent ? agent.system_prompt : "";
  document.getElementById("agent-context-mode").value = agent ? agent.context_mode : "none";
  document.getElementById("agent-vuln-report-path").value = agent ? (agent.vuln_report_path || "") : "";
  document.getElementById("agent-vuln-report-previous-path").value = agent ? (agent.vuln_report_previous_path || "") : "";
  updateVulnReportPathVisibility();
  selectProvider(agent ? agent.ai_provider : "ollama");

  const enabledSkills = agent && agent.enabled_skills ? agent.enabled_skills.split(",").filter(Boolean) : [];
  document.querySelectorAll(".agent-skill").forEach((cb) => {
    cb.checked = enabledSkills.includes(cb.value);
  });

  populateRunAfterSelect(editingAgentId);
  document.getElementById("agent-runafter").value = agent && agent.run_after_agent_id ? agent.run_after_agent_id : "";
  updateChainPreview();

  document.getElementById("agent-modal-backdrop").classList.remove("hidden");
  document.getElementById("agent-name").focus();
}

function closeAgentModal() {
  document.getElementById("agent-modal-backdrop").classList.add("hidden");
}

function openHelpPanel() {
  document.getElementById("help-backdrop").classList.add("open");
}

function closeHelpPanel() {
  document.getElementById("help-backdrop").classList.remove("open");
}

async function createAgent() {
  const name = document.getElementById("agent-name").value.trim();
  const system_prompt = document.getElementById("agent-prompt").value.trim();
  if (!name || !system_prompt) return;
  const description = document.getElementById("agent-description").value.trim() || null;
  const context_mode = document.getElementById("agent-context-mode").value;
  const vuln_report_path = context_mode === "vuln_report" ? document.getElementById("agent-vuln-report-path").value.trim() || null : null;
  const vuln_report_previous_path =
    context_mode === "vuln_report" ? document.getElementById("agent-vuln-report-previous-path").value.trim() || null : null;
  const ai_provider = document.getElementById("agent-provider").value;
  const run_after_agent_id = document.getElementById("agent-runafter").value || null;
  const enabled_skills =
    ai_provider === "claude"
      ? Array.from(document.querySelectorAll(".agent-skill:checked")).map((cb) => cb.value).join(",") || null
      : null;

  const payload = {
    name,
    description,
    system_prompt,
    context_mode,
    vuln_report_path,
    vuln_report_previous_path,
    ai_provider,
    run_after_agent_id: run_after_agent_id ? Number(run_after_agent_id) : null,
    enabled_skills,
  };

  if (editingAgentId) {
    await api(`/agents/${editingAgentId}`, { method: "PUT", body: JSON.stringify(payload) });
  } else {
    await api("/agents", { method: "POST", body: JSON.stringify(payload) });
  }

  closeAgentModal();
  loadAgents();
}

document.getElementById("open-modal-btn").addEventListener("click", () => openAgentModal());
document.getElementById("close-modal-btn").addEventListener("click", closeAgentModal);
document.getElementById("create-agent-btn").addEventListener("click", createAgent);
document.getElementById("agent-modal-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "agent-modal-backdrop") closeAgentModal();
});
document.getElementById("card-ollama").addEventListener("click", () => selectProvider("ollama"));
document.getElementById("card-claude").addEventListener("click", () => selectProvider("claude"));
document.getElementById("agent-runafter").addEventListener("change", updateChainPreview);
document.getElementById("agent-context-mode").addEventListener("change", updateVulnReportPathVisibility);
document.getElementById("open-help-btn").addEventListener("click", openHelpPanel);
document.getElementById("open-guide-btn").addEventListener("click", openHelpPanel);
document.getElementById("close-help-btn").addEventListener("click", closeHelpPanel);
document.getElementById("help-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "help-backdrop") closeHelpPanel();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closeAgentModal();
    closeHelpPanel();
  }
});

function showAgentsTab() {
  document.getElementById("tab-agents").classList.remove("hidden");
  document.getElementById("tab-skills").classList.add("hidden");
  document.getElementById("tab-btn-agents").classList.add("active");
  document.getElementById("tab-btn-skills").classList.remove("active");
}

function showSkillsTab() {
  document.getElementById("tab-skills").classList.remove("hidden");
  document.getElementById("tab-agents").classList.add("hidden");
  document.getElementById("tab-btn-skills").classList.add("active");
  document.getElementById("tab-btn-agents").classList.remove("active");
}

document.getElementById("tab-btn-agents").addEventListener("click", showAgentsTab);
document.getElementById("tab-btn-skills").addEventListener("click", showSkillsTab);

(async function init() {
  await loadAgents();
})();
