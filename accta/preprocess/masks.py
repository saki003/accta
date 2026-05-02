"""Cardiac ROI masking before vesselness filtering."""

from __future__ import annotations

import logging
from typing import Callable

import numpy as np
from scipy import ndimage as ndi

logger = logging.getLogger(__name__)


def create_cardiac_roi(
    original_hu: np.ndarray,
    processing_hu: np.ndarray,
    spacing_mm: float,
    blood_pool_threshold: float = 160.0,
    lung_threshold: float = -500.0,
    roi_margin_mm: float = 25.0,
    background_fill: float = -200.0,
    on_masks_done: "Callable[[], None] | None" = None,
) -> dict[str, np.ndarray]:
    """Build a cardiac ROI mask and apply it to the processing volume.

    Parameters
    ----------
    original_hu:
        Native HU array (float32, shape Z×Y×X) — used for thresholding.
    processing_hu:
        Clipped/resampled HU array — will have the ROI mask applied.
    spacing_mm:
        Isotropic voxel spacing in mm (used to convert margin to voxels).
    blood_pool_threshold:
        Voxels above this HU are considered blood pool / calcium.
    lung_threshold:
        Voxels below this HU are considered lung / air.
    roi_margin_mm:
        Dilation margin around the central blood pool in mm.
    background_fill:
        Value assigned to voxels outside the cardiac ROI in the output.

    Returns
    -------
    dict with keys:
        blood_pool_mask      – cleaned binary blood-pool mask
        central_blood_pool   – top-5 largest connected components
        lung_mask            – cleaned binary lung mask
        cardiac_roi          – dilated ROI used to gate Frangi input
        processing_for_vesselness – processing_hu with non-ROI voxels set to background_fill
    """
    # --- Lung mask ---
    lung_mask = original_hu < lung_threshold
    lung_mask = ndi.binary_closing(lung_mask, iterations=2)
    lung_mask = ndi.binary_fill_holes(lung_mask)

    # --- Blood pool mask ---
    blood_pool_mask = original_hu > blood_pool_threshold
    blood_pool_mask = ndi.binary_opening(blood_pool_mask, iterations=1)
    blood_pool_mask = ndi.binary_closing(blood_pool_mask, iterations=2)

    # --- Keep top-5 largest connected blood-pool components ---
    labels, n = ndi.label(blood_pool_mask)
    if n == 0:
        logger.warning(
            "No blood-pool components found at threshold %.0f HU — "
            "skipping ROI masking and returning processing_hu unchanged.",
            blood_pool_threshold,
        )
        return {
            "blood_pool_mask": blood_pool_mask,
            "central_blood_pool": blood_pool_mask,
            "lung_mask": lung_mask,
            "cardiac_roi": np.ones_like(original_hu, dtype=bool),
            "processing_for_vesselness": processing_hu.copy(),
        }

    sizes = ndi.sum(blood_pool_mask, labels, index=np.arange(1, n + 1))

    # Cardiac spatial bounds: middle 60% of Z (superior-inferior),
    # middle 60% of Y (anterior-posterior), middle 70% of X (left-right).
    # Components whose centroid falls outside these bounds are extracardiac
    # (e.g. IVC, portal vein, bowel) and are discarded before size ranking.
    nz, ny, nx = original_hu.shape
    z_lo, z_hi = 0.20 * nz, 0.80 * nz
    y_lo, y_hi = 0.20 * ny, 0.80 * ny
    x_lo, x_hi = 0.15 * nx, 0.85 * nx

    cardiac_labels = []
    for lbl in range(1, n + 1):
        mask_lbl = labels == lbl
        cz, cy, cx = ndi.center_of_mass(mask_lbl)
        if z_lo <= cz <= z_hi and y_lo <= cy <= y_hi and x_lo <= cx <= x_hi:
            cardiac_labels.append(lbl)

    if not cardiac_labels:
        # Spatial filter rejected everything — fall back to global top-5 with a warning
        logger.warning(
            "Spatial filter removed all blood-pool components; "
            "falling back to top-5 by size. Check scan FOV or lower blood_pool_threshold."
        )
        cardiac_labels = list((np.argsort(sizes)[-5:] + 1).astype(int))

    # Among spatially valid components, keep the largest 5 —
    # but also require each kept component to be at least 5% the size of the
    # largest one. This removes small peripheral blobs (lymph nodes, vessels
    # stumps) whose centroids happen to fall inside the spatial bounds.
    cardiac_sizes = [(lbl, sizes[lbl - 1]) for lbl in cardiac_labels]
    cardiac_sizes.sort(key=lambda x: x[1], reverse=True)
    top5 = cardiac_sizes[:5]
    largest_size = top5[0][1] if top5 else 1
    keep_labels = [lbl for lbl, sz in top5 if sz >= 0.05 * largest_size]

    logger.info(
        "blood-pool components: %d total, %d cardiac (spatial filter), %d kept (size filter)",
        n, len(cardiac_labels), len(keep_labels),
    )

    central_blood_pool = np.isin(labels, keep_labels)

    if on_masks_done is not None:
        on_masks_done()

    # --- Dilate to create permissive cardiac ROI ---
    # Use Euclidean distance transform: O(n) and produces a true ball, unlike
    # iterative binary_dilation which is slow for large margins and diamond-shaped.
    dist_mm = ndi.distance_transform_edt(~central_blood_pool, sampling=spacing_mm)
    cardiac_roi = dist_mm <= roi_margin_mm

    # Subtract eroded lung mask (soft constraint — avoids cutting pulmonary vessels)
    eroded_lung = ndi.binary_erosion(lung_mask, iterations=2)
    cardiac_roi = cardiac_roi & (~eroded_lung)

    # --- Apply ROI to processing volume ---
    out = processing_hu.copy()
    out[~cardiac_roi] = background_fill

    logger.info(
        "cardiac ROI: %d blood-pool components kept, dilation %.1f mm, "
        "ROI covers %.1f%% of volume",
        len(keep_labels), roi_margin_mm,
        100.0 * cardiac_roi.sum() / cardiac_roi.size,
    )

    return {
        "blood_pool_mask": blood_pool_mask,
        "central_blood_pool": central_blood_pool,
        "lung_mask": lung_mask,
        "cardiac_roi": cardiac_roi,
        "processing_for_vesselness": out,
    }
