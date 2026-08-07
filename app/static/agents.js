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

function renderToolCalls(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return "";
  const items = toolCalls
    .map((tc) => `<li class="${tc.is_error ? "tool-call-error" : ""}">${escapeHtml(tc.result)}</li>`)
    .join("");
  return `<div class="actions-taken"><div class="actions-taken-label">Actions taken</div><ul>${items}</ul></div>`;
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
const SKILL_KEYS = ["create_task", "complete_task", "log_entry"];

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
    output.innerHTML = `<div class="polished-text">${renderMarkdown(run.output)}</div>${renderToolCalls(run.tool_calls)}`;
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
    li.innerHTML = `
      <div class="row between">
        <div class="note-time">${time}</div>
        <button class="secondary run-delete-btn" style="padding: 2px 8px; font-size: 11px; color: var(--danger); border-color: var(--danger);">Delete</button>
      </div>
      ${renderMarkdown(r.output)}${renderToolCalls(r.tool_calls)}
    `;
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

let editingAgentId = null;

function openAgentModal(agent) {
  editingAgentId = agent ? agent.id : null;
  document.getElementById("agent-modal-title").textContent = agent ? "Edit agent" : "New agent";
  document.getElementById("create-agent-btn").textContent = agent ? "Save changes" : "Create agent";

  document.getElementById("agent-name").value = agent ? agent.name : "";
  document.getElementById("agent-description").value = agent ? (agent.description || "") : "";
  document.getElementById("agent-prompt").value = agent ? agent.system_prompt : "";
  document.getElementById("agent-context-mode").value = agent ? agent.context_mode : "none";
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
