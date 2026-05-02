"""QAngio stage 7-ostia: detect the left and right coronary ostia on the aortic root."""

from __future__ import annotations

from typing import Any

import numpy as np
import SimpleITK as sitk


def detect_ostia(
    aorta_centerline: Any,
    blood_pool_mask: sitk.Image,
    ct_volume: sitk.Image,
) -> dict[str, np.ndarray]:
    """Locate the left (LCA) and right (RCA) coronary ostia on the aortic root.

    Searches the aortic root region for diverging vascular branches whose
    orientation and size are consistent with coronary ostia, returning
    physical-space coordinates for each ostium.

    Parameters
    ----------
    aorta_centerline:
        Ordered centreline points of the ascending aorta (mm).
    blood_pool_mask:
        Full blood-pool binary mask.
    ct_volume:
        Original CT volume for intensity context.

    Returns
    -------
    dict[str, np.ndarray]
        ``{"LCA": array([x, y, z]), "RCA": array([x, y, z])}`` in mm.
    """
    raise NotImplementedError
