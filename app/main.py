import logging
import os
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

NO_CACHE_HEADERS = {"Cache-Control": "no-store"}
ALLOWED_ORIGIN_HOSTS = {"127.0.0.1", "localhost"}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

from . import models
from .database import SessionLocal, engine, run_migrations
from .logging_config import configure_logging
from .routers import admin, agents, boards, entries, filelinks, note_tabs, projects, reports, tasks
from .version import get_version

configure_logging()
logger = logging.getLogger("raven.main")

models.Base.metadata.create_all(bind=engine)
run_migrations()

SECURITY_CHECK_STARTUP_DELAY_SECONDS = 15
SECURITY_CHECK_INTERVAL_SECONDS = 24 * 60 * 60
TASK_ARCHIVE_SWEEP_INTERVAL_SECONDS = 60 * 60
BACKUP_SCHEDULE_STARTUP_DELAY_SECONDS = 30
BACKUP_SCHEDULE_CHECK_INTERVAL_SECONDS = 5 * 60


def _run_periodic(name: str, task: Callable[[Session], None], interval_seconds: int, startup_delay_seconds: int = 0) -> None:
    """Run `task(db)` on a loop forever, in its own daemon thread. Errors are logged
    (not swallowed) so a failing background job shows up in data/raven.log instead of
    vanishing silently."""
    if startup_delay_seconds:
        time.sleep(startup_delay_seconds)
    while True:
        db = SessionLocal()
        try:
            task(db)
        except Exception:
            logger.exception("Background task '%s' failed", name)
        finally:
            db.close()
        time.sleep(interval_seconds)


def _security_check_task(db: Session) -> None:
    admin.run_and_persist_security_check(db)


def _task_archive_sweep_task(db: Session) -> None:
    tasks.sweep_archive_stale_tasks(db)


def _backup_schedule_task(db: Session) -> None:
    settings = admin._get_or_create_settings(db)
    interval = admin.SCHEDULE_INTERVALS.get(settings.backup_schedule)
    due = interval is not None and (
        settings.backup_last_run_at is None or datetime.now() - settings.backup_last_run_at >= interval
    )
    if due:
        admin.run_scheduled_backup(db)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("RAVEN_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:8000")).start()
    threading.Thread(
        target=_run_periodic,
        args=("security_check", _security_check_task, SECURITY_CHECK_INTERVAL_SECONDS, SECURITY_CHECK_STARTUP_DELAY_SECONDS),
        daemon=True,
    ).start()
    threading.Thread(
        target=_run_periodic,
        args=("task_archive_sweep", _task_archive_sweep_task, TASK_ARCHIVE_SWEEP_INTERVAL_SECONDS),
        daemon=True,
    ).start()
    threading.Thread(
        target=_run_periodic,
        args=("backup_schedule", _backup_schedule_task, BACKUP_SCHEDULE_CHECK_INTERVAL_SECONDS, BACKUP_SCHEDULE_STARTUP_DELAY_SECONDS),
        daemon=True,
    ).start()
    logger.info("Raven startup complete.")
    yield


app = FastAPI(title="Raven Tracker", lifespan=lifespan)


@app.middleware("http")
async def block_cross_origin_api_requests(request: Request, call_next):
    """Raven has no login, so the browser's same-origin policy is the only thing
    stopping a page open in another tab from silently POSTing to this API. Reject
    state-changing requests whose Origin/Referer isn't this app itself."""
    if request.url.path.startswith("/api") and request.method in UNSAFE_METHODS:
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin and urlparse(origin).hostname not in ALLOWED_ORIGIN_HOSTS:
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
    return await call_next(request)


app.include_router(projects.router)
app.include_router(entries.router)
app.include_router(tasks.router)
app.include_router(filelinks.router)
app.include_router(reports.router)
app.include_router(agents.router)
app.include_router(admin.router)
app.include_router(note_tabs.router)
app.include_router(boards.router)

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/version")
def version():
    return {"version": get_version()}


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html", headers=NO_CACHE_HEADERS)


@app.get("/tasks")
def tasks_page():
    return FileResponse(STATIC_DIR / "tasks.html", headers=NO_CACHE_HEADERS)


@app.get("/notes")
def notes_page():
    return FileResponse(STATIC_DIR / "notes.html", headers=NO_CACHE_HEADERS)


@app.get("/activity-log")
def activity_log_page():
    return FileResponse(STATIC_DIR / "activity-log.html", headers=NO_CACHE_HEADERS)


@app.get("/agents")
def agents_page():
    return FileResponse(STATIC_DIR / "agents.html", headers=NO_CACHE_HEADERS)


@app.get("/boards")
def boards_page():
    return FileResponse(STATIC_DIR / "boards.html", headers=NO_CACHE_HEADERS)


@app.get("/admin")
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html", headers=NO_CACHE_HEADERS)
