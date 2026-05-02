"""Coronary pathfinding cost image from vesselness and supporting terms."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import binary_erosion, binary_dilation, uniform_filter


def build_cost_image(
    vesselness: np.ndarray,
    hu_arr: np.ndarray,
    scale_arr: np.ndarray,
    orientation: np.ndarray,
    cardiac_roi: np.ndarray,
    central_blood_pool: np.ndarray,
    hu_target: float = 300.0,
    hu_sigma: float = 200.0,
    sigma_min: float = 0.5,
    sigma_max: float = 3.0,
    w1: float = 0.50,
    w2: float = 0.15,
    w3: float = 0.15,
    w4: float = 0.20,
    outside_roi_penalty: float = 1.0e6,
    chamber_erosion_iters: int = 2,
    wall_dilation_iters: int = 4,
) -> np.ndarray:
    """Build an explicit additive cost image for coronary pathfinding.

    Cost function
    -------------
    cost = w1·t1  +  w2·t2  +  w3·t3  +  w4·t4   (inside ROI)
           outside_roi_penalty                       (outside ROI — hard barrier)

    t1 — inverse vesselness:   1 − vesselness          → [0, 1]
    t2 — HU distance:          1 − HU_likelihood        → [0, 1]
    t3 — curvature penalty:    orientation + scale      → [0, 1]
    t4 — leakage penalty:      near chambers / walls    → {0, 1}

    Parameters
    ----------
    vesselness:
        Coronary probability map, values in [0, 1].
    hu_arr:
        Isotropic HU array (clipped/denoised).
    scale_arr:
        Scale-of-maximum-response map (sigma in mm) from Frangi.
    orientation:
        Tube-axis eigenvector field, shape (nz, ny, nx, 3).
    cardiac_roi:
        Boolean mask of the dilated cardiac ROI.
    central_blood_pool:
        Boolean mask of kept blood-pool components.
    hu_target:
        Patient-specific blood-pool median HU.
    hu_sigma:
        HU likelihood Gaussian width.
    sigma_min / sigma_max:
        Frangi scale range used, for scale normalisation.
    w1–w4:
        Term weights for in-ROI cost; should sum to ~1.0 (not enforced).
    outside_roi_penalty:
        Cost assigned to every voxel outside the cardiac ROI (hard barrier).
    chamber_erosion_iters:
        Erosion depth for deep-chamber leakage mask.
    wall_dilation_iters:
        Dilation extent for wall-shell leakage mask.
    """
    # ------------------------------------------------------------------
    # t1 — inverse vesselness
    # ------------------------------------------------------------------
    t1 = (1.0 - vesselness).astype(np.float32)

    # ------------------------------------------------------------------
    # t2 — HU distance from coronary blood range
    # ------------------------------------------------------------------
    hu_like = np.exp(
        -0.5 * ((hu_arr.astype(np.float64) - hu_target) / hu_sigma) ** 2
    ).astype(np.float32)
    t2 = (1.0 - hu_like).astype(np.float32)

    # ------------------------------------------------------------------
    # t3 — curvature / scale penalty (two sub-terms averaged)
    # ------------------------------------------------------------------

    # Sub-term A: scale penalty — large sigma → aorta/chamber, not coronary
    scale_range = max(sigma_max - sigma_min, 1e-6)
    t3_scale = np.clip(
        (scale_arr - sigma_min) / scale_range, 0.0, 1.0
    ).astype(np.float32)

    # Sub-term B: orientation angular change — measures how sharply the tube
    # axis direction changes between neighbouring voxels (proxy for path curvature).
    # For each voxel, compute mean |1 - |dot(axis, neighbour_axis)|| over 6 faces.
    # Result ≈ 0 for straight vessels, ≈ 1 for rapidly turning or isotropic regions.
    if orientation is not None and orientation.shape[-1] == 3:
        ax = orientation.astype(np.float64)  # (nz,ny,nx,3)
        # Smooth neighbour comparison via uniform filter on each component
        angular_change = np.zeros(ax.shape[:3], dtype=np.float64)
        for shift_axis in range(3):
            for shift in (-1, 1):
                nb = np.roll(ax, shift, axis=shift_axis)
                dot = np.clip(np.abs((ax * nb).sum(axis=-1)), 0.0, 1.0)
                angular_change += (1.0 - dot)
        angular_change /= 6.0  # average over 6 neighbours → [0, 1]
        t3_orient = angular_change.astype(np.float32)
    else:
        t3_orient = np.zeros_like(t3_scale)

    t3 = (0.5 * t3_scale + 0.5 * t3_orient).astype(np.float32)

    # ------------------------------------------------------------------
    # t4 — leakage penalty near chambers / aorta walls
    # ------------------------------------------------------------------
    t4 = np.zeros(vesselness.shape, dtype=np.float32)
    if central_blood_pool.any():
        if chamber_erosion_iters > 0:
            deep = binary_erosion(central_blood_pool, iterations=chamber_erosion_iters)
            t4[deep] = 1.0
        if wall_dilation_iters > 0:
            dilated = binary_dilation(central_blood_pool, iterations=wall_dilation_iters)
            wall_shell = dilated & ~central_blood_pool
            t4[wall_shell] = np.maximum(t4[wall_shell], 0.6)

    # ------------------------------------------------------------------
    # Combine in-ROI terms (t1–t4 only); outside-ROI is handled separately
    # ------------------------------------------------------------------
    cost = (
        w1 * t1
        + w2 * t2
        + w3 * t3
        + w4 * t4
    ).astype(np.float32)

    # Hard barrier outside the cardiac ROI — the pathfinder must never route
    # through tissue outside the ROI.  1e6 >> any in-ROI cost (~0–1) so no
    # multi-step shortcut through exterior tissue can compete with the vessel.
    cost[~cardiac_roi] = outside_roi_penalty

    return cost
