"""QAngio stage 12-edit (undo subsystem): command-history stack for reversible edits."""

from __future__ import annotations

from collections import deque
from typing import Any, Callable


class EditHistory:
    """Bounded undo/redo stack for coronary graph editing operations.

    Parameters
    ----------
    max_depth:
        Maximum number of reversible states to retain.
    """

    def __init__(self, max_depth: int = 50) -> None:
        self._undo_stack: deque[Any] = deque(maxlen=max_depth)
        self._redo_stack: deque[Any] = deque(maxlen=max_depth)

    def push(self, state_snapshot: Any) -> None:
        """Record *state_snapshot* before an edit so it can be restored.

        Parameters
        ----------
        state_snapshot:
            Serialisable representation of the graph state prior to the edit.
        """
        raise NotImplementedError

    def undo(self) -> Any:
        """Revert to the most recent snapshot and return it.

        Returns
        -------
        Any
            The restored state snapshot, or ``None`` if the stack is empty.
        """
        raise NotImplementedError

    def redo(self) -> Any:
        """Re-apply the most recently undone edit and return its snapshot.

        Returns
        -------
        Any
            The re-applied state snapshot, or ``None`` if nothing to redo.
        """
        raise NotImplementedError
