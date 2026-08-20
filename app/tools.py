from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import graph_client, imap_client, models, schemas
from .routers.entries import create_entry
from .routers.tasks import create_task, update_task

GRAPH_TOKEN_REFRESH_BUFFER = timedelta(minutes=5)

SKILLS = {
    "create_task": {
        "name": "create_task",
        "label": "Create a task",
        "description": "Create a new task in Raven.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Task title (required)"},
                "due_date": {"type": "string", "description": "Due date as YYYY-MM-DD (optional)"},
                "project_id": {"type": "integer", "description": "Existing project id to attach this task to (optional)"},
            },
            "required": ["title"],
        },
    },
    "complete_task": {
        "name": "complete_task",
        "label": "Complete a task",
        "description": "Mark an existing Raven task as closed/done.",
        "input_schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "id of the task to mark complete"},
            },
            "required": ["task_id"],
        },
    },
    "log_entry": {
        "name": "log_entry",
        "label": "Log an entry",
        "description": "Log a work entry/note in Raven.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Entry content (required)"},
                "entry_type": {
                    "type": "string",
                    "enum": ["update", "decision", "blocker", "note"],
                    "description": "Entry type, default note",
                },
                "project_id": {"type": "integer", "description": "Existing project id (optional)"},
            },
            "required": ["content"],
        },
    },
    "search_emails": {
        "name": "search_emails",
        "label": "Search email (read-only)",
        "description": "Search the connected mailbox and read matching messages (subject, sender, date, body snippet). Read-only — never sends or modifies email.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sender": {"type": "string", "description": "Only messages from this address/name (optional)"},
                "subject_contains": {"type": "string", "description": "Only messages whose subject contains this text (optional)"},
                "since_days": {"type": "integer", "description": "Only messages from the last N days (optional)"},
                "limit": {"type": "integer", "description": "Max messages to return, default 10, max 25 (optional)"},
            },
            "required": [],
        },
    },
}


def parse_enabled_skills(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [key for key in raw.split(",") if key in SKILLS]


def build_tool_definitions(enabled: list[str]) -> list[dict]:
    """Claude's API rejects tool objects with unrecognized keys, so only forward the
    fields it actually expects — not display-only metadata like 'label'."""
    return [
        {"name": SKILLS[key]["name"], "description": SKILLS[key]["description"], "input_schema": SKILLS[key]["input_schema"]}
        for key in enabled
        if key in SKILLS
    ]


def _handle_create_task(db: Session, **args) -> str:
    payload = schemas.TaskCreate(title=args["title"], due_date=args.get("due_date"), project_id=args.get("project_id"))
    task = create_task(payload, db)
    due = f" (due {task.due_date})" if task.due_date else ""
    return f'Created task #{task.id} "{task.title}"{due}.'


def _handle_complete_task(db: Session, **args) -> str:
    task = update_task(args["task_id"], schemas.TaskUpdate(status="closed"), db)
    return f'Marked task #{task.id} "{task.title}" as closed.'


def _handle_log_entry(db: Session, **args) -> str:
    payload = schemas.EntryCreate(
        content=args["content"],
        entry_type=args.get("entry_type") or "note",
        project_id=args.get("project_id"),
    )
    entry = create_entry(payload, db)
    return f"Logged {entry.entry_type} entry #{entry.id}."


def _get_graph_access_token(db: Session, settings: models.Settings) -> str:
    if settings.graph_token_expires_at and settings.graph_token_expires_at - GRAPH_TOKEN_REFRESH_BUFFER > datetime.now():
        return settings.graph_access_token
    token = graph_client.refresh_access_token(settings.graph_client_id, settings.graph_tenant_id, settings.graph_refresh_token)
    settings.graph_access_token = token["access_token"]
    settings.graph_refresh_token = token.get("refresh_token", settings.graph_refresh_token)
    settings.graph_token_expires_at = datetime.now() + timedelta(seconds=token.get("expires_in", 3600))
    db.commit()
    return settings.graph_access_token


def _handle_search_emails(db: Session, **args) -> str:
    settings = db.query(models.Settings).first()
    limit = args.get("limit") or 10

    if settings and settings.graph_configured:
        access_token = _get_graph_access_token(db, settings)
        messages = graph_client.search_messages(
            access_token,
            settings.graph_folder,
            sender=args.get("sender"),
            subject_contains=args.get("subject_contains"),
            since_days=args.get("since_days"),
            limit=limit,
        )
    elif settings and settings.imap_configured:
        messages = imap_client.search_emails(
            settings.imap_host,
            settings.imap_port,
            settings.imap_username,
            settings.imap_password,
            settings.imap_folder,
            sender=args.get("sender"),
            subject_contains=args.get("subject_contains"),
            since_days=args.get("since_days"),
            limit=limit,
        )
    else:
        raise HTTPException(400, "Email isn't configured — connect a mailbox in Admin first.")

    if not messages:
        return "No matching emails found."
    lines = [f'{m["date"]} — {m["from"]} — "{m["subject"]}"\n{m["snippet"]}' for m in messages]
    return "\n\n".join(lines)


_HANDLERS = {
    "create_task": _handle_create_task,
    "complete_task": _handle_complete_task,
    "log_entry": _handle_log_entry,
    "search_emails": _handle_search_emails,
}


def execute_tool(db: Session, name: str, args: dict) -> str:
    handler = _HANDLERS.get(name)
    if not handler:
        raise ValueError(f"Unknown tool '{name}'.")
    return handler(db, **args)
