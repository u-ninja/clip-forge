import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from worker.compute import detect_backend
from worker.config import load_settings
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
