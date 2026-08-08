import json
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
        return json.loads(text)
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
    db_item = models.LearnItem(title=item.title, source_text=item.source_text)
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
