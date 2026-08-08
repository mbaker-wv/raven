import json
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator


class ProjectBase(BaseModel):
    name: str
    status: Literal["active", "paused", "done"] = "active"


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[Literal["active", "paused", "done"]] = None


class ProjectOut(ProjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class EntryBase(BaseModel):
    content: str
    entry_type: Literal["update", "decision", "blocker", "note"] = "note"
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    reminder_date: Optional[date] = None


class EntryCreate(EntryBase):
    pass


class EntryUpdate(BaseModel):
    content: Optional[str] = None
    entry_type: Optional[Literal["update", "decision", "blocker", "note"]] = None
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    reminder_date: Optional[date] = None


class EntryOut(EntryBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class NoteTabOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    content: str
    updated_at: datetime


class NoteTabUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None


class TaskBase(BaseModel):
    title: str
    status: Literal["new", "inprogress", "blocked", "closed"] = "new"
    due_date: Optional[date] = None
    project_id: Optional[int] = None
    recurrence: Literal["none", "daily", "weekly", "monthly"] = "none"
    recurrence_day: Optional[str] = None
    tags: Optional[str] = None


class TaskCreate(TaskBase):
    pass


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[Literal["new", "inprogress", "blocked", "closed"]] = None
    due_date: Optional[date] = None
    project_id: Optional[int] = None
    recurrence: Optional[Literal["none", "daily", "weekly", "monthly"]] = None
    recurrence_day: Optional[str] = None
    tags: Optional[str] = None


class TaskOut(TaskBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    completed_at: Optional[datetime] = None
    archived: bool = False
    archived_at: Optional[datetime] = None


class FileLinkBase(BaseModel):
    path: str
    description: Optional[str] = None
    project_id: Optional[int] = None
    tags: Optional[str] = None


class FileLinkCreate(FileLinkBase):
    pass


class FileLinkUpdate(BaseModel):
    path: Optional[str] = None
    description: Optional[str] = None
    project_id: Optional[int] = None
    tags: Optional[str] = None


class FileLinkOut(FileLinkBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class BoardBase(BaseModel):
    name: str
    project_id: Optional[int] = None
    direction: Literal["TD", "LR"] = "TD"


class BoardCreate(BoardBase):
    nodes: list[dict] = []
    edges: list[dict] = []
    groups: list[dict] = []


class BoardUpdate(BaseModel):
    name: Optional[str] = None
    project_id: Optional[int] = None
    direction: Optional[Literal["TD", "LR"]] = None
    nodes: Optional[list[dict]] = None
    edges: Optional[list[dict]] = None
    groups: Optional[list[dict]] = None


class BoardOut(BoardBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nodes: list[dict] = []
    edges: list[dict] = []
    groups: list[dict] = []
    updated_at: datetime

    @field_validator("nodes", "edges", "groups", mode="before")
    @classmethod
    def _parse_json(cls, v):
        if not v:
            return []
        return json.loads(v) if isinstance(v, str) else v


class LearnItemBase(BaseModel):
    title: str = "Untitled"
    source_text: str = ""


class LearnItemCreate(LearnItemBase):
    pass


class LearnItemUpdate(BaseModel):
    title: Optional[str] = None
    source_text: Optional[str] = None
    summary: Optional[str] = None
    chunks: Optional[list[dict]] = None
    mermaid: Optional[str] = None
    quiz: Optional[list[dict]] = None


class LearnItemOut(LearnItemBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    summary: Optional[str] = None
    chunks: list[dict] = []
    mermaid: Optional[str] = None
    quiz: list[dict] = []
    checks: Optional[dict] = None
    checked_at: Optional[datetime] = None
    updated_at: datetime

    @field_validator("chunks", "quiz", mode="before")
    @classmethod
    def _parse_json(cls, v):
        if not v:
            return []
        return json.loads(v) if isinstance(v, str) else v

    @field_validator("checks", mode="before")
    @classmethod
    def _parse_checks(cls, v):
        if not v:
            return None
        return json.loads(v) if isinstance(v, str) else v


class LearnImportUrl(BaseModel):
    url: str


class SettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    ollama_model: Optional[str] = None
    profile_name: Optional[str] = None
    profile_role: Optional[str] = None
    profile_context: Optional[str] = None
    ai_provider: str = "ollama"
    claude_api_key_set: bool = False
    claude_status: Optional[str] = None
    claude_status_detail: Optional[str] = None
    claude_status_checked_at: Optional[datetime] = None
    backup_schedule: str = "off"
    backup_local_retention: int = 10
    backup_last_run_at: Optional[datetime] = None
    backup_last_status: Optional[str] = None
    backup_last_detail: Optional[str] = None
    b2_key_id: Optional[str] = None
    b2_bucket_name: Optional[str] = None
    b2_application_key_set: bool = False
    b2_status: Optional[str] = None
    b2_status_detail: Optional[str] = None
    b2_status_checked_at: Optional[datetime] = None


class SettingsUpdate(BaseModel):
    ollama_model: Optional[str] = None
    profile_name: Optional[str] = None
    profile_role: Optional[str] = None
    profile_context: Optional[str] = None
    ai_provider: Optional[Literal["ollama", "claude"]] = None
    claude_api_key: Optional[str] = None
    backup_schedule: Optional[Literal["off", "hourly", "daily", "weekly"]] = None
    backup_local_retention: Optional[int] = None
    b2_key_id: Optional[str] = None
    b2_application_key: Optional[str] = None
    b2_bucket_name: Optional[str] = None


class ClaudeTestRequest(BaseModel):
    api_key: Optional[str] = None


class B2TestRequest(BaseModel):
    key_id: Optional[str] = None
    application_key: Optional[str] = None
    bucket_name: Optional[str] = None


class AgentBase(BaseModel):
    name: str
    description: Optional[str] = None
    system_prompt: str
    context_mode: Literal["none", "digest"] = "none"
    ai_provider: Literal["ollama", "claude"] = "ollama"
    run_after_agent_id: Optional[int] = None
    enabled_skills: Optional[str] = None  # comma-separated: create_task,complete_task,log_entry


class AgentCreate(AgentBase):
    pass


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    context_mode: Optional[Literal["none", "digest"]] = None
    ai_provider: Optional[Literal["ollama", "claude"]] = None
    run_after_agent_id: Optional[int] = None
    enabled_skills: Optional[str] = None


class AgentOut(AgentBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    run_after_agent_name: Optional[str] = None


class ToolCallOut(BaseModel):
    tool: str
    args: dict
    result: str
    is_error: bool = False


class AgentRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agent_id: int
    output: str
    tool_calls: list[ToolCallOut] = []
    context_start: Optional[date] = None
    context_end: Optional[date] = None
    created_at: datetime

    @field_validator("tool_calls", mode="before")
    @classmethod
    def _parse_tool_calls(cls, v):
        if not v:
            return []
        return json.loads(v) if isinstance(v, str) else v


class SecurityCheckResultOut(BaseModel):
    check: str
    status: str
    detail: str


class SecurityCheckRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    results: list[SecurityCheckResultOut]
    created_at: datetime

    @field_validator("results", mode="before")
    @classmethod
    def _parse_results(cls, v):
        if not v:
            return []
        return json.loads(v) if isinstance(v, str) else v
