# Disaster Recovery

If this machine is lost, wiped, or the app folder is deleted, here's how to get back up and running.

## What's backed up where

- **App code** — GitHub (private repo). Backed up whenever changes are committed and pushed.
- **Database** — Backblaze B2. Backed up automatically per the schedule set in Admin → Automatic Backups, or on demand via "Run Backup Now".

## Before disaster strikes

Restoring needs your B2 Key ID, Application Key, and bucket name. Those are stored in the app's own database — which is exactly what you'd be trying to restore. **Keep a copy of them somewhere outside the app** (a password manager is ideal) or restore is a dead end.

## To restore on a new machine

1. Install Python 3.11+ and git.
2. Clone the repo:
   ```
   git clone <your-repo-url>
   cd raven
   ```
3. Create a virtual environment and install dependencies:
   ```
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt      # Windows
   .venv/bin/pip install -r requirements.txt          # macOS/Linux
   ```
4. Restore the database from Backblaze B2:
   ```
   .venv\Scripts\python restore.py --key-id <B2_KEY_ID> --application-key <B2_APPLICATION_KEY> --bucket <B2_BUCKET_NAME>
   ```
   (or set `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` as environment variables instead of flags)
5. Run the app:
   ```
   .venv\Scripts\python -m uvicorn app.main:app --port 8000
   ```

Your projects, tasks, notes, settings, and B2/Claude credentials all come back as part of the restored database — Admin will already show your saved schedule and connection info.

## Recovery time

With the repo cloned and B2 credentials on hand: `pip install`, one `restore.py` command, and you're running — a few minutes, not hours.
