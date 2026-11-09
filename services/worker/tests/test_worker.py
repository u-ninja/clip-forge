import os
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from worker.compute import detect_backend
from worker.config import load_settings
from worker.lifecycle import parent_alive, watch_parent
from worker.main import app


def test_health():
    res = TestClient(app).get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["compute"]["backend"] in {"cuda", "metal", "cpu"}


def test_apple_silicon_maps_to_metal():
    assert detect_backend("Darwin", "arm64").backend == "metal"


def test_settings_reject_public_bind():
    with pytest.raises(ValidationError):
        load_settings({"CLIPFORGE_WORKER_HOST": "0.0.0.0"})
    assert load_settings({}).port == 4318


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX parent watchdog")
def test_parent_watchdog_fires_when_parent_exits():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    fired = threading.Event()
    watch_parent(child.pid, on_exit=fired.set, interval=0.01)
    assert fired.wait(2)
    assert parent_alive(os.getpid())


def test_settings_read_parent_pid():
    assert load_settings({"CLIPFORGE_PARENT_PID": "42"}).parent_pid == 42
    with pytest.raises(ValidationError):
        load_settings({"CLIPFORGE_PARENT_PID": "0"})
