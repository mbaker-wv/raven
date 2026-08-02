#!/bin/bash
cd "$(dirname "$0")"
.venv/bin/python -m uvicorn app.main:app --port 8000
