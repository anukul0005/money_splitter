"""Live notes from deep inside a background import ("the AI is rate-limited,
waiting 20s") to the job running it, so its progress panel can say why it
is slow instead of looking stuck. A job sets a listener for its thread
(routers/expenses.py); everywhere else note() does nothing."""
from __future__ import annotations

import threading

_local = threading.local()


def listen(fn) -> None:
    """Send this thread's notes to fn(message); None stops."""
    _local.fn = fn


def note(message: str) -> None:
    fn = getattr(_local, "fn", None)
    if fn:
        try:
            fn(message)
        except Exception:
            pass
