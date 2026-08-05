(function initSidebarCollapse() {
  const sidebar = document.getElementById("app-sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  if (!sidebar || !toggle) return;
  const collapsed = localStorage.getItem("sidebar-collapsed") === "1";
  sidebar.classList.toggle("collapsed", collapsed);
  toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  toggle.addEventListener("click", () => {
    const isCollapsed = sidebar.classList.toggle("collapsed");
    localStorage.setItem("sidebar-collapsed", isCollapsed ? "1" : "0");
    toggle.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
  });
})();

(async function loadSidebarVersion() {
  const sidebar = document.getElementById("app-sidebar");
  const statusLink = document.getElementById("sidebar-status");
  if (!sidebar) return;
  try {
    const res = await fetch("/api/version");
    const data = await res.json();
    const footer = document.createElement("a");
    footer.id = "sidebar-version";
    footer.className = "sidebar-version";
    footer.href = "https://github.com/mbaker-wv/raven/releases";
    footer.target = "_blank";
    footer.rel = "noopener";
    footer.textContent = `v${data.version}`;
    if (statusLink) statusLink.insertAdjacentElement("afterend", footer);
    else sidebar.appendChild(footer);
  } catch (err) {
    // Version display is a nice-to-have; don't let a failed fetch break the sidebar.
  }
})();

(async function loadSidebarAiStatus() {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-label");
  const link = document.getElementById("sidebar-status");
  if (!dot || !label) return;
  try {
    const res = await fetch("/api/admin/ai-status");
    const data = await res.json();
    dot.className = `status-dot ${data.status === "ok" ? "ok" : "error"}`;
    const providerLabel = data.provider === "claude" ? "Claude" : "Ollama";
    label.textContent = providerLabel;
    if (link) link.title = data.detail || `${providerLabel} · ${data.model}`;
  } catch (err) {
    dot.className = "status-dot error";
    label.textContent = "Status unavailable";
  }
})();
