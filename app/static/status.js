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
    label.textContent = `${providerLabel} · ${data.model}`;
    if (link) link.title = data.detail || "";
  } catch (err) {
    dot.className = "status-dot error";
    label.textContent = "Status unavailable";
  }
})();
