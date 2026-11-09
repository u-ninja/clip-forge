"""Worker settings, validated once at startup."""

import os
from typing import Literal

from pydantic import BaseModel, Field

DEFAULT_PORT = 4318  # keep in sync with DEFAULT_WORKER_PORT in packages/shared


class WorkerSettings(BaseModel):
    # Loopback only: the worker is an internal service reached through the API.
    host: Literal["127.0.0.1", "::1", "localhost"] = "127.0.0.1"
    port: int = Field(default=DEFAULT_PORT, ge=1024, le=65535)
    max_concurrent_jobs: int = Field(default=1, ge=1, le=4)  # 16GB baseline: one heavy job at a time
    # PID of the owning desktop process; the worker exits when it disappears (orphan protection).
    parent_pid: int | None = Field(default=None, ge=1)


def load_settings(env: dict[str, str] | None = None) -> WorkerSettings:
    env = dict(os.environ) if env is None else env
    raw = {
        "host": env.get("CLIPFORGE_WORKER_HOST"),
        "port": env.get("CLIPFORGE_WORKER_PORT"),
        "max_concurrent_jobs": env.get("CLIPFORGE_WORKER_MAX_JOBS"),
        "parent_pid": env.get("CLIPFORGE_PARENT_PID"),
    }
    return WorkerSettings.model_validate({k: v for k, v in raw.items() if v is not None})
