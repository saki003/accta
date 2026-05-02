"""Cooperative cancellation for long-running pipeline steps.

CPU-bound work runs in a thread pool, so true preemption isn't safe.  Instead
we register a per-(step,uid) ``threading.Event``; the worker checks it at
boundaries between expensive operations and raises ``Cancelled`` to abort.

Cancellation latency = duration of the longest single non-checked block.
For Frangi that's one sigma-scale (~30–60 s on a typical CT volume).
"""

from __future__ import annotations

import threading


class Cancelled(Exception):
    """Raised when a worker observes its cancellation event has been set."""


_events: dict[str, threading.Event] = {}
_lock = threading.Lock()


def _key(step: str, uid: str) -> str:
    return f"{step}:{uid}"


def register(step: str, uid: str) -> threading.Event:
    """Register (or reset) a cancel event for the given step+uid."""
    ev = threading.Event()
    with _lock:
        _events[_key(step, uid)] = ev
    return ev


def cancel(step: str, uid: str) -> bool:
    """Mark the event so the worker raises ``Cancelled`` at its next checkpoint."""
    with _lock:
        ev = _events.get(_key(step, uid))
    if ev is None:
        return False
    ev.set()
    return True


def clear(step: str, uid: str) -> None:
    """Remove a finished step's event from the registry."""
    with _lock:
        _events.pop(_key(step, uid), None)


def check(ev: threading.Event | None) -> None:
    """Raise ``Cancelled`` if the event is set.  No-op if event is None."""
    if ev is not None and ev.is_set():
        raise Cancelled()
