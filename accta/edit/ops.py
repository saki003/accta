"""QAngio stage 12-edit: atomic editing operations on the coronary centreline graph."""

from __future__ import annotations

from typing import Any

import networkx as nx
import numpy as np


def delete_branch(graph: nx.Graph, edge_ids: list[tuple[int, int]]) -> nx.Graph:
    """Remove one or more branch edges from *graph*.

    Parameters
    ----------
    graph:
        Current coronary graph.
    edge_ids:
        List of ``(u, v)`` edge tuples to remove.

    Returns
    -------
    nx.Graph
        Modified graph with the specified edges deleted.
    """
    raise NotImplementedError


def add_branch(
    graph: nx.Graph,
    path_points: np.ndarray,
    label: str,
) -> nx.Graph:
    """Insert a new branch defined by *path_points* into *graph*.

    Parameters
    ----------
    graph:
        Current coronary graph.
    path_points:
        ``(N, 3)`` array of ordered physical-space points (mm) defining the
        new branch centreline.
    label:
        Anatomical segment label to assign to the new branch.

    Returns
    -------
    nx.Graph
        Modified graph with the new branch inserted.
    """
    raise NotImplementedError


def relabel_branch(
    graph: nx.Graph,
    edge_ids: list[tuple[int, int]],
    new_label: str,
) -> nx.Graph:
    """Change the anatomical label of one or more edges in *graph*.

    Parameters
    ----------
    graph:
        Current coronary graph.
    edge_ids:
        Edges whose ``"label"`` attribute should be updated.
    new_label:
        Replacement label string.

    Returns
    -------
    nx.Graph
        Modified graph with updated edge labels.
    """
    raise NotImplementedError
