from sqlalchemy.orm import Session

from . import schemas
from .routers.entries import create_entry
from .routers.tasks import create_task, update_task

SKILLS = {
    "create_task": {
        "name": "create_task",
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
}


def parse_enabled_skills(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [key for key in raw.split(",") if key in SKILLS]


def build_tool_definitions(enabled: list[str]) -> list[dict]:
    return [SKILLS[key] for key in enabled if key in SKILLS]


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


_HANDLERS = {
    "create_task": _handle_create_task,
    "complete_task": _handle_complete_task,
    "log_entry": _handle_log_entry,
}


def execute_tool(db: Session, name: str, args: dict) -> str:
    handler = _HANDLERS.get(name)
    if not handler:
        raise ValueError(f"Unknown tool '{name}'.")
    return handler(db, **args)
