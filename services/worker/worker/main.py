"""Worker HTTP entrypoint. Started on demand (scripts/worker.sh), never by the desktop app at launch."""

import logging
import time
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from worker.compute import ComputeInfo, detect_backend
from worker.config import load_settings

_started = time.monotonic()
_compute = detect_backend()

app = FastAPI(title="ClipForge Local worker", docs_url=None, redoc_url=None)


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["worker"]
    uptimeSeconds: int
    compute: ComputeInfo


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="worker",
        uptimeSeconds=round(time.monotonic() - _started),
        compute=_compute,
    )


if __name__ == "__main__":
    import uvicorn

    from worker.logging import configure_logging

    configure_logging()
    settings = load_settings()
    logging.getLogger("worker").info("compute backend: %s", _compute.backend)
    # log_config=None keeps uvicorn on our JSON root handler instead of its own formatter.
    uvicorn.run(app, host=settings.host, port=settings.port, log_config=None)
