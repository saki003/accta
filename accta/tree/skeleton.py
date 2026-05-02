"""QAngio stage 8-skeleton: skeletonise the vesselness volume into a 1-voxel-wide tree."""

from __future__ import annotations

import numpy as np
import SimpleITK as sitk


def skeletonize_vessels(
    vesselness: sitk.Image,
    threshold: float = 0.1,
) -> sitk.Image:
    """Convert a vesselness response volume to a binary skeleton.

    Thresholds *vesselness*, applies morphological thinning (3-D medial
    axis transform) to produce a single-voxel-wide vessel tree, and
    returns the result as a binary mask.

    Parameters
    ----------
    vesselness:
        Float32 vesselness response (values in ``[0, 1]``).
    threshold:
        Minimum vesselness value for a voxel to be included before thinning.

    Returns
    -------
    sitk.Image
        Binary skeleton mask (uint8) matching *vesselness* geometry.
    """
    raise NotImplementedError
