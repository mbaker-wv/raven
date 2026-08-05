import importlib.metadata
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from packaging.version import parse as parse_version
from sqlalchemy.orm import Session

from .. import b2_client, models, schemas
from ..claude_client import CLAUDE_MODEL, test_connection as test_claude_connection
from ..crypto import KEY_PATH
from ..database import BASE_DIR, DATA_DIR, DATABASE_PATH, get_db
from ..net import SSL_CONTEXT
from ..ollama_client import OLLAMA_HOST, get_active_model, list_models
from ..version import get_version

router = APIRouter(prefix="/api/admin", tags=["admin"])

BACKUP_DIR = DATA_DIR / "backups"
REQUIREMENTS_PATH = BASE_DIR / "requirements.txt"

SCHEDULE_INTERVALS = {
    "hourly": timedelta(hours=1),
    "daily": timedelta(hours=24),
    "weekly": timedelta(days=7),
}


def _get_or_create_settings(db: Session) -> models.Settings:
    settings = db.query(models.Settings).first()
    if not settings:
        settings = models.Settings()
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("/settings", response_model=schemas.SettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return _get_or_create_settings(db)


@router.put("/settings", response_model=schemas.SettingsOut)
def update_settings(update: schemas.SettingsUpdate, db: Session = Depends(get_db)):
    settings = _get_or_create_settings(db)
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(settings, key, value)
    db.commit()
    db.refresh(settings)
    return settings


@router.get("/ollama-models")
def get_ollama_models():
    return {"models": list_models()}


@router.post("/claude/test")
def test_claude(payload: schemas.ClaudeTestRequest, db: Session = Depends(get_db)):
    settings = _get_or_create_settings(db)
    api_key = payload.api_key or settings.claude_api_key
    if not api_key:
        raise HTTPException(400, "No API key provided or saved.")
    try:
        test_claude_connection(api_key)
    except HTTPException as exc:
        settings.claude_status = "error"
        settings.claude_status_detail = str(exc.detail)[:500]
        settings.claude_status_checked_at = datetime.now()
        db.commit()
        raise
    settings.claude_status = "ok"
    settings.claude_status_detail = "Connected"
    settings.claude_status_checked_at = datetime.now()
    db.commit()
    return {"status": settings.claude_status, "detail": settings.claude_status_detail}


@router.get("/ai-status")
def ai_status(db: Session = Depends(get_db)):
    settings = _get_or_create_settings(db)
    provider = settings.ai_provider or "ollama"

    if provider == "claude":
        if not settings.claude_api_key:
            return {"provider": "claude", "model": CLAUDE_MODEL, "status": "error", "detail": "No API key saved."}
        return {
            "provider": "claude",
            "model": CLAUDE_MODEL,
            "status": settings.claude_status or "unknown",
            "detail": settings.claude_status_detail or "Not tested yet.",
        }

    model = get_active_model(db)
    try:
        list_models()
        return {"provider": "ollama", "model": model, "status": "ok", "detail": "Connected"}
    except HTTPException as exc:
        return {"provider": "ollama", "model": model, "status": "error", "detail": str(exc.detail)}


def _create_backup() -> dict:
    BACKUP_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = BACKUP_DIR / f"tracker-{timestamp}.db"
    shutil.copy2(DATABASE_PATH, dest)
    return {"file": dest.name, "created_at": timestamp}


@router.post("/backup")
def backup_db():
    return _create_backup()


def _prune_backups(pattern: str, retention: int) -> None:
    files = sorted(BACKUP_DIR.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in files[max(retention, 1):]:
        f.unlink()


def run_scheduled_backup(db: Session) -> dict:
    settings = _get_or_create_settings(db)
    created = _create_backup()

    uploaded = False
    upload_error: str | None = None
    if settings.b2_configured:
        try:
            bucket = b2_client.get_bucket(settings.b2_key_id, settings.b2_application_key, settings.b2_bucket_name)
            b2_client.upload_file(bucket, BACKUP_DIR / created["file"], created["file"])
            uploaded = True
            _prune_backups("tracker-*.db", settings.backup_local_retention)
        except HTTPException as exc:
            upload_error = str(exc.detail)

    settings.backup_last_run_at = datetime.now()
    if settings.b2_configured and upload_error:
        settings.backup_last_status = "error"
        settings.backup_last_detail = f"Backed up locally ({created['file']}) but upload to B2 failed: {upload_error}"
    elif settings.b2_configured:
        settings.backup_last_status = "ok"
        settings.backup_last_detail = f"Backed up and uploaded to B2: {created['file']}"
    else:
        settings.backup_last_status = "ok"
        settings.backup_last_detail = f"Backed up locally: {created['file']} (B2 not configured — not uploaded)"
    db.commit()
    return {
        "file": created["file"],
        "uploaded": uploaded,
        "status": settings.backup_last_status,
        "detail": settings.backup_last_detail,
    }


@router.post("/backup/run")
def run_backup_now(db: Session = Depends(get_db)):
    return run_scheduled_backup(db)


@router.post("/backup/b2-test")
def test_b2(payload: schemas.B2TestRequest, db: Session = Depends(get_db)):
    settings = _get_or_create_settings(db)
    key_id = payload.key_id or settings.b2_key_id
    application_key = payload.application_key or settings.b2_application_key
    bucket_name = payload.bucket_name or settings.b2_bucket_name
    try:
        b2_client.test_connection(key_id, application_key, bucket_name)
    except HTTPException as exc:
        settings.b2_status = "error"
        settings.b2_status_detail = str(exc.detail)[:500]
        settings.b2_status_checked_at = datetime.now()
        db.commit()
        raise
    settings.b2_status = "ok"
    settings.b2_status_detail = "Connected"
    settings.b2_status_checked_at = datetime.now()
    db.commit()
    return {"status": settings.b2_status, "detail": settings.b2_status_detail}


@router.delete("/tasks")
def delete_all_tasks(db: Session = Depends(get_db)):
    backup = _create_backup()
    db.query(models.Entry).filter(models.Entry.task_id.isnot(None)).update({"task_id": None})
    deleted = db.query(models.Task).delete()
    db.commit()
    return {"deleted": deleted, "backup_file": backup["file"]}


@router.delete("/entries")
def delete_all_entries(db: Session = Depends(get_db)):
    backup = _create_backup()
    deleted = db.query(models.Entry).delete()
    db.commit()
    return {"deleted": deleted, "backup_file": backup["file"]}


@router.post("/reset")
def reset_database(db: Session = Depends(get_db)):
    backup = _create_backup()
    db.query(models.AgentRun).delete()
    db.query(models.Agent).delete()
    db.query(models.Entry).delete()
    db.query(models.Task).delete()
    db.query(models.FileLink).delete()
    db.query(models.Project).delete()
    db.commit()
    return {"backup_file": backup["file"]}


@router.get("/backups")
def list_backups():
    BACKUP_DIR.mkdir(exist_ok=True)
    files = sorted(BACKUP_DIR.glob("tracker-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "file": f.name,
            "size_kb": round(f.stat().st_size / 1024, 1),
            "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        }
        for f in files
    ]


BACKUP_FILENAME_RE = re.compile(r"^tracker-\d{8}-\d{6}\.db$")


@router.delete("/backups/{filename}", status_code=204)
def delete_backup(filename: str):
    if not BACKUP_FILENAME_RE.match(filename):
        raise HTTPException(400, "Invalid backup filename")
    path = BACKUP_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Backup not found")
    path.unlink()


@router.delete("/backups")
def delete_all_backups():
    BACKUP_DIR.mkdir(exist_ok=True)
    deleted = 0
    for f in BACKUP_DIR.glob("tracker-*.db"):
        f.unlink()
        deleted += 1
    return {"deleted": deleted}


def _git(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", *args], cwd=BASE_DIR, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise HTTPException(500, "git is not installed or not on PATH.")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"git {' '.join(args)} timed out.")


def _dirty_files() -> list[str]:
    proc = _git(["status", "--porcelain"])
    if proc.returncode != 0:
        raise HTTPException(500, f"git status failed: {proc.stderr.strip()[:500]}")
    return [line[3:].strip() for line in proc.stdout.splitlines() if line.strip()]


def _version_at(ref: str) -> str | None:
    proc = _git(["show", f"{ref}:VERSION"])
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


@router.get("/update/check")
def check_for_update():
    if not (BASE_DIR / ".git").exists():
        return {"available": False, "error": "This copy of Raven isn't a git checkout, so it can't self-update."}

    branch_proc = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    if branch_proc.returncode != 0:
        return {"available": False, "error": f"Couldn't determine current branch: {branch_proc.stderr.strip()[:500]}"}
    branch = branch_proc.stdout.strip()

    fetch = _git(["fetch", "origin", branch], timeout=60)
    if fetch.returncode != 0:
        return {"available": False, "error": f"Couldn't reach GitHub: {fetch.stderr.strip()[:500]}"}

    local = _git(["rev-parse", "HEAD"]).stdout.strip()
    remote_proc = _git(["rev-parse", f"origin/{branch}"])
    if remote_proc.returncode != 0:
        return {"available": False, "error": f"No origin/{branch} branch found on GitHub."}
    remote = remote_proc.stdout.strip()

    dirty_files = _dirty_files()
    current_version = get_version()

    if local == remote:
        return {
            "available": False,
            "branch": branch,
            "current_commit": local[:7],
            "current_version": current_version,
            "dirty_files": dirty_files,
        }

    log_proc = _git(["log", "--oneline", f"{local}..{remote}"])
    commits = log_proc.stdout.strip().splitlines() if log_proc.returncode == 0 else []

    return {
        "available": True,
        "branch": branch,
        "current_commit": local[:7],
        "latest_commit": remote[:7],
        "current_version": current_version,
        "latest_version": _version_at(f"origin/{branch}") or current_version,
        "commits_behind": len(commits),
        "commits": commits[:20],
        "dirty_files": dirty_files,
    }


@router.post("/update/apply")
def apply_update():
    if not (BASE_DIR / ".git").exists():
        raise HTTPException(400, "This copy of Raven isn't a git checkout, so it can't self-update.")

    dirty_files = _dirty_files()
    if dirty_files:
        raise HTTPException(
            409,
            "Local changes would be overwritten by an update, in: " + ", ".join(dirty_files[:10])
            + ". Commit, stash, or discard them before updating.",
        )

    branch_proc = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    if branch_proc.returncode != 0:
        raise HTTPException(500, f"Couldn't determine current branch: {branch_proc.stderr.strip()[:500]}")
    branch = branch_proc.stdout.strip()

    before_reqs = REQUIREMENTS_PATH.read_text() if REQUIREMENTS_PATH.exists() else ""

    pull = _git(["pull", "--ff-only", "origin", branch], timeout=60)
    if pull.returncode != 0:
        raise HTTPException(500, f"git pull failed: {(pull.stderr or pull.stdout).strip()[:500]}")

    after_reqs = REQUIREMENTS_PATH.read_text() if REQUIREMENTS_PATH.exists() else ""
    deps_updated = False
    pip_error = None
    if after_reqs != before_reqs:
        try:
            pip_proc = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_PATH)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if pip_proc.returncode == 0:
                deps_updated = True
            else:
                pip_error = (pip_proc.stderr or pip_proc.stdout).strip()[:1000]
        except subprocess.TimeoutExpired:
            pip_error = "pip install timed out after 5 minutes."

    return {
        "output": pull.stdout.strip(),
        "new_commit": _git(["rev-parse", "HEAD"]).stdout.strip()[:7],
        "new_version": get_version(),
        "deps_updated": deps_updated,
        "pip_error": pip_error,
        "restart_required": True,
    }


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _check_server_bind_address() -> dict:
    """Uvicorn defaults to 127.0.0.1 when --host isn't passed, so a missing flag is safe.
    Reads the actual launch args instead of assuming, so this can't silently go stale if
    someone changes how Raven is started."""
    host = None
    for i, arg in enumerate(sys.argv):
        if arg == "--host" and i + 1 < len(sys.argv):
            host = sys.argv[i + 1]
            break
        if arg.startswith("--host="):
            host = arg.split("=", 1)[1]
            break

    if host is None:
        return {
            "check": "Server bind address",
            "status": "pass",
            "detail": "No --host flag passed — uvicorn defaults to 127.0.0.1, not reachable from the network.",
        }
    if host in LOOPBACK_HOSTS:
        return {"check": "Server bind address", "status": "pass", "detail": f"Bound to {host} — not reachable from the network."}
    return {
        "check": "Server bind address",
        "status": "fail",
        "detail": (
            f"Server was started with --host {host}, which is reachable from beyond this machine. "
            "Remove --host (or set it to 127.0.0.1) unless you specifically intend to expose Raven on your network."
        ),
    }


def _check_key_file_permissions() -> dict:
    """.raven.key encrypts the Claude/B2 secrets at rest — if it's readable by other
    accounts on this machine, that encryption doesn't buy you anything."""
    check_name = "Secret key file permissions"
    if not KEY_PATH.exists():
        return {"check": check_name, "status": "info", "detail": f"{KEY_PATH} doesn't exist yet — created on first save of a Claude or B2 secret."}

    mode = stat.S_IMODE(KEY_PATH.stat().st_mode)
    if os.name == "nt":
        return {"check": check_name, "status": "info", "detail": "Windows doesn't use POSIX file permissions, so this check doesn't apply here."}
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        return {
            "check": check_name,
            "status": "fail",
            "detail": f"{KEY_PATH} is readable by other users on this machine (mode {oct(mode)}). Run: chmod 600 {KEY_PATH}",
        }
    return {"check": check_name, "status": "pass", "detail": f"{KEY_PATH} is only readable by you (mode {oct(mode)})."}


def _run_builtin_checks() -> list[dict]:
    results = []

    results.append(_check_server_bind_address())
    results.append(_check_key_file_permissions())

    reload_enabled = "--reload" in sys.argv
    if reload_enabled:
        results.append(
            {
                "check": "Debug/reload mode",
                "status": "info",
                "detail": "This server is running with --reload, so backend code changes apply automatically. Fine for this app since it only binds to 127.0.0.1, but shouldn't be used if this were ever exposed beyond localhost.",
            }
        )
    else:
        results.append(
            {
                "check": "Debug/reload mode",
                "status": "pass",
                "detail": "This server is not running in --reload/debug mode.",
            }
        )

    if DATABASE_PATH.exists():
        results.append(
            {
                "check": "Database file",
                "status": "info",
                "detail": f"{DATABASE_PATH} exists, {round(DATABASE_PATH.stat().st_size / 1024, 1)} KB.",
            }
        )

    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip_audit", "-r", str(REQUIREMENTS_PATH), "-f", "json"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.stdout.strip():
            audit = json.loads(proc.stdout)
            deps = audit.get("dependencies", audit if isinstance(audit, list) else [])
            vuln_lines = []
            for d in deps:
                for v in d.get("vulns", []):
                    vuln_lines.append(f"{d['name']} {d['version']}: {v['id']}")
            if vuln_lines:
                results.append(
                    {
                        "check": "Dependency vulnerabilities (pip-audit)",
                        "status": "fail",
                        "detail": "; ".join(vuln_lines),
                    }
                )
            else:
                results.append(
                    {
                        "check": "Dependency vulnerabilities (pip-audit)",
                        "status": "pass",
                        "detail": "No known vulnerabilities found in installed packages.",
                    }
                )
        else:
            results.append(
                {
                    "check": "Dependency vulnerabilities (pip-audit)",
                    "status": "error",
                    "detail": (proc.stderr or "pip-audit produced no output").strip()[:500],
                }
            )
    except FileNotFoundError:
        results.append(
            {
                "check": "Dependency vulnerabilities (pip-audit)",
                "status": "error",
                "detail": "pip-audit is not installed. Run: pip install -r requirements.txt",
            }
        )
    except Exception as exc:
        results.append(
            {
                "check": "Dependency vulnerabilities (pip-audit)",
                "status": "error",
                "detail": str(exc)[:500],
            }
        )

    return results


def _parse_requirements() -> list[str]:
    packages = []
    for line in REQUIREMENTS_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = re.split(r"[\[=<>~!]", line)[0].strip()
        if name:
            packages.append(name)
    return packages


def _check_outdated_packages() -> list[dict]:
    results = []
    for name in _parse_requirements():
        check_name = f"Outdated package: {name}"
        try:
            installed = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            results.append({"check": check_name, "status": "error", "detail": "Not installed in this environment."})
            continue

        try:
            req = urllib.request.Request(f"https://pypi.org/pypi/{name}/json", headers={"User-Agent": "Raven-SecurityCheck"})
            with urllib.request.urlopen(req, timeout=10, context=SSL_CONTEXT) as resp:
                data = json.loads(resp.read())
            latest = data.get("info", {}).get("version")
        except Exception as exc:
            results.append({"check": check_name, "status": "error", "detail": f"Could not reach PyPI: {exc}"})
            continue

        if not latest:
            results.append({"check": check_name, "status": "error", "detail": "PyPI response had no version info."})
            continue

        installed_v, latest_v = parse_version(installed), parse_version(latest)
        if installed_v >= latest_v:
            results.append({"check": check_name, "status": "pass", "detail": f"Up to date ({installed})."})
        elif latest_v.major > installed_v.major:
            results.append(
                {
                    "check": check_name,
                    "status": "fail",
                    "detail": f"Installed {installed}, latest is {latest} — behind by a major version.",
                }
            )
        else:
            results.append({"check": check_name, "status": "info", "detail": f"Installed {installed}, latest is {latest}."})
    return results


def _check_ollama_version() -> list[dict]:
    try:
        req = urllib.request.Request(f"{OLLAMA_HOST}/api/version")
        with urllib.request.urlopen(req, timeout=5) as resp:
            local_version = json.loads(resp.read()).get("version")
    except (urllib.error.URLError, OSError):
        return [{"check": "Ollama version", "status": "info", "detail": "Ollama isn't running locally — can't check its version."}]

    if not local_version:
        return [{"check": "Ollama version", "status": "error", "detail": "Ollama's /api/version response had no version field."}]

    try:
        gh_req = urllib.request.Request(
            "https://api.github.com/repos/ollama/ollama/releases/latest",
            headers={"User-Agent": "Raven-SecurityCheck"},
        )
        with urllib.request.urlopen(gh_req, timeout=10, context=SSL_CONTEXT) as resp:
            latest_tag = json.loads(resp.read()).get("tag_name", "").lstrip("v")
    except Exception as exc:
        return [{"check": "Ollama version", "status": "error", "detail": f"Running {local_version}, but couldn't reach GitHub to check the latest release: {exc}"}]

    if not latest_tag:
        return [{"check": "Ollama version", "status": "error", "detail": "GitHub response had no release tag."}]

    if parse_version(local_version) >= parse_version(latest_tag):
        return [{"check": "Ollama version", "status": "pass", "detail": f"Up to date ({local_version})."}]
    return [
        {
            "check": "Ollama version",
            "status": "info",
            "detail": f"Running {local_version}, latest is {latest_tag}. Update from ollama.com when convenient.",
        }
    ]


def run_and_persist_security_check(db: Session) -> models.SecurityCheckRun:
    results = _run_builtin_checks() + _check_outdated_packages() + _check_ollama_version()
    run = models.SecurityCheckRun(results=json.dumps(results))
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _regressed_checks(current: list[dict], previous: list[dict] | None) -> list[str]:
    if not previous:
        return []
    prev_by_name = {r["check"]: r for r in previous}
    ok_statuses = {"pass", "info"}
    regressed = []
    for r in current:
        prev = prev_by_name.get(r["check"])
        if not prev:
            continue
        current_bad = r["status"] not in ok_statuses
        prev_bad = prev["status"] not in ok_statuses
        if current_bad and (not prev_bad or r["detail"] != prev["detail"]):
            regressed.append(r["check"])
    return regressed


def _latest_run_before(db: Session, before_id: int | None) -> list[dict] | None:
    query = db.query(models.SecurityCheckRun).order_by(models.SecurityCheckRun.id.desc())
    if before_id is not None:
        query = query.filter(models.SecurityCheckRun.id < before_id)
    prev = query.first()
    return json.loads(prev.results) if prev else None


@router.post("/security-check")
def security_check(db: Session = Depends(get_db)):
    previous = _latest_run_before(db, before_id=None)
    run = run_and_persist_security_check(db)
    current = json.loads(run.results)
    return {"results": current, "checked_at": run.created_at.isoformat(), "regressed": _regressed_checks(current, previous)}


@router.get("/security-check/latest")
def latest_security_check(db: Session = Depends(get_db)):
    run = db.query(models.SecurityCheckRun).order_by(models.SecurityCheckRun.id.desc()).first()
    if not run:
        return {"results": [], "checked_at": None, "regressed": []}
    current = json.loads(run.results)
    previous = _latest_run_before(db, before_id=run.id)
    return {"results": current, "checked_at": run.created_at.isoformat(), "regressed": _regressed_checks(current, previous)}


@router.get("/security-check/history", response_model=list[schemas.SecurityCheckRunOut])
def security_check_history(db: Session = Depends(get_db)):
    return db.query(models.SecurityCheckRun).order_by(models.SecurityCheckRun.created_at.desc()).limit(20).all()
