"""QAngio stage 6-aorta (sub-step): extract the aortic centreline path."""

from __future__ import annotations

import numpy as np
import SimpleITK as sitk
from skimage.measure import label, regionprops


def aorta_centerline(mask: sitk.Image) -> dict:
    """Compute the aortic centreline as per-slice centroids of the lumen mask.

    For each axial slice that contains at least one foreground voxel the
    centroid of the largest connected component is converted to physical
    (mm) coordinates and the equivalent-circle radius (derived from the
    component's 2-D area) is recorded.

    Parameters
    ----------
    mask:
        Binary uint8 aorta mask produced by :func:`detect_aorta`.

    Returns
    -------
    dict with two keys:

    ``"points"``
        ``[[x, y, z], ...]`` – list of physical-space centreline points
        in mm, one per non-empty axial slice, ordered inferior → superior.
    ``"radii"``
        ``[r, ...]`` – equivalent-circle radius (mm) for each point,
        derived as ``r = sqrt(area_vox / π) × spacing_xy``.
    """
    arr = sitk.GetArrayFromImage(mask)          # (nz, ny, nx), uint8
    spacing = mask.GetSpacing()                  # (sx, sy, sz) mm
    origin = mask.GetOrigin()                    # (ox, oy, oz) mm

    sp_x, sp_y, sp_z = float(spacing[0]), float(spacing[1]), float(spacing[2])
    ox, oy, oz = float(origin[0]), float(origin[1]), float(origin[2])

    points: list[list[float]] = []
    radii: list[float] = []

    for z_idx in range(arr.shape[0]):
        sl = arr[z_idx]
        if sl.sum() == 0:
            continue

        labeled = label(sl)
        props = regionprops(labeled)
        if not props:
            continue

        # Take the largest component in case the mask has small noise islands
        largest = max(props, key=lambda p: p.area)

        row_c, col_c = largest.centroid             # (row, col) = (y, x) in vox

        x_mm = ox + col_c * sp_x
        y_mm = oy + row_c * sp_y
        z_mm = oz + z_idx * sp_z

        # Equivalent-circle radius from 2-D cross-sectional area
        radius_mm = np.sqrt(float(largest.area) / np.pi) * sp_x

        points.append([x_mm, y_mm, z_mm])
        radii.append(radius_mm)

    return {"points": points, "radii": radii}
