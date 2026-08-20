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
let generatingLesson = false;
let addingSections = false;
let speaking = false;
let renderCounter = 0;
let quizEditMode = false;
let mapEditMode = false;
let lastSavedSnapshot = null;
let checksStale = false;
let checking = false;
let currentSectionIndex = null;
let currentLessonIndex = null;
let explainingSection = false;

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
const checkBar = document.getElementById("learn-check-bar");
const modeToggle = document.getElementById("learn-mode-toggle");
const readingInputs = document.getElementById("learn-reading-inputs");
const topicInputs = document.getElementById("learn-topic-inputs");
const topicInput = document.getElementById("learn-topic-input");
const buildPlanBtn = document.getElementById("learn-build-plan-btn");
const readingTabs = document.getElementById("learn-reading-tabs");
const topicTabs = document.getElementById("learn-topic-tabs");
const planList = document.getElementById("learn-plan-list");
const lessonBody = document.getElementById("learn-lesson-body");

function setError(msg) {
  errorEl.textContent = msg || "";
}

function setSaveStatus(text) {
  saveStatus.textContent = text;
}

function hasOutput() {
  if (!currentItem) return false;
  if (currentItem.mode === "topic") return !!currentItem.plan?.length;
  return !!(currentItem.chunks?.length || currentItem.mermaid || currentItem.quiz?.length);
}

function isEmptyItem(item) {
  if (!item) return true;
  return (
    !(item.source_text || "").trim() &&
    !(item.topic || "").trim() &&
    !item.chunks?.length &&
    !item.mermaid &&
    !item.quiz?.length &&
    !item.plan?.length
  );
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
  stopSpeaking();
  quizEditMode = false;
  mapEditMode = false;
  checksStale = false;
  currentSectionIndex = null;
  currentLessonIndex = null;
  outputPanel.classList.remove("checks-stale");
  titleInput.value = currentItem.title || "";
  sourceText.value = currentItem.source_text || "";
  topicInput.value = currentItem.topic || "";
  lastSavedSnapshot = snapshotOf(currentItem);
  renderSourcePanel();
  ensureValidActiveTab();
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
    mode: item.mode || "reading",
    topic: item.topic || null,
    plan: item.plan || [],
  });
}

function renderSourcePanel() {
  const mode = currentItem?.mode || "reading";
  const empty = isEmptyItem(currentItem);
  modeToggle.style.display = empty ? "" : "none";
  modeToggle.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  readingInputs.style.display = mode === "topic" ? "none" : "";
  topicInputs.style.display = mode === "topic" ? "" : "none";
  readingTabs.style.display = mode === "topic" ? "none" : "";
  topicTabs.style.display = mode === "topic" ? "" : "none";
  checkBar.style.display = mode === "topic" ? "none" : "";
  summaryEl.style.display = mode === "topic" ? "none" : "";
}

function activateTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".learn-tab-body").forEach((body) => body.classList.add("hidden"));
  document.getElementById(`learn-tab-${tabName}`)?.classList.remove("hidden");
}

function ensureValidActiveTab() {
  const mode = currentItem?.mode || "reading";
  const validTabs = mode === "topic" ? ["plan", "lesson", "map"] : ["outline", "map", "quiz"];
  const activeBtn = document.querySelector(".tab-btn.active");
  if (!activeBtn || !validTabs.includes(activeBtn.dataset.tab)) {
    activateTab(validTabs[0]);
  }
}

modeToggle.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!currentItem || currentItem.mode === btn.dataset.mode) return;
    currentItem.mode = btn.dataset.mode;
    renderSourcePanel();
    ensureValidActiveTab();
    await renderOutput();
    await flushSave();
  });
});

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
  currentItem.topic = topicInput.value;
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
        mode: currentItem.mode || "reading",
        topic: currentItem.topic ?? null,
        plan: currentItem.plan || [],
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
topicInput.addEventListener("input", scheduleSave);
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
  if (!currentItem || generating || currentItem.mode !== "reading") return;
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
  if (currentItem?.mode === "topic") {
    buildPlanBtn.textContent = hasOutput() ? "Rebuild plan" : "Build plan";
    if (!hasOutput()) return;
    renderPlan();
    renderLesson();
    await renderMap();
    return;
  }
  generateBtn.textContent = hasOutput() ? "Regenerate" : "Generate";
  if (!hasOutput()) return;

  summaryEl.textContent = currentItem.summary || "";
  updateCheckBar();
  renderOutline();
  renderQuiz();
  await renderMap();
}

buildPlanBtn.addEventListener("click", async () => {
  if (!currentItem || generating || currentItem.mode !== "topic") return;
  if (hasOutput() && !confirm("This will replace the current plan. Any lessons you've already generated will be lost. Continue?")) return;
  await flushSave();
  if (!topicInput.value.trim()) {
    setError("Add a topic first.");
    return;
  }
  generating = true;
  setError("");
  buildPlanBtn.disabled = true;
  buildPlanBtn.textContent = "Building…";
  try {
    const updated = await api(`/learn/${currentItem.id}/build-plan`, { method: "POST" });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
    titleInput.value = currentItem.title || "";
    currentSectionIndex = null;
    currentLessonIndex = null;
    renderItemsRow();
    renderSourcePanel();
    ensureValidActiveTab();
    await renderOutput();
  } catch (err) {
    setError(err.message);
  } finally {
    generating = false;
    buildPlanBtn.disabled = false;
    buildPlanBtn.textContent = hasOutput() ? "Rebuild plan" : "Build plan";
  }
});

/* ---------------- Plan + Lesson (custom topic mode) ---------------- */

function renderPlan() {
  planList.innerHTML = "";
  const plan = currentItem.plan || [];
  if (!plan.length) {
    planList.innerHTML = '<p class="learn-empty">No plan yet.</p>';
    return;
  }
  plan.forEach((section, sIdx) => {
    const lessons = section.lessons || [];
    const doneCount = lessons.filter((l) => l.completed).length;
    const allGenerated = lessons.length > 0 && lessons.every((l) => l.content);

    const card = document.createElement("div");
    card.className = "learn-chunk";

    const headerRow = document.createElement("div");
    headerRow.className = "learn-plan-row";
    const sectionTitle = document.createElement("span");
    sectionTitle.className = "learn-plan-title";
    sectionTitle.textContent = `${sIdx + 1}. ${section.title || ""}`;
    const progressBadge = document.createElement("span");
    progressBadge.className = "learn-check-badge " + (doneCount === lessons.length && lessons.length ? "generated" : "not-started");
    progressBadge.textContent = `${doneCount}/${lessons.length} done`;
    headerRow.appendChild(sectionTitle);
    headerRow.appendChild(progressBadge);
    card.appendChild(headerRow);

    const sectionDesc = document.createElement("p");
    sectionDesc.textContent = section.description || "";
    card.appendChild(sectionDesc);

    const lessonsList = document.createElement("div");
    lessonsList.style.marginLeft = "16px";
    lessons.forEach((lesson, lIdx) => {
      const row = document.createElement("div");
      row.className = "learn-plan-row";
      row.style.marginBottom = "6px";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!lesson.completed;
      checkbox.addEventListener("change", () => {
        currentItem.plan[sIdx].lessons[lIdx].completed = checkbox.checked;
        scheduleSave();
      });
      const lessonTitle = document.createElement("span");
      lessonTitle.className = "learn-plan-title";
      lessonTitle.textContent = `${sIdx + 1}.${lIdx + 1} ${lesson.title || ""}`;
      const statusBadge = document.createElement("span");
      statusBadge.className = "learn-check-badge " + (lesson.content ? "generated" : "not-started");
      statusBadge.textContent = lesson.content ? "Generated" : "Not started";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "secondary";
      openBtn.textContent = lesson.content ? "Open" : "Open & generate";
      openBtn.addEventListener("click", () => {
        currentSectionIndex = sIdx;
        currentLessonIndex = lIdx;
        activateTab("lesson");
        renderLesson();
      });
      row.appendChild(checkbox);
      row.appendChild(lessonTitle);
      row.appendChild(statusBadge);
      row.appendChild(openBtn);
      lessonsList.appendChild(row);
    });
    card.appendChild(lessonsList);

    if (allGenerated) {
      renderSectionExplain(card, sIdx, section);
    }

    planList.appendChild(card);
  });

  const addSectionsBtn = document.createElement("button");
  addSectionsBtn.type = "button";
  addSectionsBtn.className = "secondary";
  addSectionsBtn.disabled = addingSections;
  addSectionsBtn.textContent = addingSections ? "Adding…" : "Add more sections";
  addSectionsBtn.addEventListener("click", addMoreSections);
  planList.appendChild(addSectionsBtn);
}

function renderSectionExplain(card, sectionIndex, section) {
  const heading = document.createElement("h3");
  heading.textContent = "Explain this section in your own words";
  heading.style.marginTop = "16px";
  card.appendChild(heading);

  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = "Pretend you're teaching this to a friend or your spouse.";
  card.appendChild(sub);

  const input = document.createElement("textarea");
  input.value = section.teach_back_text || "";
  input.placeholder = "Explain this section as if you were teaching it to someone else...";
  input.style.minHeight = "100px";
  input.addEventListener("input", () => {
    currentItem.plan[sectionIndex].teach_back_text = input.value;
    scheduleSave();
  });
  card.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";
  btn.style.marginTop = "8px";
  btn.disabled = explainingSection;
  btn.textContent = explainingSection ? "Getting feedback…" : "Get feedback";
  btn.addEventListener("click", () => explainSection(sectionIndex));
  card.appendChild(btn);

  if (section.teach_back_feedback) {
    const feedback = document.createElement("div");
    feedback.className = "learn-check-note";
    feedback.style.marginTop = "10px";
    feedback.textContent = section.teach_back_feedback;
    card.appendChild(feedback);
  }
}

async function explainSection(sectionIndex) {
  if (!currentItem || explainingSection) return;
  const explanation = (currentItem.plan[sectionIndex].teach_back_text || "").trim();
  if (!explanation) {
    setError("Write an explanation first.");
    return;
  }
  explainingSection = true;
  setError("");
  renderPlan();
  try {
    const updated = await api(`/learn/${currentItem.id}/explain-section`, {
      method: "POST",
      body: JSON.stringify({ section_index: sectionIndex, explanation }),
    });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const listIdx = items.findIndex((i) => i.id === currentItem.id);
    if (listIdx !== -1) items[listIdx] = currentItem;
  } catch (err) {
    setError(err.message);
  } finally {
    explainingSection = false;
    renderPlan();
  }
}

async function addMoreSections() {
  if (!currentItem || addingSections) return;
  addingSections = true;
  setError("");
  renderPlan();
  try {
    const updated = await api(`/learn/${currentItem.id}/add-sections`, { method: "POST" });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const idx = items.findIndex((i) => i.id === currentItem.id);
    if (idx !== -1) items[idx] = currentItem;
  } catch (err) {
    setError(err.message);
  } finally {
    addingSections = false;
    renderPlan();
  }
}

function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  speaking = false;
}

function toggleReadAloud(text, btn) {
  if (!("speechSynthesis" in window)) return;
  if (speaking) {
    stopSpeaking();
    btn.textContent = "Read aloud";
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.onend = () => {
    speaking = false;
    btn.textContent = "Read aloud";
  };
  utterance.onerror = () => {
    speaking = false;
    btn.textContent = "Read aloud";
  };
  speaking = true;
  btn.textContent = "Stop reading";
  window.speechSynthesis.speak(utterance);
}

function renderLesson() {
  stopSpeaking();
  lessonBody.innerHTML = "";
  const plan = currentItem.plan || [];
  const section = currentSectionIndex !== null ? plan[currentSectionIndex] : null;
  const lesson = section && currentLessonIndex !== null ? (section.lessons || [])[currentLessonIndex] : null;
  if (!lesson) {
    lessonBody.innerHTML = '<p class="learn-empty">Open a lesson from the Plan tab.</p>';
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = `${currentSectionIndex + 1}.${currentLessonIndex + 1} ${lesson.title || ""}`;
  lessonBody.appendChild(heading);
  const desc = document.createElement("p");
  desc.className = "sub";
  desc.textContent = lesson.description || "";
  lessonBody.appendChild(desc);

  if (!lesson.content) {
    const genBtn = document.createElement("button");
    genBtn.type = "button";
    genBtn.className = "btn-primary";
    genBtn.disabled = generatingLesson;
    genBtn.textContent = generatingLesson ? "Generating…" : "Generate lesson";
    genBtn.addEventListener("click", () => generateLesson(currentSectionIndex, currentLessonIndex));
    lessonBody.appendChild(genBtn);
    return;
  }

  if ("speechSynthesis" in window) {
    const readBtn = document.createElement("button");
    readBtn.type = "button";
    readBtn.className = "secondary";
    readBtn.textContent = "Read aloud";
    readBtn.addEventListener("click", () => toggleReadAloud(lesson.content, readBtn));
    lessonBody.appendChild(readBtn);
  }

  const content = document.createElement("div");
  (lesson.content || "").split(/\n\n+/).forEach((para) => {
    const p = document.createElement("p");
    p.textContent = para;
    content.appendChild(p);
  });
  lessonBody.appendChild(content);

  const regenBtn = document.createElement("button");
  regenBtn.type = "button";
  regenBtn.className = "secondary";
  regenBtn.disabled = generatingLesson;
  regenBtn.textContent = generatingLesson ? "Generating…" : "Regenerate lesson";
  regenBtn.addEventListener("click", () => {
    if (!confirm("This will replace this lesson's content and quiz. Continue?")) return;
    generateLesson(currentSectionIndex, currentLessonIndex);
  });
  lessonBody.appendChild(regenBtn);

  const quizHeading = document.createElement("h3");
  quizHeading.textContent = "Quiz";
  quizHeading.style.marginTop = "20px";
  lessonBody.appendChild(quizHeading);

  renderLessonQuiz(lesson.quiz || []);
}

function renderLessonQuiz(quiz) {
  const container = document.createElement("div");
  if (!quiz.length) {
    container.innerHTML = '<p class="learn-empty">No quiz yet.</p>';
  } else {
    quiz.forEach((q, idx) => {
      const item = document.createElement("div");
      item.className = "learn-quiz-item";
      const question = document.createElement("div");
      question.className = "learn-quiz-question";
      question.textContent = `${idx + 1}. ${q.question || ""}`;
      item.appendChild(question);
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
      container.appendChild(item);
    });
  }
  lessonBody.appendChild(container);
}

async function generateLesson(sectionIdx, lessonIdx) {
  if (!currentItem || generatingLesson) return;
  generatingLesson = true;
  setError("");
  renderLesson();
  try {
    const updated = await api(`/learn/${currentItem.id}/generate-lesson`, {
      method: "POST",
      body: JSON.stringify({ section_index: sectionIdx, lesson_index: lessonIdx }),
    });
    Object.assign(currentItem, updated);
    lastSavedSnapshot = snapshotOf(currentItem);
    const listIdx = items.findIndex((i) => i.id === currentItem.id);
    if (listIdx !== -1) items[listIdx] = currentItem;
    renderPlan();
  } catch (err) {
    setError(err.message);
  } finally {
    generatingLesson = false;
    renderLesson();
  }
}

checkBtn.addEventListener("click", async () => {
  if (!currentItem || checking || currentItem.mode !== "reading") return;
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
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
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
