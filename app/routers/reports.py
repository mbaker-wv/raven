from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, schemas
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


@router.get("/weekly")
def weekly_report(start: date | None = None, end: date | None = None, db: Session = Depends(get_db)):
    return build_digest(db, start, end)
