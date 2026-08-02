# Disaster Recovery

If this machine is lost, wiped, or the app folder is deleted, here's how to get back up and running.

## What's backed up where

- **App code** — GitHub (private repo). Backed up whenever changes are committed and pushed.
- **Database** — Backblaze B2. Backed up automatically per the schedule set in Admin → Automatic Backups, or on demand via "Run Backup Now".
- **`.raven.key`** — nowhere. Deliberately not backed up (see below).

## Before disaster strikes

Restoring needs your B2 Key ID, Application Key, and bucket name. Those are stored in the app's own database — which is exactly what you'd be trying to restore. **Keep a copy of them somewhere outside the app** (a password manager is ideal) or restore is a dead end.

You also need the **`.raven.key`** file from your existing machine (in the project root, next to `requirements.txt` — it's git-ignored so `git clone` won't bring it over). This is the encryption key for your saved Claude API key and B2 Application Key inside the database. Copy it to the new machine yourself (USB drive, AirDrop, a password manager's file attachment — anything except GitHub or the B2 bucket, since it should never end up alongside the data it protects).

**If you don't have it:** the app still runs fine — a new key is generated automatically — but the restored Claude API key and B2 Application Key won't decrypt (the app detects this and treats them as unset rather than using garbage data), so you'll need to re-enter both in Admin after restoring. Everything else (projects, tasks, notes, entries, settings, agents) comes back intact either way.

## To restore on a new machine

1. Install Python 3.11+ and git.
2. Clone the repo:
   ```
   git clone <your-repo-url>
   cd raven
   ```
3. Create a virtual environment and install dependencies:
   ```
   python3 -m venv .venv                              # macOS/Linux
   python -m venv .venv                                # Windows

   .venv/bin/pip install -r requirements.txt          # macOS/Linux
   .venv\Scripts\pip install -r requirements.txt      # Windows
   ```
4. **Copy `.raven.key`** from your old machine into this `raven` folder now, before starting the app — if the app starts without one present, it generates a fresh key immediately, and restoring the real one afterward won't fix already-decrypted-wrong secrets (see above; you'd just re-enter the two keys in Admin instead, which is fine, just extra steps).
5. Restore the database from Backblaze B2:
   ```
   .venv/bin/python restore.py --key-id <B2_KEY_ID> --application-key <B2_APPLICATION_KEY> --bucket <B2_BUCKET_NAME>      # macOS/Linux
   .venv\Scripts\python restore.py --key-id <B2_KEY_ID> --application-key <B2_APPLICATION_KEY> --bucket <B2_BUCKET_NAME>  # Windows
   ```
   (or set `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` as environment variables instead of flags)
6. Run the app:
   ```
   .venv/bin/python -m uvicorn app.main:app --port 8000       # macOS/Linux
   .venv\Scripts\python -m uvicorn app.main:app --port 8000   # Windows
   ```

Your projects, tasks, notes, settings, and B2/Claude credentials all come back as part of the restored database — Admin will already show your saved schedule and connection info (assuming `.raven.key` came over with it).

## Recovery time

With the repo cloned, `.raven.key` copied over, and B2 credentials on hand: `pip install`, one `restore.py` command, and you're running — a few minutes, not hours.
