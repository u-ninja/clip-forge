"""Process lifecycle helpers. The desktop runtime owns the worker; these keep it from outliving it."""

import logging
import os
import signal
import sys
import threading
from collections.abc import Callable

PARENT_CHECK_SECONDS = 2.0

log = logging.getLogger("worker.lifecycle")


def parent_alive(pid: int) -> bool:
    """POSIX only. On Windows os.kill(pid, 0) would *terminate* the process, so never call it there."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    return True


def watch_parent(
    pid: int,
    on_exit: Callable[[], None] | None = None,
    interval: float = PARENT_CHECK_SECONDS,
) -> threading.Thread | None:
    """Calls `on_exit` (default: SIGTERM to self, so uvicorn shuts down gracefully) once `pid` is gone.

    Windows: not supported here; the desktop runtime kills the process tree explicitly instead.
    """
    if sys.platform == "win32":
        return None
    stop = on_exit or (lambda: os.kill(os.getpid(), signal.SIGTERM))

    def loop() -> None:
        event = threading.Event()
        while not event.wait(interval):
            if not parent_alive(pid):
                log.warning("parent process %s exited; shutting down", pid)
                stop()
                return

    thread = threading.Thread(target=loop, name="parent-watchdog", daemon=True)
    thread.start()
    return thread
