from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
from ..ai_client import call_ai
from ..database import get_db

router = APIRouter(prefix="/api/reports", tags=["reports"])


PRIOR_CONTEXT_PER_TASK = 5


def _bucket(db: Session, start: date, end: date) -> dict:
    entries = (
        db.query(models.Entry)
        .filter(models.Entry.created_at >= start, models.Entry.created_at < end)
        .order_by(models.Entry.created_at)
        .all()
    )
    completed = (
        db.query(models.Task)
        .filter(models.Task.status == "closed", models.Task.completed_at >= start, models.Task.completed_at < end)
        .order_by(models.Task.completed_at)
        .all()
    )
    open_tasks = (
        db.query(models.Task)
        .filter(models.Task.status != "closed")
        .order_by(models.Task.due_date.is_(None), models.Task.due_date)
        .all()
    )

    referenced_task_ids = {e.task_id for e in entries if e.task_id} | {t.id for t in completed} | {t.id for t in open_tasks}

    prior_context = []
    if referenced_task_ids:
        prior_entries = (
            db.query(models.Entry)
            .filter(models.Entry.task_id.in_(referenced_task_ids), models.Entry.created_at < start)
            .order_by(models.Entry.task_id, models.Entry.created_at.desc())
            .all()
        )
        counts: dict[int, int] = {}
        capped = []
        for e in prior_entries:
            if counts.get(e.task_id, 0) < PRIOR_CONTEXT_PER_TASK:
                capped.append(e)
                counts[e.task_id] = counts.get(e.task_id, 0) + 1
        prior_context = sorted(capped, key=lambda e: e.created_at)

    return {
        "entries": [
            {**schemas.EntryOut.model_validate(e).model_dump(mode="json"), "task_title": e.task.title if e.task else None}
            for e in entries
        ],
        "completed_tasks": [schemas.TaskOut.model_validate(t).model_dump(mode="json") for t in completed],
        "open_tasks": [schemas.TaskOut.model_validate(t).model_dump(mode="json") for t in open_tasks],
        "blockers": [schemas.EntryOut.model_validate(e).model_dump(mode="json") for e in entries if e.entry_type == "blocker"],
        "prior_context": [
            {**schemas.EntryOut.model_validate(e).model_dump(mode="json"), "task_title": e.task.title if e.task else None}
            for e in prior_context
        ],
    }


def build_digest(db: Session, start: date | None, end: date | None) -> dict:
    """Digest of all entries + tasks in [start, end], pooled across projects. end is inclusive."""
    if end is None:
        end = date.today()
    if start is None:
        start = end - timedelta(days=6)
    end_exclusive = end + timedelta(days=1)

    bucket = _bucket(db, start, end_exclusive)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        **bucket,
    }


def digest_to_text(digest: dict) -> str:
    lines = [f"Activity log: {digest['start']} to {digest['end']}", ""]
    if digest["entries"]:
        lines.append("Entries:")
        for e in digest["entries"]:
            line = f"- [{e['entry_type']}] {e['content']}"
            if e["entry_type"] == "note" and e.get("task_title"):
                line += f" — task: {e['task_title']}"
            lines.append(line)
    if digest["completed_tasks"]:
        lines.append("Completed tasks:")
        lines += [f"- {t['title']}" for t in digest["completed_tasks"]]
    if digest["open_tasks"]:
        lines.append("Still open:")
        for t in digest["open_tasks"]:
            due = f" (due {t['due_date']})" if t["due_date"] else ""
            lines.append(f"- [{t['status']}] {t['title']}{due}")
    if digest.get("prior_context"):
        lines.append("")
        lines.append("Earlier context on tasks referenced above (from before this period, background only):")
        for e in digest["prior_context"]:
            when = e["created_at"][:10]
            task_ref = f"[{e['task_title']}] " if e.get("task_title") else ""
            lines.append(f"- {when} {task_ref}{e['content']}")
    return "\n".join(lines)


def build_prompt(digest: dict, settings: "models.Settings | None" = None) -> str:
    name = settings.profile_name if settings else None
    role = settings.profile_role if settings else None
    header = [
        "You are writing a concise, director-ready weekly status report from the raw activity log below.",
        f"Reporting period: {digest['start']} to {digest['end']}.",
    ]
    if name or role:
        byline = f"{name}, {role}" if name and role else (name or role)
        header.append(
            f"Start the report with a byline on its own line reading exactly 'Prepared by: {byline}', "
            "followed by the reporting period on the next line, before any section headers."
        )
    header += [
        "Write a 'What Was Done' section as a bulleted list (one bullet per item of work, not a paragraph).",
        "Then write a separate 'Blockers' section as a bulleted list of anything currently blocked or waiting on someone else. "
        "If there are no blockers, write a single bullet saying so.",
        "Then write a separate 'Next Week' section as a bulleted list of planned or upcoming work.",
        "Keep each bullet to one concise sentence. Be direct and factual. Do not invent information that isn't in the log.",
        "If an 'Earlier context' section is present, use it only as background to understand a task's history — "
        "do not describe it as work done during this reporting period.",
        "",
    ]
    return "\n".join(header) + "\n" + digest_to_text(digest)


@router.get("/weekly")
def weekly_report(start: date | None = None, end: date | None = None, db: Session = Depends(get_db)):
    return build_digest(db, start, end)


@router.post("/weekly/polish")
def polish_weekly_report(start: date | None = None, end: date | None = None, db: Session = Depends(get_db)):
    digest = build_digest(db, start, end)
    settings = db.query(models.Settings).first()
    prompt = build_prompt(digest, settings)
    if settings and settings.profile_context:
        prompt = f"Context about the user writing this report: {settings.profile_context}\n\n{prompt}"
    polished = call_ai(prompt, db)
    return {"digest": digest, "polished": polished}
