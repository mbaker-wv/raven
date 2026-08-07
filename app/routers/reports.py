from collections import Counter
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/reports", tags=["reports"])


PRIOR_CONTEXT_PER_TASK = 5
STATS_CHART_DAYS = 7
STATS_STREAK_LOOKBACK_DAYS = 60
STATS_TOP_AGENTS_LIMIT = 3


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


def compute_today_stats(db: Session) -> dict:
    """Snapshot for the Today screen: open/due/done counts, a day streak (consecutive
    days with an entry or a completed task, today optional until it's over), and a
    per-day activity count for the last STATS_CHART_DAYS days."""
    today = date.today()
    lookback_start = today - timedelta(days=STATS_STREAK_LOOKBACK_DAYS)

    entry_dates = [
        created_at.date()
        for (created_at,) in db.query(models.Entry.created_at).filter(models.Entry.created_at >= lookback_start).all()
    ]
    completed_dates = [
        completed_at.date()
        for (completed_at,) in db.query(models.Task.completed_at)
        .filter(models.Task.status == "closed", models.Task.completed_at >= lookback_start)
        .all()
        if completed_at is not None
    ]
    activity_counts = Counter(entry_dates) + Counter(completed_dates)

    streak_days = 0
    cursor = today if activity_counts.get(today) else today - timedelta(days=1)
    while activity_counts.get(cursor):
        streak_days += 1
        cursor -= timedelta(days=1)

    chart_start = today - timedelta(days=STATS_CHART_DAYS - 1)
    daily_activity = [
        {"date": (chart_start + timedelta(days=i)).isoformat(), "count": activity_counts.get(chart_start + timedelta(days=i), 0)}
        for i in range(STATS_CHART_DAYS)
    ]

    open_tasks = db.query(models.Task).filter(models.Task.status != "closed").count()

    due_cutoff = today + timedelta(days=6)
    due_this_week = (
        db.query(models.Task)
        .filter(
            models.Task.status != "closed",
            models.Task.due_date.isnot(None),
            models.Task.due_date >= today,
            models.Task.due_date <= due_cutoff,
        )
        .count()
    )

    week_start = today - timedelta(days=6)
    done_this_week = (
        db.query(models.Task)
        .filter(models.Task.status == "closed", models.Task.completed_at >= week_start, models.Task.completed_at < today + timedelta(days=1))
        .count()
    )

    top_agents_rows = (
        db.query(models.Agent.name, func.count(models.AgentRun.id).label("run_count"))
        .join(models.AgentRun, models.AgentRun.agent_id == models.Agent.id)
        .group_by(models.Agent.id)
        .order_by(func.count(models.AgentRun.id).desc())
        .limit(STATS_TOP_AGENTS_LIMIT)
        .all()
    )
    top_agents = [{"name": name, "run_count": run_count} for name, run_count in top_agents_rows]

    return {
        "open_tasks": open_tasks,
        "due_this_week": due_this_week,
        "done_this_week": done_this_week,
        "streak_days": streak_days,
        "daily_activity": daily_activity,
        "top_agents": top_agents,
    }


@router.get("/stats")
def today_stats(db: Session = Depends(get_db)):
    return compute_today_stats(db)
