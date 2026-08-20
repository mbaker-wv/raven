from sqlalchemy import Boolean, Column, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .crypto import EncryptedString
from .database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="active")  # active / paused / done
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    entries = relationship("Entry", back_populates="project")
    tasks = relationship("Task", back_populates="project")
    file_links = relationship("FileLink", back_populates="project")
    boards = relationship("Board", back_populates="project")


class Entry(Base):
    __tablename__ = "entries"

    id = Column(Integer, primary_key=True)
    content = Column(Text, nullable=False)
    entry_type = Column(String, nullable=False, default="note", index=True)  # update / decision / blocker / note
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    reminder_date = Column(Date, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    project = relationship("Project", back_populates="entries")
    task = relationship("Task", back_populates="notes")


class NoteTab(Base):
    __tablename__ = "note_tabs"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    status = Column(String, nullable=False, default="new", index=True)  # new / inprogress / blocked / closed
    due_date = Column(Date, nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    recurrence = Column(String, nullable=False, default="none")  # none / daily / weekly / monthly
    recurrence_day = Column(String, nullable=True)
    tags = Column(String, nullable=True)  # comma-separated
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    completed_at = Column(DateTime(timezone=True), nullable=True, index=True)
    archived = Column(Boolean, nullable=False, default=False, index=True)
    archived_at = Column(DateTime(timezone=True), nullable=True)

    project = relationship("Project", back_populates="tasks")
    notes = relationship("Entry", back_populates="task", order_by="Entry.created_at")


class FileLink(Base):
    __tablename__ = "file_links"

    id = Column(Integer, primary_key=True)
    path = Column(String, nullable=False)
    description = Column(String, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    tags = Column(String, nullable=True)  # comma-separated
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    project = relationship("Project", back_populates="file_links")


class Board(Base):
    __tablename__ = "boards"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    direction = Column(String, nullable=False, default="TD")  # TD / LR
    nodes = Column(Text, nullable=False, default="[]")  # JSON: [{id, label, shape, groupId}]
    edges = Column(Text, nullable=False, default="[]")  # JSON: [{from, to, label}]
    groups = Column(Text, nullable=False, default="[]")  # JSON: [{id, label}]
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    project = relationship("Project", back_populates="boards")


class LearnItem(Base):
    __tablename__ = "learn_items"

    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False, default="Untitled")
    source_text = Column(Text, nullable=False, default="")
    summary = Column(Text, nullable=True)
    chunks = Column(Text, nullable=True)  # JSON: [{heading, plain_text, key_terms}]
    mermaid = Column(Text, nullable=True)  # mermaid mindmap syntax
    quiz = Column(Text, nullable=True)  # JSON: [{question, answer}]
    checks = Column(Text, nullable=True)  # JSON: {overall, chunk_checks: [{index, status, note}], quiz_checks: [...]}
    checked_at = Column(DateTime(timezone=True), nullable=True)
    mode = Column(String, nullable=False, default="reading")  # "reading" | "topic"
    topic = Column(String, nullable=True)
    plan = Column(Text, nullable=True)  # JSON: [{title, description, content, quiz: [{question, answer}], completed}]
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True)
    ollama_model = Column(String, nullable=True)
    profile_name = Column(String, nullable=True)
    profile_role = Column(String, nullable=True)
    profile_context = Column(Text, nullable=True)
    ai_provider = Column(String, nullable=False, default="ollama")  # ollama / claude
    claude_api_key = Column(EncryptedString, nullable=True)
    claude_status = Column(String, nullable=True)  # ok / error, cached last-known result
    claude_status_detail = Column(Text, nullable=True)
    claude_status_checked_at = Column(DateTime(timezone=True), nullable=True)
    backup_schedule = Column(String, nullable=False, default="off")  # off / hourly / daily / weekly
    backup_local_retention = Column(Integer, nullable=False, default=10)
    backup_last_run_at = Column(DateTime(timezone=True), nullable=True)
    backup_last_status = Column(String, nullable=True)  # ok / error
    backup_last_detail = Column(Text, nullable=True)
    b2_key_id = Column(String, nullable=True)
    b2_application_key = Column(EncryptedString, nullable=True)
    b2_bucket_name = Column(String, nullable=True)
    b2_status = Column(String, nullable=True)  # ok / error, cached last-known result
    b2_status_detail = Column(Text, nullable=True)
    b2_status_checked_at = Column(DateTime(timezone=True), nullable=True)
    imap_host = Column(String, nullable=True)
    imap_port = Column(Integer, nullable=False, default=993)
    imap_username = Column(String, nullable=True)
    imap_password = Column(EncryptedString, nullable=True)
    imap_folder = Column(String, nullable=False, default="INBOX")
    imap_status = Column(String, nullable=True)  # ok / error, cached last-known result
    imap_status_detail = Column(Text, nullable=True)
    imap_status_checked_at = Column(DateTime(timezone=True), nullable=True)
    graph_client_id = Column(String, nullable=True)
    graph_tenant_id = Column(String, nullable=True)
    graph_folder = Column(String, nullable=False, default="inbox")
    graph_account = Column(String, nullable=True)  # connected mailbox address, for display
    graph_access_token = Column(EncryptedString, nullable=True)
    graph_refresh_token = Column(EncryptedString, nullable=True)
    graph_token_expires_at = Column(DateTime(timezone=True), nullable=True)
    graph_status = Column(String, nullable=True)  # ok / error, cached last-known result
    graph_status_detail = Column(Text, nullable=True)
    graph_status_checked_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    @property
    def claude_api_key_set(self) -> bool:
        return bool(self.claude_api_key)

    @property
    def b2_application_key_set(self) -> bool:
        return bool(self.b2_application_key)

    @property
    def b2_configured(self) -> bool:
        return bool(self.b2_key_id and self.b2_application_key and self.b2_bucket_name)

    @property
    def imap_password_set(self) -> bool:
        return bool(self.imap_password)

    @property
    def imap_configured(self) -> bool:
        return bool(self.imap_host and self.imap_username and self.imap_password)

    @property
    def graph_configured(self) -> bool:
        return bool(self.graph_client_id and self.graph_tenant_id and self.graph_refresh_token)


class Agent(Base):
    __tablename__ = "agents"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    system_prompt = Column(Text, nullable=False)
    context_mode = Column(String, nullable=False, default="none")  # none / digest / vuln_report
    ai_provider = Column(String, nullable=False, default="ollama")  # ollama / claude
    run_after_agent_id = Column(Integer, ForeignKey("agents.id"), nullable=True)
    enabled_skills = Column(String, nullable=True)  # comma-separated: create_task,complete_task,log_entry
    vuln_report_path = Column(String, nullable=True)  # file, or a folder to pick the newest .csv from
    vuln_report_previous_path = Column(String, nullable=True)  # optional: file/folder to diff the backlog against
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    run_after = relationship("Agent", remote_side=[id])

    @property
    def run_after_agent_name(self) -> str | None:
        return self.run_after.name if self.run_after else None


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id = Column(Integer, primary_key=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False, index=True)
    output = Column(Text, nullable=False)
    tool_calls = Column(Text, nullable=True)  # JSON array: [{"tool","args","result","is_error"}, ...]
    vuln_report_data = Column(Text, nullable=True)  # JSON: severity summary + composition + priority systems
    context_start = Column(Date, nullable=True)
    context_end = Column(Date, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    agent = relationship("Agent")


class SecurityCheckRun(Base):
    __tablename__ = "security_check_runs"

    id = Column(Integer, primary_key=True)
    results = Column(Text, nullable=False)  # JSON array: [{"check","status","detail"}, ...]
    created_at = Column(DateTime(timezone=True), server_default=func.now())
