"""Shared graph utilities for the accta coronary tree (used across stages 8–10)."""

from __future__ import annotations

from typing import Any

import networkx as nx
import numpy as np


def prune_short_branches(graph: nx.Graph, min_length_mm: float = 2.0) -> nx.Graph:
    """Remove leaf branches shorter than *min_length_mm* from *graph*.

    Parameters
    ----------
    graph:
        Coronary spatial graph with ``"pos"`` node attributes (mm).
    min_length_mm:
        Branches whose Euclidean arc length is below this threshold are pruned.

    Returns
    -------
    nx.Graph
        Pruned copy of *graph*.
    """
    raise NotImplementedError


def smooth_centerline(path: np.ndarray, window: int = 5) -> np.ndarray:
    """Apply a sliding-window smoothing pass to an ordered centreline path.

    Parameters
    ----------
    path:
        ``(N, 3)`` array of centreline points in mm.
    window:
        Number of neighbouring points to average (must be odd).

    Returns
    -------
    np.ndarray
        Smoothed ``(N, 3)`` centreline array.
    """
    raise NotImplementedError
