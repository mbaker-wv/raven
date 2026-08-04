import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/boards", tags=["boards"])


@router.get("", response_model=list[schemas.BoardOut])
def list_boards(db: Session = Depends(get_db)):
    return db.query(models.Board).order_by(models.Board.id).all()


@router.post("", response_model=schemas.BoardOut)
def create_board(board: schemas.BoardCreate, db: Session = Depends(get_db)):
    db_board = models.Board(
        name=board.name,
        project_id=board.project_id,
        direction=board.direction,
        nodes=json.dumps(board.nodes),
        edges=json.dumps(board.edges),
        groups=json.dumps(board.groups),
    )
    db.add(db_board)
    db.commit()
    db.refresh(db_board)
    return db_board


@router.put("/{board_id}", response_model=schemas.BoardOut)
def update_board(board_id: int, update: schemas.BoardUpdate, db: Session = Depends(get_db)):
    board = db.get(models.Board, board_id)
    if not board:
        raise HTTPException(404, "Board not found")
    updates = update.model_dump(exclude_unset=True)
    if "nodes" in updates:
        updates["nodes"] = json.dumps(updates["nodes"])
    if "edges" in updates:
        updates["edges"] = json.dumps(updates["edges"])
    if "groups" in updates:
        updates["groups"] = json.dumps(updates["groups"])
    for key, value in updates.items():
        setattr(board, key, value)
    db.commit()
    db.refresh(board)
    return board


@router.delete("/{board_id}", status_code=204)
def delete_board(board_id: int, db: Session = Depends(get_db)):
    board = db.get(models.Board, board_id)
    if not board:
        raise HTTPException(404, "Board not found")
    db.delete(board)
    db.commit()
