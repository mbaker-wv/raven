from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/entries", tags=["entries"])


@router.post("", response_model=schemas.EntryOut)
def create_entry(entry: schemas.EntryCreate, db: Session = Depends(get_db)):
    db_entry = models.Entry(**entry.model_dump())
    db.add(db_entry)
    db.commit()
    db.refresh(db_entry)
    return db_entry


@router.get("", response_model=list[schemas.EntryOut])
def list_entries(
    project_id: int | None = None,
    task_id: int | None = None,
    entry_type: str | None = None,
    start: date | None = None,
    end: date | None = None,
    has_reminder: bool | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Entry)
    if project_id is not None:
        query = query.filter(models.Entry.project_id == project_id)
    if task_id is not None:
        query = query.filter(models.Entry.task_id == task_id)
    if entry_type is not None:
        query = query.filter(models.Entry.entry_type == entry_type)
    if start is not None:
        query = query.filter(models.Entry.created_at >= start)
    if end is not None:
        query = query.filter(models.Entry.created_at < end)
    if has_reminder:
        query = query.filter(models.Entry.reminder_date.isnot(None))
    return query.order_by(models.Entry.created_at.desc()).all()


@router.get("/{entry_id}", response_model=schemas.EntryOut)
def get_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.get(models.Entry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    return entry


@router.put("/{entry_id}", response_model=schemas.EntryOut)
def update_entry(entry_id: int, update: schemas.EntryUpdate, db: Session = Depends(get_db)):
    entry = db.get(models.Entry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(entry, key, value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.get(models.Entry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    db.delete(entry)
    db.commit()
