import os
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

NO_CACHE_HEADERS = {"Cache-Control": "no-store"}

from . import models
from .database import SessionLocal, engine, run_migrations
from .routers import admin, agents, entries, filelinks, note_tabs, projects, reports, tasks

models.Base.metadata.create_all(bind=engine)
run_migrations()

SECURITY_CHECK_STARTUP_DELAY_SECONDS = 15
SECURITY_CHECK_INTERVAL_SECONDS = 24 * 60 * 60
TASK_ARCHIVE_SWEEP_INTERVAL_SECONDS = 60 * 60
BACKUP_SCHEDULE_STARTUP_DELAY_SECONDS = 30
BACKUP_SCHEDULE_CHECK_INTERVAL_SECONDS = 5 * 60


def _security_check_loop():
    time.sleep(SECURITY_CHECK_STARTUP_DELAY_SECONDS)
    while True:
        db = SessionLocal()
        try:
            admin.run_and_persist_security_check(db)
        except Exception:
            pass
        finally:
            db.close()
        time.sleep(SECURITY_CHECK_INTERVAL_SECONDS)


def _task_archive_sweep_loop():
    while True:
        db = SessionLocal()
        try:
            tasks.sweep_archive_stale_tasks(db)
        except Exception:
            pass
        finally:
            db.close()
        time.sleep(TASK_ARCHIVE_SWEEP_INTERVAL_SECONDS)


def _backup_schedule_loop():
    time.sleep(BACKUP_SCHEDULE_STARTUP_DELAY_SECONDS)
    while True:
        db = SessionLocal()
        try:
            settings = admin._get_or_create_settings(db)
            interval = admin.SCHEDULE_INTERVALS.get(settings.backup_schedule)
            due = interval is not None and (
                settings.backup_last_run_at is None or datetime.now() - settings.backup_last_run_at >= interval
            )
            if due:
                admin.run_scheduled_backup(db)
        except Exception:
            pass
        finally:
            db.close()
        time.sleep(BACKUP_SCHEDULE_CHECK_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("RAVEN_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:8000")).start()
    threading.Thread(target=_security_check_loop, daemon=True).start()
    threading.Thread(target=_task_archive_sweep_loop, daemon=True).start()
    threading.Thread(target=_backup_schedule_loop, daemon=True).start()
    yield


app = FastAPI(title="Raven Tracker", lifespan=lifespan)

app.include_router(projects.router)
app.include_router(entries.router)
app.include_router(tasks.router)
app.include_router(filelinks.router)
app.include_router(reports.router)
app.include_router(agents.router)
app.include_router(admin.router)
app.include_router(note_tabs.router)

STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html", headers=NO_CACHE_HEADERS)


@app.get("/tasks")
def tasks_page():
    return FileResponse(STATIC_DIR / "tasks.html", headers=NO_CACHE_HEADERS)


@app.get("/notes")
def notes_page():
    return FileResponse(STATIC_DIR / "notes.html", headers=NO_CACHE_HEADERS)


@app.get("/weekly-report")
def weekly_report_page():
    return FileResponse(STATIC_DIR / "weekly-report.html", headers=NO_CACHE_HEADERS)


@app.get("/agents")
def agents_page():
    return FileResponse(STATIC_DIR / "agents.html", headers=NO_CACHE_HEADERS)


@app.get("/admin")
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html", headers=NO_CACHE_HEADERS)
