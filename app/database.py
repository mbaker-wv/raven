import json
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DATABASE_PATH = DATA_DIR / "tracker.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def run_migrations():
    with engine.connect() as conn:
        entry_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(entries)"))]
        if entry_columns and "task_id" not in entry_columns:
            conn.execute(text("ALTER TABLE entries ADD COLUMN task_id INTEGER REFERENCES tasks(id)"))
            conn.commit()

        if entry_columns and "reminder_date" not in entry_columns:
            conn.execute(text("ALTER TABLE entries ADD COLUMN reminder_date DATE"))
            conn.commit()

        note_tab_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(note_tabs)"))]
        if note_tab_columns and "content" not in note_tab_columns:
            conn.execute(text("ALTER TABLE note_tabs ADD COLUMN content TEXT DEFAULT ''"))
            conn.commit()

        if note_tab_columns and "updated_at" not in note_tab_columns:
            conn.execute(text("ALTER TABLE note_tabs ADD COLUMN updated_at DATETIME"))
            conn.commit()

        conn.execute(text("UPDATE note_tabs SET updated_at = created_at WHERE updated_at IS NULL"))
        conn.commit()

        note_tab_count = conn.execute(text("SELECT COUNT(*) FROM note_tabs")).scalar()
        if note_tab_count == 0:
            for name in ("Notes 1", "Notes 2", "Notes 3"):
                conn.execute(text("INSERT INTO note_tabs (name, content) VALUES (:name, '')"), {"name": name})
            conn.commit()

        task_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(tasks)"))]
        if task_columns and "tags" not in task_columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN tags TEXT"))
            conn.commit()

        if task_columns and "archived" not in task_columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN archived BOOLEAN DEFAULT 0"))
            conn.commit()

        if task_columns and "archived_at" not in task_columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN archived_at DATETIME"))
            conn.commit()

        if task_columns:
            status_remap = {"todo": "new", "doing": "inprogress", "waiting": "blocked", "done": "closed"}
            for old, new in status_remap.items():
                conn.execute(text("UPDATE tasks SET status = :new WHERE status = :old"), {"new": new, "old": old})
            conn.commit()

        settings_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(settings)"))]
        if settings_columns:
            settings_migrations = [
                ("ai_provider", "ALTER TABLE settings ADD COLUMN ai_provider TEXT DEFAULT 'ollama'"),
                ("claude_api_key", "ALTER TABLE settings ADD COLUMN claude_api_key TEXT"),
                ("claude_status", "ALTER TABLE settings ADD COLUMN claude_status TEXT"),
                ("claude_status_detail", "ALTER TABLE settings ADD COLUMN claude_status_detail TEXT"),
                ("claude_status_checked_at", "ALTER TABLE settings ADD COLUMN claude_status_checked_at DATETIME"),
                ("backup_schedule", "ALTER TABLE settings ADD COLUMN backup_schedule TEXT DEFAULT 'off'"),
                ("backup_local_retention", "ALTER TABLE settings ADD COLUMN backup_local_retention INTEGER DEFAULT 10"),
                ("backup_last_run_at", "ALTER TABLE settings ADD COLUMN backup_last_run_at DATETIME"),
                ("backup_last_status", "ALTER TABLE settings ADD COLUMN backup_last_status TEXT"),
                ("backup_last_detail", "ALTER TABLE settings ADD COLUMN backup_last_detail TEXT"),
                ("b2_key_id", "ALTER TABLE settings ADD COLUMN b2_key_id TEXT"),
                ("b2_application_key", "ALTER TABLE settings ADD COLUMN b2_application_key TEXT"),
                ("b2_bucket_name", "ALTER TABLE settings ADD COLUMN b2_bucket_name TEXT"),
                ("b2_status", "ALTER TABLE settings ADD COLUMN b2_status TEXT"),
                ("b2_status_detail", "ALTER TABLE settings ADD COLUMN b2_status_detail TEXT"),
                ("b2_status_checked_at", "ALTER TABLE settings ADD COLUMN b2_status_checked_at DATETIME"),
            ]
            for column, ddl in settings_migrations:
                if column not in settings_columns:
                    conn.execute(text(ddl))
            conn.commit()

            if "backup_include_app" in settings_columns:
                conn.execute(text("ALTER TABLE settings DROP COLUMN backup_include_app"))
                conn.commit()

        agent_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(agents)"))]
        if agent_columns:
            agent_migrations = [
                ("ai_provider", "ALTER TABLE agents ADD COLUMN ai_provider TEXT DEFAULT 'ollama'"),
                ("run_after_agent_id", "ALTER TABLE agents ADD COLUMN run_after_agent_id INTEGER REFERENCES agents(id)"),
                ("enabled_skills", "ALTER TABLE agents ADD COLUMN enabled_skills TEXT"),
            ]
            for column, ddl in agent_migrations:
                if column not in agent_columns:
                    conn.execute(text(ddl))
            conn.commit()

        agent_run_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(agent_runs)"))]
        if agent_run_columns and "tool_calls" not in agent_run_columns:
            conn.execute(text("ALTER TABLE agent_runs ADD COLUMN tool_calls TEXT"))
            conn.commit()

        board_columns = [row[1] for row in conn.execute(text("PRAGMA table_info(boards)"))]
        if board_columns and "groups" not in board_columns:
            conn.execute(text("ALTER TABLE boards ADD COLUMN groups TEXT DEFAULT '[]'"))
            conn.commit()

        _seed_example_board(conn)
        _encrypt_legacy_secrets(conn)
        _create_missing_indexes(conn)


# Mirrors the index=True columns declared in models.py. create_all() only creates indexes
# for brand-new tables, so pre-existing databases need these added explicitly.
INDEXES = [
    ("ix_entries_entry_type", "entries", "entry_type"),
    ("ix_entries_project_id", "entries", "project_id"),
    ("ix_entries_task_id", "entries", "task_id"),
    ("ix_entries_reminder_date", "entries", "reminder_date"),
    ("ix_entries_created_at", "entries", "created_at"),
    ("ix_tasks_status", "tasks", "status"),
    ("ix_tasks_due_date", "tasks", "due_date"),
    ("ix_tasks_project_id", "tasks", "project_id"),
    ("ix_tasks_created_at", "tasks", "created_at"),
    ("ix_tasks_completed_at", "tasks", "completed_at"),
    ("ix_tasks_archived", "tasks", "archived"),
    ("ix_file_links_project_id", "file_links", "project_id"),
    ("ix_boards_project_id", "boards", "project_id"),
    ("ix_agent_runs_agent_id", "agent_runs", "agent_id"),
]


def _seed_example_board(conn) -> None:
    board_count = conn.execute(text("SELECT COUNT(*) FROM boards")).scalar()
    if board_count:
        return
    nodes = [
        {"id": "n1", "label": "Task created", "shape": "stadium"},
        {"id": "n2", "label": "In progress", "shape": "rect"},
        {"id": "n3", "label": "Blocked?", "shape": "diamond"},
        {"id": "n4", "label": "Blocked", "shape": "rect"},
        {"id": "n5", "label": "Closed", "shape": "stadium"},
    ]
    edges = [
        {"from": "n1", "to": "n2", "label": ""},
        {"from": "n2", "to": "n3", "label": ""},
        {"from": "n3", "to": "n4", "label": "yes"},
        {"from": "n4", "to": "n2", "label": "unblocked"},
        {"from": "n3", "to": "n5", "label": "no"},
    ]
    conn.execute(
        text("INSERT INTO boards (name, direction, nodes, edges) VALUES (:name, 'TD', :nodes, :edges)"),
        {"name": "Example: Task lifecycle", "nodes": json.dumps(nodes), "edges": json.dumps(edges)},
    )
    conn.commit()


def _create_missing_indexes(conn) -> None:
    for index_name, table, column in INDEXES:
        conn.execute(text(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"))
    conn.commit()


def _encrypt_legacy_secrets(conn) -> None:
    """One-time upgrade path: encrypt any claude_api_key/b2_application_key saved before
    at-rest encryption was added, so they don't sit in plaintext waiting for a re-save."""
    from .crypto import encrypt, is_encrypted

    row = conn.execute(text("SELECT id, claude_api_key, b2_application_key FROM settings")).first()
    if not row:
        return

    updates = {}
    if row.claude_api_key and not is_encrypted(row.claude_api_key):
        updates["claude_api_key"] = encrypt(row.claude_api_key)
    if row.b2_application_key and not is_encrypted(row.b2_application_key):
        updates["b2_application_key"] = encrypt(row.b2_application_key)

    if updates:
        set_clause = ", ".join(f"{col} = :{col}" for col in updates)
        conn.execute(text(f"UPDATE settings SET {set_clause} WHERE id = :id"), {**updates, "id": row.id})
        conn.commit()
