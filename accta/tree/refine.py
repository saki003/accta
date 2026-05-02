"""QAngio stage 9-gap-bridge: close skeleton gaps caused by calcified or stenotic segments."""

from __future__ import annotations

import networkx as nx
import SimpleITK as sitk


def bridge_gaps(
    branch_graph: nx.Graph,
    vesselness: sitk.Image,
    max_gap_mm: float = 5.0,
) -> nx.Graph:
    """Detect and close short discontinuities in the coronary skeleton graph.

    For each pair of dangling endpoints separated by less than *max_gap_mm*,
    evaluates a candidate bridging path through the vesselness volume and
    inserts it into *branch_graph* when the mean response exceeds a threshold.

    Parameters
    ----------
    branch_graph:
        Spatial graph produced by stage 8-skeleton, potentially containing gaps.
    vesselness:
        Vesselness response used to score candidate bridge paths.
    max_gap_mm:
        Maximum Euclidean distance (mm) between endpoints to attempt bridging.

    Returns
    -------
    nx.Graph
        Updated graph with gap-bridging edges inserted.
    """
    raise NotImplementedError
