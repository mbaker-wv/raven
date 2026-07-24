import calendar
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

ARCHIVE_AFTER_DAYS = 7


def sweep_archive_stale_tasks(db: Session) -> int:
    cutoff = datetime.now() - timedelta(days=ARCHIVE_AFTER_DAYS)
    stale = (
        db.query(models.Task)
        .filter(models.Task.status == "closed")
        .filter(models.Task.archived.is_(False))
        .filter(models.Task.completed_at.isnot(None))
        .filter(models.Task.completed_at <= cutoff)
        .all()
    )
    for task in stale:
        task.archived = True
        task.archived_at = datetime.now()
    if stale:
        db.commit()
    return len(stale)


def _advance_date(d: date, recurrence: str) -> date:
    if recurrence == "daily":
        return d + timedelta(days=1)
    if recurrence == "weekly":
        return d + timedelta(days=7)
    if recurrence == "monthly":
        month = d.month + 1
        year = d.year + (1 if month > 12 else 0)
        month = month if month <= 12 else 1
        last_day = calendar.monthrange(year, month)[1]
        return date(year, month, min(d.day, last_day))
    return d


def _parse_recurrence_days(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [d.strip() for d in raw.split(",") if d.strip()]


def _next_weekly_date(after: date, selected_days: list[str]) -> date:
    for offset in range(1, 8):
        candidate = after + timedelta(days=offset)
        if candidate.strftime("%A") in selected_days:
            return candidate
    return after + timedelta(days=7)


def _next_monthly_date(after: date, selected_days: list[int]) -> date:
    year, month = after.year, after.month
    for _ in range(24):
        last_day = calendar.monthrange(year, month)[1]
        candidates = sorted({min(day, last_day) for day in selected_days})
        for day in candidates:
            candidate = date(year, month, day)
            if candidate > after:
                return candidate
        month += 1
        if month > 12:
            month = 1
            year += 1
    return after


def _create_next_occurrence(db: Session, task: models.Task) -> None:
    base_date = task.due_date or date.today()
    selected_days = _parse_recurrence_days(task.recurrence_day)
    if task.recurrence == "weekly" and selected_days:
        next_due = _next_weekly_date(base_date, selected_days)
    elif task.recurrence == "monthly" and selected_days:
        next_due = _next_monthly_date(base_date, [int(day) for day in selected_days])
    else:
        next_due = _advance_date(base_date, task.recurrence)
    next_task = models.Task(
        title=task.title,
        status="new",
        due_date=next_due,
        project_id=task.project_id,
        recurrence=task.recurrence,
        recurrence_day=task.recurrence_day,
        tags=task.tags,
    )
    db.add(next_task)


@router.post("", response_model=schemas.TaskOut)
def create_task(task: schemas.TaskCreate, db: Session = Depends(get_db)):
    db_task = models.Task(**task.model_dump())
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task


@router.get("", response_model=list[schemas.TaskOut])
def list_tasks(
    project_id: int | None = None,
    status: str | None = None,
    due_before: date | None = None,
    archived: bool = False,
    q: str | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Task).filter(models.Task.archived.is_(archived))
    if project_id is not None:
        query = query.filter(models.Task.project_id == project_id)
    if status is not None:
        query = query.filter(models.Task.status == status)
    if due_before is not None:
        query = query.filter(models.Task.due_date <= due_before)
    if q:
        like = f"%{q}%"
        query = query.filter(
            models.Task.title.ilike(like) | models.Task.tags.ilike(like)
        )
    return query.order_by(models.Task.created_at.desc(), models.Task.id.desc()).all()


@router.get("/tags")
def list_task_tags(db: Session = Depends(get_db)):
    tags = set()
    for (raw,) in db.query(models.Task.tags).filter(models.Task.tags.isnot(None)).all():
        for tag in raw.split(","):
            tag = tag.strip()
            if tag:
                tags.add(tag)
    return {"tags": sorted(tags)}


@router.get("/{task_id}", response_model=schemas.TaskOut)
def get_task(task_id: int, db: Session = Depends(get_db)):
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task


@router.put("/{task_id}", response_model=schemas.TaskOut)
def update_task(task_id: int, update: schemas.TaskUpdate, db: Session = Depends(get_db)):
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    changes = update.model_dump(exclude_unset=True)
    if changes.get("status") == "closed" and task.status != "closed" and "completed_at" not in changes:
        task.completed_at = datetime.now()
        if task.recurrence != "none":
            _create_next_occurrence(db, task)
    elif "status" in changes and changes["status"] != "closed" and task.status == "closed" and "completed_at" not in changes:
        task.completed_at = None
    for key, value in changes.items():
        setattr(task, key, value)
    db.commit()
    db.refresh(task)
    return task


@router.put("/{task_id}/restore", response_model=schemas.TaskOut)
def restore_task(task_id: int, db: Session = Depends(get_db)):
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    task.archived = False
    task.archived_at = None
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    db.delete(task)
    db.commit()
