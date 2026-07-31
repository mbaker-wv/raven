@echo off
cd /d "%~dp0"
start "" http://localhost:8000
.venv\Scripts\python -m uvicorn app.main:app --port 8000
pause
