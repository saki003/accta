"""Thread-safe in-process study store.

Supports two entry states:
  • loading  — metadata known, pixel array not yet ready (background I/O)
  • ready    — full numpy array available

Slice/MPR endpoints call ``wait_ready()`` which blocks their executor thread
until the background loader finishes (or times out), keeping the event loop free.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np


class StudyStore:
    """Singleton store for loaded CT volumes."""

    _instance: "StudyStore | None" = None
    _instance_lock: threading.Lock = threading.Lock()

    def __new__(cls) -> "StudyStore":
        with cls._instance_lock:
            if cls._instance is None:
                inst = super().__new__(cls)
                inst._data: dict[str, dict[str, Any]] = {}
                inst._lock = threading.Lock()
                cls._instance = inst
        return cls._instance

    # ------------------------------------------------------------------
    # Write — eager (full array known up-front)
    # ------------------------------------------------------------------

    def add(
        self,
        uid: str,
        arr: np.ndarray,
        spacing: tuple[float, float, float],
        origin: tuple[float, float, float],
        direction: tuple[float, ...],
        name: str = "",
    ) -> None:
        if arr.dtype != np.float32:
            arr = arr.astype(np.float32)

        event = threading.Event()
        event.set()  # already ready

        entry: dict[str, Any] = {
            "uid": uid,
            "name": name,
            "arr": arr,
            "spacing": tuple(float(s) for s in spacing),
            "origin": tuple(float(o) for o in origin),
            "direction": tuple(float(d) for d in direction),
            "shape": arr.shape,
            "hu_min": float(arr.min()),
            "hu_max": float(arr.max()),
            "_ready": event,
        }

        with self._lock:
            self._data[uid] = entry

    # ------------------------------------------------------------------
    # Write — lazy (metadata now, pixels later)
    # ------------------------------------------------------------------

    def add_stub(
        self,
        uid: str,
        shape: tuple[int, int, int],
        spacing: tuple[float, float, float],
        origin: tuple[float, float, float],
        direction: tuple[float, ...],
        name: str = "",
    ) -> None:
        """Register a study with metadata only; pixel array follows via ``set_array``."""
        event = threading.Event()

        entry: dict[str, Any] = {
            "uid": uid,
            "name": name,
            "arr": None,         # not yet loaded
            "spacing": tuple(float(s) for s in spacing),
            "origin": tuple(float(o) for o in origin),
            "direction": tuple(float(d) for d in direction),
            "shape": shape,
            "hu_min": -1024.0,   # placeholder until array is ready
            "hu_max": 3071.0,
            "_ready": event,
        }

        with self._lock:
            self._data[uid] = entry

    def set_array(self, uid: str, arr: np.ndarray) -> None:
        """Called by the background loader when pixel data is ready."""
        if arr.dtype != np.float32:
            arr = arr.astype(np.float32)

        with self._lock:
            entry = self._data.get(uid)
            if entry is None:
                return
            entry["arr"] = arr
            entry["shape"] = arr.shape
            entry["hu_min"] = float(arr.min())
            entry["hu_max"] = float(arr.max())
            entry["_ready"].set()

    def wait_ready(self, uid: str, timeout: float = 300.0) -> bool:
        """Block until the study's pixel array is available.  Returns True on success."""
        with self._lock:
            entry = self._data.get(uid)
        if entry is None:
            return False
        return entry["_ready"].wait(timeout)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def get(self, uid: str) -> dict[str, Any] | None:
        with self._lock:
            return self._data.get(uid)

    def remove(self, uid: str) -> bool:
        with self._lock:
            if uid in self._data:
                del self._data[uid]
                return True
            return False

    def list_studies(self) -> list[dict[str, Any]]:
        with self._lock:
            out: list[dict[str, Any]] = []
            for entry in self._data.values():
                out.append({
                    "uid": entry["uid"],
                    "name": entry["name"],
                    "shape": list(entry["shape"]),
                    "spacing": list(entry["spacing"]),
                    "hu_range": [entry["hu_min"], entry["hu_max"]],
                    "loading": entry["arr"] is None,
                })
            return out


store = StudyStore()
