from datetime import datetime
from typing import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import models
from .claude_client import call_claude, call_claude_with_tools
from .ollama_client import call_ollama, get_active_model


def _record_claude_status(db: Session, settings: models.Settings, ok: bool, detail: str) -> None:
    settings.claude_status = "ok" if ok else "error"
    settings.claude_status_detail = detail[:500]
    settings.claude_status_checked_at = datetime.now()
    db.commit()


def call_ai(prompt: str, db: Session, provider: str | None = None) -> str:
    settings = db.query(models.Settings).first()
    if provider is None:
        provider = settings.ai_provider if settings else "ollama"

    if provider == "claude":
        if not settings or not settings.claude_api_key:
            raise HTTPException(400, "Claude is selected as the AI provider, but no API key is saved. Add one in Admin.")
        try:
            result = call_claude(prompt, settings.claude_api_key)
        except HTTPException as exc:
            _record_claude_status(db, settings, ok=False, detail=str(exc.detail))
            raise
        _record_claude_status(db, settings, ok=True, detail="Connected")
        return result

    model = get_active_model(db)
    return call_ollama(prompt, model)


def call_ai_with_tools(
    prompt: str,
    db: Session,
    tools: list[dict],
    tool_executor: Callable[[str, dict], str],
) -> tuple[str, list[dict]]:
    """Claude-only tool-use path. Caller must only invoke this when the agent's provider is 'claude'."""
    settings = db.query(models.Settings).first()
    if not settings or not settings.claude_api_key:
        raise HTTPException(400, "Claude is selected as the AI provider, but no API key is saved. Add one in Admin.")
    try:
        text, tool_calls = call_claude_with_tools(prompt, settings.claude_api_key, tools, tool_executor)
    except HTTPException as exc:
        _record_claude_status(db, settings, ok=False, detail=str(exc.detail))
        raise
    _record_claude_status(db, settings, ok=True, detail="Connected")
    return text, tool_calls
