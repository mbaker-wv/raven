import json
from collections import Counter
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, tools
from ..database import get_db

router = APIRouter(prefix="/api/reports", tags=["reports"])


PRIOR_CONTEXT_PER_TASK = 5
STATS_CHART_DAYS = 7
STATS_STREAK_LOOKBACK_DAYS = 60
STATS_TOP_AGENTS_LIMIT = 3
STATS_TOP_SKILLS_LIMIT = 3


def _parse_tool_calls(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return []


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

    # Agent runs and the skills (tool calls) they made, both bucketed by day over the
    # same STATS_CHART_DAYS window as daily_activity, so the two sparkline lists below
    # can share one query pass instead of re-deriving the window twice.
    chart_runs = (
        db.query(models.AgentRun.created_at, models.AgentRun.tool_calls, models.Agent.name)
        .join(models.Agent, models.Agent.id == models.AgentRun.agent_id)
        .filter(models.AgentRun.created_at >= chart_start)
        .all()
    )

    agent_daily: dict[str, list[int]] = {}
    agent_totals: Counter = Counter()
    skill_daily: dict[str, list[int]] = {}
    skill_totals: Counter = Counter()
    actions_taken_today = 0
    actions_taken_week = 0

    for created_at, tool_calls_raw, agent_name in chart_runs:
        run_date = created_at.date()
        day_idx = (run_date - chart_start).days
        agent_totals[agent_name] += 1
        if 0 <= day_idx < STATS_CHART_DAYS:
            agent_daily.setdefault(agent_name, [0] * STATS_CHART_DAYS)[day_idx] += 1

        for call in _parse_tool_calls(tool_calls_raw):
            tool_name = call.get("tool")
            if not tool_name:
                continue
            skill_totals[tool_name] += 1
            actions_taken_week += 1
            if run_date == today:
                actions_taken_today += 1
            if 0 <= day_idx < STATS_CHART_DAYS:
                skill_daily.setdefault(tool_name, [0] * STATS_CHART_DAYS)[day_idx] += 1

    top_agents = [
        {"name": name, "run_count": count, "daily": agent_daily.get(name, [0] * STATS_CHART_DAYS)}
        for name, count in agent_totals.most_common(STATS_TOP_AGENTS_LIMIT)
    ]
    top_skills = [
        {
            "name": tools.SKILLS.get(tool_name, {}).get("label", tool_name),
            "tool": tool_name,
            "call_count": count,
            "daily": skill_daily.get(tool_name, [0] * STATS_CHART_DAYS),
        }
        for tool_name, count in skill_totals.most_common(STATS_TOP_SKILLS_LIMIT)
    ]

    return {
        "open_tasks": open_tasks,
        "due_this_week": due_this_week,
        "done_this_week": done_this_week,
        "streak_days": streak_days,
        "daily_activity": daily_activity,
        "top_agents": top_agents,
        "top_skills": top_skills,
        "skill_counts": dict(skill_totals),
        "actions_taken_week": actions_taken_week,
        "actions_taken_today": actions_taken_today,
    }


@router.get("/stats")
def today_stats(db: Session = Depends(get_db)):
    return compute_today_stats(db)
