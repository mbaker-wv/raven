import json
import urllib.error
import urllib.request
from typing import Callable

from fastapi import HTTPException

from .net import SSL_CONTEXT

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
CLAUDE_MODEL = "claude-sonnet-5"
MAX_TOOL_ITERATIONS = 5


def _post(api_key: str, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(
        ANTHROPIC_API_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            detail = json.loads(body).get("error", {}).get("message", body)
        except json.JSONDecodeError:
            detail = body
        raise HTTPException(502, f"Claude API error ({exc.code}): {detail}")
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"Could not reach the Claude API: {getattr(exc, 'reason', exc)}")


def call_claude(prompt: str, api_key: str) -> str:
    data = _post(
        api_key,
        {"model": CLAUDE_MODEL, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}]},
        timeout=180,
    )
    return "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")


def call_claude_with_tools(
    prompt: str,
    api_key: str,
    tools: list[dict],
    tool_executor: Callable[[str, dict], str],
) -> tuple[str, list[dict]]:
    messages = [{"role": "user", "content": prompt}]
    tool_calls_log: list[dict] = []
    content = []

    for _ in range(MAX_TOOL_ITERATIONS):
        data = _post(
            api_key,
            {"model": CLAUDE_MODEL, "max_tokens": 4096, "messages": messages, "tools": tools},
            timeout=180,
        )
        content = data.get("content", [])
        messages.append({"role": "assistant", "content": content})

        if data.get("stop_reason") != "tool_use":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            return text, tool_calls_log

        tool_results = []
        for block in content:
            if block.get("type") != "tool_use":
                continue
            name, args = block["name"], block.get("input", {})
            try:
                result_text = tool_executor(name, args)
                is_error = False
            except HTTPException as exc:
                result_text = str(exc.detail)
                is_error = True
            except Exception as exc:
                result_text = str(exc)
                is_error = True
            tool_calls_log.append({"tool": name, "args": args, "result": result_text, "is_error": is_error})
            tool_result_block = {"type": "tool_result", "tool_use_id": block["id"], "content": result_text}
            if is_error:
                tool_result_block["is_error"] = True
            tool_results.append(tool_result_block)

        messages.append({"role": "user", "content": tool_results})

    text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
    return text or "(Agent stopped after reaching the tool-use step limit.)", tool_calls_log


def test_connection(api_key: str) -> None:
    """Minimal, cheap call used only to verify a key works — never used for routine status polling."""
    _post(
        api_key,
        {"model": CLAUDE_MODEL, "max_tokens": 8, "messages": [{"role": "user", "content": "Hi"}]},
        timeout=20,
    )
