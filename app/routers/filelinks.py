from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/filelinks", tags=["filelinks"])


@router.post("", response_model=schemas.FileLinkOut)
def create_filelink(filelink: schemas.FileLinkCreate, db: Session = Depends(get_db)):
    db_filelink = models.FileLink(**filelink.model_dump())
    db.add(db_filelink)
    db.commit()
    db.refresh(db_filelink)
    return db_filelink


@router.get("", response_model=list[schemas.FileLinkOut])
def list_filelinks(project_id: int | None = None, db: Session = Depends(get_db)):
    query = db.query(models.FileLink)
    if project_id is not None:
        query = query.filter(models.FileLink.project_id == project_id)
    return query.order_by(models.FileLink.created_at.desc()).all()


@router.get("/{filelink_id}", response_model=schemas.FileLinkOut)
def get_filelink(filelink_id: int, db: Session = Depends(get_db)):
    filelink = db.get(models.FileLink, filelink_id)
    if not filelink:
        raise HTTPException(404, "FileLink not found")
    return filelink


@router.put("/{filelink_id}", response_model=schemas.FileLinkOut)
def update_filelink(filelink_id: int, update: schemas.FileLinkUpdate, db: Session = Depends(get_db)):
    filelink = db.get(models.FileLink, filelink_id)
    if not filelink:
        raise HTTPException(404, "FileLink not found")
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(filelink, key, value)
    db.commit()
    db.refresh(filelink)
    return filelink


@router.delete("/{filelink_id}", status_code=204)
def delete_filelink(filelink_id: int, db: Session = Depends(get_db)):
    filelink = db.get(models.FileLink, filelink_id)
    if not filelink:
        raise HTTPException(404, "FileLink not found")
    db.delete(filelink)
    db.commit()
