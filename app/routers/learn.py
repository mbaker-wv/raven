import json
import re
import urllib.error
import urllib.request
from datetime import datetime
from html.parser import HTMLParser

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..ai_client import call_ai
from ..database import get_db
from ..net import SSL_CONTEXT

router = APIRouter(prefix="/api/learn", tags=["learn"])

FETCH_TIMEOUT = 15
MAX_FETCH_BYTES = 2 * 1024 * 1024
SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer"}

GENERATE_INSTRUCTIONS = """You are helping someone who struggles with reading and comprehension understand the text below.

Break it down and respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "title": "short title for this material",
  "summary": "1-2 sentence plain-language summary of the whole thing",
  "chunks": [
    {"heading": "short heading", "plain_text": "a few short plain-language sentences explaining this part, avoiding jargon", "key_terms": ["term1", "term2"]}
  ],
  "mermaid": "mindmap\\n  root((Main topic))\\n    Sub idea\\n      Detail",
  "quiz": [
    {"question": "a short question testing understanding of one chunk", "answer": "the answer"}
  ]
}

Rules:
- Break the material into 3-8 chunks, each covering one idea. Keep plain_text short (2-4 sentences) and in plain, everyday language.
- key_terms should be the few words in that chunk worth flagging (can be empty).
- mermaid must be a valid mermaid "mindmap" diagram summarizing how the chunks/ideas relate, using indentation for nesting. Keep node labels short. Do not use parentheses or special characters inside node labels other than basic words.
- quiz should have one question per chunk (3-8 total), testing recall/understanding, not trivia.
- Output nothing but the JSON object.

TEXT:
"""

CHECK_INSTRUCTIONS = """You are checking whether a simplified explanation and quiz stay faithful to their source text.

Important: you are NOT fact-checking the source material against outside knowledge or your own general knowledge. You are only checking whether the chunks and quiz answers below accurately reflect what the SOURCE TEXT actually says. If the source itself is wrong about something, that is not your concern here — only whether the simplification distorted, invented, or contradicted it.

For each chunk and each quiz answer, decide one of:
- "supported": accurately reflects the source, nothing to flag
- "unsupported": adds a specific claim/detail that isn't actually present in the source
- "contradicts": states something that conflicts with what the source says

Respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "overall": "one short sentence overall verdict",
  "chunk_checks": [{"index": 0, "status": "supported", "note": "short reason, empty string if supported"}],
  "quiz_checks": [{"index": 0, "status": "supported", "note": "short reason, empty string if supported"}]
}

Rules:
- Include exactly one chunk_checks entry per chunk below, and one quiz_checks entry per quiz item below, in the same order, using their given index.
- Keep notes under 20 words. Only explain unsupported/contradicts notes; supported notes can be empty strings.
- Output nothing but the JSON object.

SOURCE TEXT:
__SOURCE_TEXT__

CHUNKS:
__CHUNKS_JSON__

QUIZ:
__QUIZ_JSON__
"""

PLAN_INSTRUCTIONS = """You are building a self-study course plan for someone learning a new topic, broken into short, focused micro-lessons.

Respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "title": "short course title for this topic",
  "sections": [
    {
      "title": "short section title",
      "description": "1-2 sentence description of what this section covers",
      "lessons": [
        {"title": "short micro-lesson title", "description": "1 sentence on the single narrow idea this micro-lesson covers"}
      ]
    }
  ]
}

Rules:
- Produce 4-8 sections, ordered from foundational to advanced, that together cover the topic thoroughly.
- Each section should have 3-4 micro-lessons. Each micro-lesson covers exactly ONE narrow idea — something a person could read and understand in about 5-8 minutes. Do not make a micro-lesson broad enough to need its own sub-topics.
- Keep titles short and descriptions concrete about what will be learned.
- Output nothing but the JSON object.

TOPIC:
"""

LESSON_INSTRUCTIONS = """You are writing one short, focused micro-lesson of a self-study course on the topic below.

Respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "content": "the full micro-lesson content, 2-4 short paragraphs in plain language, plain text (no markdown headers)",
  "quiz": [
    {"question": "a short question testing understanding of this micro-lesson", "answer": "the answer"}
  ]
}

Rules:
- Write the content itself (not an outline of it) — teach the one narrow idea directly, in plain language.
- Keep it tight: 2-4 short paragraphs, roughly 150-300 words total, readable in about 5-8 minutes. Do not try to cover the whole section — only this micro-lesson's specific narrow idea.
- Use the section title/description and sibling micro-lesson titles only for context on scope and ordering — don't repeat material that belongs in a sibling micro-lesson.
- quiz should have exactly 2 short questions testing recall/understanding of this micro-lesson's content.
- Output nothing but the JSON object.

TOPIC:
__TOPIC__

SECTION:
__SECTION_JSON__

THIS MICRO-LESSON:
__THIS_LESSON_JSON__
"""

MORE_SECTIONS_INSTRUCTIONS = """You are extending a self-study course plan with more advanced sections, each broken into short, focused micro-lessons.

Respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "sections": [
    {
      "title": "short section title",
      "description": "1-2 sentence description of what this section covers",
      "lessons": [
        {"title": "short micro-lesson title", "description": "1 sentence on the single narrow idea this micro-lesson covers"}
      ]
    }
  ]
}

Rules:
- Produce 2 new sections that go deeper or more advanced on the topic, building on what's already covered.
- Each section should have 3-4 micro-lessons, each covering exactly one narrow idea (5-8 minutes to read).
- Do not repeat or rephrase any section already in the existing section list below.
- Output nothing but the JSON object.

TOPIC:
__TOPIC__

EXISTING SECTION LIST (do not repeat these):
__SECTION_LIST_JSON__
"""

EXPLAIN_SECTION_INSTRUCTIONS = """You are a patient tutor listening to a student explain a section of a course back to you in their own words, the way they might explain it to a friend.

Respond with ONLY a single JSON object (no prose, no markdown code fences) shaped exactly like this:
{
  "feedback": "a few sentences: what they got right, what's missing or inaccurate, in an encouraging, specific, teacher-like tone"
}

Rules:
- Judge the explanation against the section content below, not against outside knowledge.
- Be specific about any gaps or inaccuracies, but stay encouraging.
- Keep it to 3-5 sentences.
- Output nothing but the JSON object.

SECTION CONTENT:
__SECTION_CONTENT__

STUDENT'S EXPLANATION:
__EXPLANATION__
"""


def _extract_json(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start : end + 1]
    try:
        return json.loads(text, strict=False)
    except (TypeError, ValueError):
        pass
    # Common LLM JSON slip: a trailing comma before a closing bracket/brace.
    repaired = re.sub(r",(\s*[}\]])", r"\1", text)
    try:
        return json.loads(repaired, strict=False)
    except (TypeError, ValueError):
        raise HTTPException(502, "Could not parse the AI's response — try again.")


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks: list[str] = []
        self.title_chunks: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title_chunks.append(data)
            return
        if self._skip_depth:
            return
        stripped = data.strip()
        if stripped:
            self.chunks.append(stripped)


def _fetch_url_text(url: str) -> tuple[str, str]:
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "URL must start with http:// or https://")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; RavenLearn/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT, context=SSL_CONTEXT) as resp:
            raw = resp.read(MAX_FETCH_BYTES)
    except urllib.error.HTTPError as exc:
        raise HTTPException(400, f"Could not fetch that URL ({exc.code}).")
    except urllib.error.URLError as exc:
        raise HTTPException(400, f"Could not reach that URL: {getattr(exc, 'reason', exc)}")

    charset = "utf-8"
    content_type = resp.headers.get_content_charset()
    if content_type:
        charset = content_type
    html_text = raw.decode(charset, errors="replace")

    parser = _TextExtractor()
    parser.feed(html_text)
    text = "\n\n".join(parser.chunks).strip()
    if not text:
        raise HTTPException(400, "Couldn't find any readable text on that page.")
    title = " ".join("".join(parser.title_chunks).split()).strip() or url
    return title, text


@router.get("", response_model=list[schemas.LearnItemOut])
def list_learn_items(db: Session = Depends(get_db)):
    return db.query(models.LearnItem).order_by(models.LearnItem.updated_at.desc()).all()


@router.post("", response_model=schemas.LearnItemOut)
def create_learn_item(item: schemas.LearnItemCreate, db: Session = Depends(get_db)):
    db_item = models.LearnItem(title=item.title, source_text=item.source_text, mode=item.mode, topic=item.topic)
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item


@router.get("/{item_id}", response_model=schemas.LearnItemOut)
def get_learn_item(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    return item


@router.put("/{item_id}", response_model=schemas.LearnItemOut)
def update_learn_item(item_id: int, update: schemas.LearnItemUpdate, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    updates = update.model_dump(exclude_unset=True)
    if "chunks" in updates:
        updates["chunks"] = json.dumps(updates["chunks"])
        if updates["chunks"] != item.chunks:
            item.checks = None
            item.checked_at = None
    if "quiz" in updates:
        updates["quiz"] = json.dumps(updates["quiz"])
        if updates["quiz"] != item.quiz:
            item.checks = None
            item.checked_at = None
    if "plan" in updates:
        updates["plan"] = json.dumps(updates["plan"])
    for key, value in updates.items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
def delete_learn_item(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    db.delete(item)
    db.commit()


@router.post("/{item_id}/import-url", response_model=schemas.LearnItemOut)
def import_url(item_id: int, body: schemas.LearnImportUrl, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "reading":
        raise HTTPException(400, "Import URL is only available for reading comprehension items.")
    title, text = _fetch_url_text(body.url.strip())
    item.source_text = text
    if not item.title or item.title == "Untitled":
        item.title = title
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/generate", response_model=schemas.LearnItemOut)
def generate_learn_item(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "reading":
        raise HTTPException(400, "Generate is only available for reading comprehension items.")
    if not item.source_text.strip():
        raise HTTPException(400, "Add some text first.")

    prompt = GENERATE_INSTRUCTIONS + item.source_text
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    if data.get("title"):
        item.title = data["title"]
    item.summary = data.get("summary")
    item.chunks = json.dumps(data.get("chunks", []))
    item.mermaid = data.get("mermaid")
    item.quiz = json.dumps(data.get("quiz", []))
    item.checks = None
    item.checked_at = None
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/check", response_model=schemas.LearnItemOut)
def check_learn_item(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "reading":
        raise HTTPException(400, "Check accuracy is only available for reading comprehension items.")
    if not item.source_text.strip():
        raise HTTPException(400, "Add some text first.")
    chunks = json.loads(item.chunks) if item.chunks else []
    quiz = json.loads(item.quiz) if item.quiz else []
    if not chunks and not quiz:
        raise HTTPException(400, "Generate an outline first.")

    chunks_payload = [
        {"index": i, "heading": c.get("heading", ""), "plain_text": c.get("plain_text", "")} for i, c in enumerate(chunks)
    ]
    quiz_payload = [{"index": i, "question": q.get("question", ""), "answer": q.get("answer", "")} for i, q in enumerate(quiz)]

    prompt = (
        CHECK_INSTRUCTIONS.replace("__SOURCE_TEXT__", item.source_text)
        .replace("__CHUNKS_JSON__", json.dumps(chunks_payload, indent=2))
        .replace("__QUIZ_JSON__", json.dumps(quiz_payload, indent=2))
    )
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    item.checks = json.dumps(data)
    item.checked_at = datetime.now()
    db.commit()
    db.refresh(item)
    return item


def _sanitize_mermaid_label(text: str) -> str:
    return " ".join((text or "").replace("(", "").replace(")", "").split())


def _render_course_mermaid(topic: str, plan: list) -> str:
    lines = ["mindmap", f"  root(({_sanitize_mermaid_label(topic) or 'Course'}))"]
    for section in plan:
        lines.append(f"    {_sanitize_mermaid_label(section.get('title', ''))}")
        for lesson in section.get("lessons", []):
            lines.append(f"      {_sanitize_mermaid_label(lesson.get('title', ''))}")
    return "\n".join(lines)


@router.post("/{item_id}/build-plan", response_model=schemas.LearnItemOut)
def build_plan(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "topic":
        raise HTTPException(400, "Build plan is only available for custom topic items.")
    if not (item.topic or "").strip():
        raise HTTPException(400, "Add a topic first.")

    prompt = PLAN_INSTRUCTIONS + item.topic
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    if data.get("title"):
        item.title = data["title"]
    sections = [
        {
            "title": section.get("title", ""),
            "description": section.get("description", ""),
            "teach_back_text": None,
            "teach_back_feedback": None,
            "lessons": [
                {
                    "title": lesson.get("title", ""),
                    "description": lesson.get("description", ""),
                    "content": None,
                    "quiz": [],
                    "completed": False,
                }
                for lesson in section.get("lessons", [])
            ],
        }
        for section in data.get("sections", [])
    ]
    item.plan = json.dumps(sections)
    item.mermaid = _render_course_mermaid(item.topic, sections)
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/generate-lesson", response_model=schemas.LearnItemOut)
def generate_lesson(item_id: int, body: schemas.LearnGenerateLesson, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "topic":
        raise HTTPException(400, "Generate lesson is only available for custom topic items.")
    plan = json.loads(item.plan) if item.plan else []
    if not (0 <= body.section_index < len(plan)):
        raise HTTPException(400, "Invalid section index.")
    section = plan[body.section_index]
    lessons = section.get("lessons", [])
    if not (0 <= body.lesson_index < len(lessons)):
        raise HTTPException(400, "Invalid lesson index.")

    section_payload = {"title": section.get("title", ""), "description": section.get("description", "")}
    this_lesson = lessons[body.lesson_index]

    prompt = (
        LESSON_INSTRUCTIONS.replace("__TOPIC__", item.topic or "")
        .replace("__SECTION_JSON__", json.dumps(section_payload, indent=2))
        .replace(
            "__THIS_LESSON_JSON__",
            json.dumps({"title": this_lesson.get("title", ""), "description": this_lesson.get("description", "")}, indent=2),
        )
    )
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    lessons[body.lesson_index]["content"] = data.get("content", "")
    lessons[body.lesson_index]["quiz"] = data.get("quiz", [])
    item.plan = json.dumps(plan)
    item.mermaid = _render_course_mermaid(item.topic, plan)
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/add-sections", response_model=schemas.LearnItemOut)
def add_sections(item_id: int, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "topic":
        raise HTTPException(400, "Add more sections is only available for custom topic items.")
    plan = json.loads(item.plan) if item.plan else []
    if not plan:
        raise HTTPException(400, "Build a plan first.")

    section_list_payload = [{"title": s.get("title", ""), "description": s.get("description", "")} for s in plan]
    prompt = MORE_SECTIONS_INSTRUCTIONS.replace("__TOPIC__", item.topic or "").replace(
        "__SECTION_LIST_JSON__", json.dumps(section_list_payload, indent=2)
    )
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    new_sections = [
        {
            "title": section.get("title", ""),
            "description": section.get("description", ""),
            "teach_back_text": None,
            "teach_back_feedback": None,
            "lessons": [
                {
                    "title": lesson.get("title", ""),
                    "description": lesson.get("description", ""),
                    "content": None,
                    "quiz": [],
                    "completed": False,
                }
                for lesson in section.get("lessons", [])
            ],
        }
        for section in data.get("sections", [])
    ]
    plan.extend(new_sections)
    item.plan = json.dumps(plan)
    item.mermaid = _render_course_mermaid(item.topic, plan)
    db.commit()
    db.refresh(item)
    return item


@router.post("/{item_id}/explain-section", response_model=schemas.LearnItemOut)
def explain_section(item_id: int, body: schemas.LearnExplainSection, db: Session = Depends(get_db)):
    item = db.get(models.LearnItem, item_id)
    if not item:
        raise HTTPException(404, "Learn item not found")
    if item.mode != "topic":
        raise HTTPException(400, "Explain section is only available for custom topic items.")
    plan = json.loads(item.plan) if item.plan else []
    if not (0 <= body.section_index < len(plan)):
        raise HTTPException(400, "Invalid section index.")
    section = plan[body.section_index]
    generated_content = [l["content"] for l in section.get("lessons", []) if l.get("content")]
    if not generated_content:
        raise HTTPException(400, "Generate at least one lesson in this section first.")
    if not body.explanation.strip():
        raise HTTPException(400, "Write an explanation first.")

    prompt = EXPLAIN_SECTION_INSTRUCTIONS.replace("__SECTION_CONTENT__", "\n\n".join(generated_content)).replace(
        "__EXPLANATION__", body.explanation
    )
    raw = call_ai(prompt, db)
    data = _extract_json(raw)

    plan[body.section_index]["teach_back_text"] = body.explanation
    plan[body.section_index]["teach_back_feedback"] = data.get("feedback", "")
    item.plan = json.dumps(plan)
    db.commit()
    db.refresh(item)
    return item
