#!/usr/bin/env python3
"""Double-clickable desktop launcher for Raven.

Starts the existing FastAPI/uvicorn server as a subprocess, waits for it to
respond, then opens it in a native window via pywebview. Closing the window
shuts the server down — no orphaned process, no terminal, no manually
opened browser tab.
"""
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import webview

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8000
STARTUP_TIMEOUT_SECONDS = 30


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
        return True


def _pick_port() -> int:
    if _port_is_free(DEFAULT_PORT):
        return DEFAULT_PORT
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_until_ready(url: str, proc: subprocess.Popen, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"Raven server exited early (code {proc.returncode}) before it was ready.")
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Raven server did not respond at {url} within {timeout:.0f}s.")


def main() -> None:
    port = _pick_port()
    base_url = f"http://127.0.0.1:{port}"

    # On Windows, spawning a console-mode python.exe child normally pops up its own
    # console window; suppress that so the server stays invisible behind the webview.
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

    server_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=REPO_ROOT,
        env={**os.environ, "RAVEN_NO_BROWSER": "1"},
        creationflags=creationflags,
    )

    try:
        _wait_until_ready(f"{base_url}/api/version", server_proc, STARTUP_TIMEOUT_SECONDS)
        webview.create_window("Raven", base_url, width=1280, height=860, min_size=(800, 600))
        webview.start()
    finally:
        if server_proc.poll() is None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # On Windows this typically runs under pythonw.exe, which has no console to
        # print to, so failures need to land somewhere the user can actually find them.
        import traceback

        log_path = REPO_ROOT / "data" / "launcher_error.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            f.write(traceback.format_exc())
        raise
