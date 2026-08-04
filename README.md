# Raven

A local-first personal work tracker: projects, tasks, notes, and an activity log, with AI agents (local via Ollama, or Claude) that can summarize your week, draft reports, and take actions like creating tasks or logging updates on your behalf.

Everything runs on your own machine. Your data lives in a local SQLite database — nothing is sent anywhere unless you explicitly turn on Claude (for AI) or Backblaze B2 (for off-machine backup), and both are optional.

## What's in it

- **Today** — a daily view of open tasks and reminders.
- **Tasks** — with due dates, recurrence (daily/weekly/monthly), tags, and project grouping.
- **Notes** — multiple rich-text tabs, autosaved.
- **Activity Log** — a running digest of updates, decisions, and blockers, usable as raw material for status reports.
- **Boards** — a click-based flow diagram builder (steps, connections, groups) rendered with Mermaid — no diagram syntax required.
- **Agents** — configurable AI agents with their own system prompt, optional access to a digest of recent activity, and optional "skills" (create a task, log an entry) so they can act, not just summarize. Agents can chain off one another.
- **Admin** — AI provider setup (Ollama or Claude), automatic backups to Backblaze B2, and a security check that audits things like dependency vulnerabilities, file permissions, and whether the server is reachable beyond localhost.

## Tech

FastAPI + SQLAlchemy + SQLite on the backend, plain HTML/CSS/JS on the frontend (no build step, no framework). Designed to run entirely offline with a local Ollama model; Claude and B2 are opt-in integrations layered on top.

## Getting started

See **[SETUP_INSTRUCTIONS.txt](SETUP_INSTRUCTIONS.txt)** for the full walkthrough (installing Ollama, pulling a model, installing Raven, and setting up a desktop launcher on Windows or macOS).

Quick version, if you already have Python 3.11+, git, and Ollama running:

```bash
git clone https://github.com/mbaker-wv/raven.git
cd raven
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --port 8000
```

Then open `http://localhost:8000`.

## This is a private repo

Access is invite-only. If you've been given access and are setting this up for yourself, start with `SETUP_INSTRUCTIONS.txt` — it also covers restoring from an existing backup if you're moving to a new machine (see `RESTORE.md`).

## License

See [LICENSE](LICENSE). In short: if you've been given access to this repo, you're welcome to run and modify your own copy for personal use. Redistribution or public hosting isn't permitted without permission.
