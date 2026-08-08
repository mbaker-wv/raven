const API = "/api";
const AUTOSAVE_DELAY_MS = 800;

async function api(path, options) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = `${options?.method || "GET"} ${path} failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    background: "#0f1115",
    primaryColor: "#1c202a",
    primaryTextColor: "#e6e8ec",
    primaryBorderColor: "#5b8cff",
    lineColor: "#5b8cff",
    secondaryColor: "#171a21",
    tertiaryColor: "#171a21",
    edgeLabelBackground: "#0f1115",
    clusterBkg: "#171a21",
    fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    fontSize: "14px",
  },
});

let items = [];
let currentItem = null;
let saveTimer = null;
let generating = false;
let renderCounter = 0;
let quizEditMode = false;
let mapEditMode = false;
let lastSavedSnapshot = null;
let checksStale = false;
let checking = false;

const itemsRow = document.getElementById("learn-items");
const titleInput = document.getElementById("learn-title-input");
const sourceText = document.getElementById("learn-source-text");
const saveStatus = document.getElementById("learn-save-status");
const urlInput = document.getElementById("learn-url-input");
const importUrlBtn = document.getElementById("learn-import-url-btn");
const notesSelect = document.getElementById("learn-notes-select");
const generateBtn = document.getElementById("learn-generate-btn");
const errorEl = document.getElementById("learn-error");
const outputPanel = document.getElementById("learn-output-panel");
const summaryEl = document.getElementById("learn-summary");
const outlineList = document.getElementById("learn-outline-list");
const mapFrame = document.getElementById("learn-map-frame");
const mapEditor = document.getElementById("learn-map-editor");
const mapCode = document.getElementById("learn-map-code");
const mapEditBtn = document.getElementById("learn-map-edit-btn");
const mapApplyBtn = document.getElementById("learn-map-apply-btn");
const mapEditorError = document.getElementById("learn-map-editor-error");
const quizList = document.getElementById("learn-quiz-list");
const quizEditBtn = document.getElementById("learn-quiz-edit-btn");
const checkStatus = document.getElementById("learn-check-status");
const checkBtn = document.getElementById("learn-check-btn");

function setError(msg) {
  errorEl.textContent = msg || "";
}

function setSaveStatus(text) {
  saveStatus.textContent = text;
}

function hasOutput() {
  return !!(currentItem && (currentItem.chunks?.length || currentItem.mermaid || currentItem.quiz?.length));
}

function updateCheckBar() {
  if (!currentItem) return;
  if (checksStale) {
    checkStatus.textContent = "Edited since last check — recheck to verify.";
    checkStatus.className = "learn-check-status stale";
  } else if (currentItem.checks) {
    checkStatus.textContent = currentItem.checks.overall || "Checked.";
    checkStatus.className = "learn-check-status";
  } else {
    checkStatus.textContent = "Not checked yet — verify this against your source before trusting it.";
    checkStatus.className = "learn-check-status";
  }
}

function invalidateChecks() {
  if (!checksStale) {
    checksStale = true;
    outputPanel.classList.add("checks-stale");
  }
  if (currentItem) currentItem.checks = null;
  updateCheckBar();
}

async function loadItems() {
  items = await api("/learn");
  if (!currentItem && items.length) currentItem = items[0];
  if (currentItem) currentItem = items.find((i) => i.id === currentItem.id) || items[0] || null;
  renderItemsRow();
  if (currentItem) {
    renderCurrentItem();
  } else {
    await createItem();
  }
}

function renderItemsRow() {
  itemsRow.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary filter-btn" + (currentItem && item.id === currentItem.id ? " active" : "");
    btn.textContent = item.title || "Untitled";
    btn.addEventListener("click", () => selectItem(item.id));
    itemsRow.appendChild(btn);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "secondary filter-btn";
  newBtn.textContent = "+ New";
  newBtn.addEventListener("click", createItem);
  itemsRow.appendChild(newBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn-ghost-danger";
  delBtn.textContent = "Delete";
  delBtn.disabled = !currentItem;
  delBtn.addEventListener("click", deleteCurrentItem);
  itemsRow.appendChild(delBtn);
}

async function selectItem(id) {
  if (currentItem && id === currentItem.id) return;
  await flushSave();
  currentItem = items.find((i) => i.id === id) || null;
  renderItemsRow();
  renderCurrentItem();
}

async function createItem() {
  const item = await api("/learn", { method: "POST", body: JSON.stringify({ title: "Untitled", source_text: "" }) });
  items.unshift(item);
  currentItem = item;
  renderItemsRow();
  renderCurrentItem();
}

async function deleteCurrentItem() {
  if (!currentItem) return;
  if (!confirm(`Delete "${currentItem.title || "Untitled"}"? This can't be undone.`)) return;
  clearTimeout(saveTimer);
  await api(`/learn/${currentItem.id}`, { method: "DELETE" });
  items = items.filter((i) => i.id !== currentItem.id);
  currentItem = items[0] || null;
  renderItemsRow();
  if (currentItem) renderCurrentItem();
  else await createItem();
}

function renderCurrentItem() {
  setError("");
  quizEditMode = false;
  mapEditMode = false;
  checksStale = false;
  outputPanel.classList.remove("checks-stale");
  titleInput.value = currentItem.title || "";
  sourceText.value = currentItem.source_text || "";
  lastSavedSnapshot = snapshotOf(currentItem);
  renderOutput();
}

function snapshotOf(item) {
  return JSON.stringify({
    title: item.title || "",
    source_text: item.source_text || "",
    summary: item.summary || null,
    chunks: item.chunks || [],
    mermaid: item.mermaid || null,
    quiz: item.quiz || [],
  });
}

function scheduleSave() {
  setSaveStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!currentItem) return;
  currentItem.title = titleInput.value.trim() || "Untitled";
  currentItem.source_text = sourceText.value;
  const snapshot = snapshotOf(currentItem);
  if (snapshot === lastSavedSnapshot) {
    setSaveStatus("");
    return;
  }
  try {
    const updated = await api(`/learn/${currentItem.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: currentItem.title,
        source_text: currentItem.source_text,
        summary: currentItem.summary ?? null,
        chunks: currentItem.chunks || [],
        mermaid: currentItem.mermaid ?? null,
        quiz: currentItem.quiz || [],
      }),
    });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
    renderItemsRow();
    setSaveStatus("Saved");
  } catch (err) {
    setSaveStatus("");
    setError(err.message);
  }
}

titleInput.addEventListener("input", scheduleSave);
sourceText.addEventListener("input", scheduleSave);
window.addEventListener("beforeunload", flushSave);

importUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url || !currentItem) return;
  setError("");
  importUrlBtn.disabled = true;
  importUrlBtn.textContent = "Importing…";
  try {
    await flushSave();
    const updated = await api(`/learn/${currentItem.id}/import-url`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    Object.assign(currentItem, updated);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
    urlInput.value = "";
    renderCurrentItem();
    renderItemsRow();
  } catch (err) {
    setError(err.message);
  } finally {
    importUrlBtn.disabled = false;
    importUrlBtn.textContent = "Import URL";
  }
});

notesSelect.addEventListener("change", () => {
  const val = notesSelect.value;
  if (!val) return;
  const note = window._learnNoteTabs?.find((t) => String(t.id) === val);
  notesSelect.value = "";
  if (!note) return;
  sourceText.value = note.content || "";
  scheduleSave();
});

async function loadNoteTabsIntoSelect() {
  try {
    const tabs = await api("/note-tabs");
    window._learnNoteTabs = tabs;
    notesSelect.innerHTML = '<option value="">Import from Notes…</option>';
    for (const tab of tabs) {
      const opt = document.createElement("option");
      opt.value = String(tab.id);
      opt.textContent = tab.name;
      notesSelect.appendChild(opt);
    }
  } catch {
    // Notes tabs are optional context; skip silently if unavailable.
  }
}

generateBtn.addEventListener("click", async () => {
  if (!currentItem || generating) return;
  if (hasOutput() && !confirm("This will replace the current outline, map, and quiz. Continue?")) return;
  await flushSave();
  if (!sourceText.value.trim()) {
    setError("Add some text first.");
    return;
  }
  generating = true;
  setError("");
  generateBtn.disabled = true;
  generateBtn.textContent = "Generating…";
  try {
    const updated = await api(`/learn/${currentItem.id}/generate`, { method: "POST" });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
    titleInput.value = currentItem.title || "";
    quizEditMode = false;
    mapEditMode = false;
    checksStale = false;
    outputPanel.classList.remove("checks-stale");
    renderItemsRow();
    await renderOutput();
  } catch (err) {
    setError(err.message);
  } finally {
    generating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = hasOutput() ? "Regenerate" : "Generate";
  }
});

async function renderOutput() {
  outputPanel.style.display = hasOutput() ? "" : "none";
  generateBtn.textContent = hasOutput() ? "Regenerate" : "Generate";
  if (!hasOutput()) return;

  summaryEl.textContent = currentItem.summary || "";
  updateCheckBar();
  renderOutline();
  renderQuiz();
  await renderMap();
}

checkBtn.addEventListener("click", async () => {
  if (!currentItem || checking) return;
  await flushSave();
  checking = true;
  setError("");
  checkBtn.disabled = true;
  checkBtn.textContent = "Checking…";
  try {
    const updated = await api(`/learn/${currentItem.id}/check`, { method: "POST" });
    Object.assign(currentItem, updated);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
    checksStale = false;
    outputPanel.classList.remove("checks-stale");
    updateCheckBar();
    renderOutline();
    renderQuiz();
  } catch (err) {
    setError(err.message);
  } finally {
    checking = false;
    checkBtn.disabled = false;
    checkBtn.textContent = "Check accuracy";
  }
});

/* ---------------- Outline (always editable) ---------------- */

function renderOutline() {
  outlineList.innerHTML = "";
  const chunks = currentItem.chunks || [];
  if (!chunks.length) {
    outlineList.innerHTML = '<p class="learn-empty">No outline yet.</p>';
  }
  chunks.forEach((chunk, idx) => {
    const card = document.createElement("div");
    card.className = "learn-chunk";

    const headRow = document.createElement("div");
    headRow.className = "learn-field-row";
    const headingInput = document.createElement("input");
    headingInput.type = "text";
    headingInput.value = chunk.heading || "";
    headingInput.placeholder = "Heading";
    headingInput.addEventListener("input", () => {
      currentItem.chunks[idx].heading = headingInput.value;
      invalidateChecks();
      scheduleSave();
    });
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "learn-remove-btn";
    removeBtn.title = "Remove this chunk";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      currentItem.chunks.splice(idx, 1);
      invalidateChecks();
      scheduleSave();
      renderOutline();
    });
    headRow.appendChild(headingInput);
    headRow.appendChild(removeBtn);
    card.appendChild(headRow);

    const check = currentItem.checks?.chunk_checks?.find((c) => c.index === idx);
    if (check) {
      const badge = document.createElement("span");
      badge.className = "learn-check-badge " + check.status;
      badge.textContent = check.status;
      card.appendChild(badge);
      if (check.note) {
        const note = document.createElement("div");
        note.className = "learn-check-note";
        note.textContent = check.note;
        card.appendChild(note);
      }
    }

    const textArea = document.createElement("textarea");
    textArea.value = chunk.plain_text || "";
    textArea.placeholder = "Plain-language explanation";
    textArea.addEventListener("input", () => {
      currentItem.chunks[idx].plain_text = textArea.value;
      invalidateChecks();
      scheduleSave();
    });
    card.appendChild(textArea);

    const termsInput = document.createElement("input");
    termsInput.type = "text";
    termsInput.value = (chunk.key_terms || []).join(", ");
    termsInput.placeholder = "Key terms, comma separated";
    termsInput.style.width = "100%";
    termsInput.addEventListener("input", () => {
      currentItem.chunks[idx].key_terms = termsInput.value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      invalidateChecks();
      scheduleSave();
    });
    card.appendChild(termsInput);

    outlineList.appendChild(card);
  });

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "secondary";
  addBtn.textContent = "+ Add chunk";
  addBtn.addEventListener("click", () => {
    currentItem.chunks = currentItem.chunks || [];
    currentItem.chunks.push({ heading: "", plain_text: "", key_terms: [] });
    invalidateChecks();
    scheduleSave();
    renderOutline();
  });
  outlineList.appendChild(addBtn);
}

/* ---------------- Quiz (study mode + edit mode) ---------------- */

function renderQuiz() {
  quizEditBtn.textContent = quizEditMode ? "Done editing" : "Edit quiz";
  quizList.innerHTML = "";
  const quiz = currentItem.quiz || [];

  if (!quiz.length && !quizEditMode) {
    quizList.innerHTML = '<p class="learn-empty">No quiz yet.</p>';
    return;
  }

  if (quizEditMode) {
    quiz.forEach((q, idx) => {
      const card = document.createElement("div");
      card.className = "learn-quiz-item";

      const qRow = document.createElement("div");
      qRow.className = "learn-field-row";
      const qInput = document.createElement("input");
      qInput.type = "text";
      qInput.value = q.question || "";
      qInput.placeholder = "Question";
      qInput.addEventListener("input", () => {
        currentItem.quiz[idx].question = qInput.value;
        invalidateChecks();
        scheduleSave();
      });
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "learn-remove-btn";
      removeBtn.title = "Remove this question";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        currentItem.quiz.splice(idx, 1);
        invalidateChecks();
        scheduleSave();
        renderQuiz();
      });
      qRow.appendChild(qInput);
      qRow.appendChild(removeBtn);
      card.appendChild(qRow);

      const aInput = document.createElement("textarea");
      aInput.value = q.answer || "";
      aInput.placeholder = "Answer";
      aInput.addEventListener("input", () => {
        currentItem.quiz[idx].answer = aInput.value;
        invalidateChecks();
        scheduleSave();
      });
      card.appendChild(aInput);

      quizList.appendChild(card);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "secondary";
    addBtn.textContent = "+ Add question";
    addBtn.addEventListener("click", () => {
      currentItem.quiz = currentItem.quiz || [];
      currentItem.quiz.push({ question: "", answer: "" });
      invalidateChecks();
      scheduleSave();
      renderQuiz();
    });
    quizList.appendChild(addBtn);
    return;
  }

  quiz.forEach((q, idx) => {
    const item = document.createElement("div");
    item.className = "learn-quiz-item";
    const question = document.createElement("div");
    question.className = "learn-quiz-question";
    question.textContent = `${idx + 1}. ${q.question || ""}`;
    item.appendChild(question);
    const check = currentItem.checks?.quiz_checks?.find((c) => c.index === idx);
    if (check) {
      const badge = document.createElement("span");
      badge.className = "learn-check-badge " + check.status;
      badge.textContent = check.status;
      item.appendChild(badge);
      if (check.note) {
        const note = document.createElement("div");
        note.className = "learn-check-note";
        note.textContent = check.note;
        item.appendChild(note);
      }
    }
    const revealBtn = document.createElement("button");
    revealBtn.type = "button";
    revealBtn.className = "secondary";
    revealBtn.textContent = "Reveal answer";
    const answer = document.createElement("div");
    answer.className = "learn-quiz-answer hidden";
    answer.textContent = q.answer || "";
    revealBtn.addEventListener("click", () => {
      answer.classList.toggle("hidden");
      revealBtn.textContent = answer.classList.contains("hidden") ? "Reveal answer" : "Hide answer";
    });
    item.appendChild(revealBtn);
    item.appendChild(answer);
    quizList.appendChild(item);
  });
}

quizEditBtn.addEventListener("click", () => {
  quizEditMode = !quizEditMode;
  renderQuiz();
});

/* ---------------- Map (rendered + raw-text edit) ---------------- */

async function renderMap() {
  mapEditBtn.textContent = mapEditMode ? "Preview map" : "Edit map";
  mapFrame.style.display = mapEditMode ? "none" : "";
  mapEditor.style.display = mapEditMode ? "" : "none";
  mapEditorError.textContent = "";

  if (mapEditMode) {
    mapCode.value = currentItem.mermaid || "mindmap\n  root((Topic))";
    return;
  }

  if (!currentItem.mermaid) {
    mapFrame.innerHTML = '<p class="learn-empty">No map yet.</p>';
    return;
  }
  const id = "learn-map-" + renderCounter++;
  try {
    const { svg } = await mermaid.render(id, currentItem.mermaid);
    mapFrame.innerHTML = svg;
  } catch (err) {
    mapFrame.innerHTML = '<p class="learn-empty">Could not render the map: ' + (err?.message || "unknown error") + "</p>";
  }
}

mapEditBtn.addEventListener("click", async () => {
  mapEditMode = !mapEditMode;
  await renderMap();
});

mapApplyBtn.addEventListener("click", async () => {
  mapEditorError.textContent = "";
  const text = mapCode.value;
  const id = "learn-map-check-" + renderCounter++;
  try {
    await mermaid.render(id, text);
  } catch (err) {
    mapEditorError.textContent = err?.message || "Invalid mermaid syntax.";
    return;
  }
  currentItem.mermaid = text;
  scheduleSave();
  mapEditMode = false;
  await renderMap();
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".learn-tab-body").forEach((body) => body.classList.add("hidden"));
    document.getElementById(`learn-tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

function openHelpPanel() {
  document.getElementById("help-backdrop").classList.add("open");
}

function closeHelpPanel() {
  document.getElementById("help-backdrop").classList.remove("open");
}

document.getElementById("open-help-btn").addEventListener("click", openHelpPanel);
document.getElementById("close-help-btn").addEventListener("click", closeHelpPanel);
document.getElementById("help-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "help-backdrop") closeHelpPanel();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeHelpPanel();
});

loadItems();
loadNoteTabsIntoSelect();
