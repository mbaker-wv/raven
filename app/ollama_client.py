import json
import os
import urllib.error
import urllib.request

from fastapi import HTTPException
from sqlalchemy.orm import Session

from . import models

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")


def get_active_model(db: Session) -> str:
    settings = db.query(models.Settings).first()
    if settings and settings.ollama_model:
        return settings.ollama_model
    return DEFAULT_MODEL


def list_models() -> list[str]:
    req = urllib.request.Request(f"{OLLAMA_HOST}/api/tags")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise HTTPException(
            502, f"Could not reach Ollama at {OLLAMA_HOST} (is it running? try `ollama serve`): {getattr(exc, 'reason', exc)}"
        )
    return [m["name"] for m in data.get("models", [])]


def call_ollama(prompt: str, model: str) -> str:
    payload = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode()
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise HTTPException(
            502, f"Could not reach Ollama at {OLLAMA_HOST} (is it running? try `ollama serve`): {getattr(exc, 'reason', exc)}"
        )
    return result.get("response", "")
