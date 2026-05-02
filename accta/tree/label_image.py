"""QAngio stage 10-labeling: render coronary segment labels back into volume space."""

from __future__ import annotations

import networkx as nx
import numpy as np
import SimpleITK as sitk


def render_label_volume(
    branch_graph: nx.Graph,
    reference_image: sitk.Image,
    label_attribute: str = "label",
) -> sitk.Image:
    """Burn coronary segment labels from *branch_graph* into a label volume.

    Each edge in *branch_graph* carries a ``label_attribute`` value that
    identifies its anatomical segment (e.g. ``"LAD"``, ``"LCX"``, ``"RCA"``).
    This function rasterises those labels onto the voxel grid of
    *reference_image*.

    Parameters
    ----------
    branch_graph:
        Fully labelled coronary graph (post stage 10-labeling).
    reference_image:
        Image whose geometry (size, spacing, origin, direction) defines the
        output volume.
    label_attribute:
        Name of the edge attribute holding segment label strings.

    Returns
    -------
    sitk.Image
        Integer label volume aligned to *reference_image*.
    """
    raise NotImplementedError
