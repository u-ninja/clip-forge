#!/usr/bin/env bash
# Start the Python worker on demand. Creates the venv on first run; never installs AI/GPU packages.
set -euo pipefail
cd "$(dirname "$0")/../services/worker"

PYTHON="${PYTHON:-python3}"
if [[ ! -x .venv/bin/python ]]; then
  command -v "$PYTHON" >/dev/null || { echo "error: $PYTHON not found (need Python 3.12+)" >&2; exit 1; }
  echo "Creating worker venv with $("$PYTHON" --version)"
  "$PYTHON" -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements-dev.txt
fi
exec .venv/bin/python -m worker.main
