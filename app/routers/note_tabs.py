from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/note-tabs", tags=["note-tabs"])


@router.get("", response_model=list[schemas.NoteTabOut])
def list_note_tabs(db: Session = Depends(get_db)):
    return db.query(models.NoteTab).order_by(models.NoteTab.id).all()


@router.put("/{tab_id}", response_model=schemas.NoteTabOut)
def update_note_tab(tab_id: int, update: schemas.NoteTabUpdate, db: Session = Depends(get_db)):
    tab = db.get(models.NoteTab, tab_id)
    if not tab:
        raise HTTPException(404, "Note tab not found")
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(tab, key, value)
    db.commit()
    db.refresh(tab)
    return tab
