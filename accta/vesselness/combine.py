"""Combine Frangi vesselness with HU likelihood, ROI, and chamber penalties."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import binary_erosion, binary_dilation


def combine_vesselness(
    vesselness: np.ndarray,
    hu_arr: np.ndarray,
    cardiac_roi: np.ndarray,
    central_blood_pool: np.ndarray,
    hu_target: float = 300.0,
    hu_sigma: float = 120.0,
    vesselness_weight: float = 0.70,
    hu_weight: float = 0.30,
    chamber_erosion_iters: int = 2,
    chamber_penalty: float = 0.02,
    wall_dilation_iters: int = 2,
    wall_penalty: float = 0.3,
) -> np.ndarray:
    """Produce a combined vessel index VI(x) from Frangi output and image context.

    Pipeline
    --------
    1. **HU likelihood** — Gaussian centred at *hu_target* rewards voxels in
       the contrast-enhanced blood HU range and penalises calcium, air, and
       soft tissue.  Tighter sigma (120 HU) than before to better separate
       myocardium (~70 HU) from enhanced blood (~300 HU).
    2. **Weighted combination** — ``VI = (1 − w) · VF + w · HU_like``.
    3. **ROI mask** — voxels outside the dilated cardiac ROI are zeroed.
    4. **Deep-chamber penalty** — voxels deep inside blood-pool chambers are
       heavily suppressed (large-scale Frangi leakage from smooth walls).
    5. **Wall-shell penalty** — the thin shell just outside the eroded chamber
       (where Frangi wall response is highest) receives a partial penalty.
       Shell = dilation(pool, wall_dilation) & ~pool.

    Parameters
    ----------
    vesselness:
        Float32 array from the geometry-weighted Frangi step, values in [0,1].
    hu_arr:
        Float32 HU array (same shape, clipped/denoised iso volume).
    cardiac_roi:
        Boolean mask of the dilated cardiac ROI from preprocessing.
    central_blood_pool:
        Boolean mask of the kept blood-pool components (chambers + aorta).
    hu_target:
        HU value of peak likelihood.
    hu_sigma:
        Standard deviation of HU likelihood Gaussian (HU units).
    hu_weight:
        Blend weight for HU likelihood vs vesselness.
    chamber_erosion_iters:
        Erosion iterations to find deep-interior chamber voxels.
    chamber_penalty:
        Multiplier applied to deep-chamber voxels.
    wall_dilation_iters:
        Dilation iterations applied to blood pool to define the wall shell.
    wall_penalty:
        Multiplier applied to wall-shell voxels.
    """
    hu_like = np.exp(
        -0.5 * ((hu_arr.astype(np.float64) - hu_target) / hu_sigma) ** 2
    ).astype(np.float32)

    combined = (vesselness_weight * vesselness + hu_weight * hu_like).astype(np.float32)

    # Zero outside cardiac ROI
    combined[~cardiac_roi] = 0.0

    if central_blood_pool.any():
        # Deep-chamber: fully inside (eroded)
        if chamber_erosion_iters > 0:
            deep_chamber = binary_erosion(central_blood_pool, iterations=chamber_erosion_iters)
            combined[deep_chamber] *= chamber_penalty

        # Wall shell: just outside the blood pool surface
        if wall_dilation_iters > 0:
            dilated = binary_dilation(central_blood_pool, iterations=wall_dilation_iters)
            wall_shell = dilated & ~central_blood_pool
            combined[wall_shell] *= wall_penalty

    np.clip(combined, 0.0, 1.0, out=combined)
    return combined
