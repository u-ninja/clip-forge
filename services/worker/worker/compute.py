"""Compute backend detection. Model code asks for a backend here instead of checking the OS itself.

Detection is deliberately cheap (no torch import) so the worker starts fast with no AI deps installed.
"""

import platform
import shutil
from typing import Literal

from pydantic import BaseModel

Backend = Literal["cuda", "metal", "cpu"]


class ComputeInfo(BaseModel):
    backend: Backend
    platform: str
    machine: str


def detect_backend(system: str | None = None, machine: str | None = None) -> ComputeInfo:
    system = system or platform.system()
    machine = machine or platform.machine()
    backend: Backend
    if system == "Darwin" and machine == "arm64":
        backend = "metal"
    elif shutil.which("nvidia-smi"):
        # shortcut: presence of nvidia-smi only, not a VRAM/driver check; replace when a model loader lands.
        backend = "cuda"
    else:
        backend = "cpu"
    return ComputeInfo(backend=backend, platform=system, machine=machine)
