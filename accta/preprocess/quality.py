"""Motion and artifact quality assessment from the preprocessed volume."""

from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger(__name__)


def assess_quality(
    arr_iso: np.ndarray,
    cardiac_roi: np.ndarray,
    central_blood_pool: np.ndarray,
) -> dict:
    """Compute motion/artifact quality metrics from the preprocessed volume.

    Parameters
    ----------
    arr_iso:
        Isotropic float32 HU array (Z×Y×X) after clipping and denoising.
    cardiac_roi:
        Boolean mask of the dilated cardiac ROI.
    central_blood_pool:
        Boolean mask of the kept blood-pool components.

    Returns
    -------
    dict with keys:
        sharpness        – 0–1, Tenengrad edge strength in cardiac ROI
        z_consistency    – 0–1, slice-to-slice continuity (1 = no stair-step)
        blood_pool_snr   – mean/std within blood pool (higher is better)
        flag             – "pass" | "warn" | "fail"
        issues           – list of human-readable issue strings
    """
    # ------------------------------------------------------------------
    # 1. Sharpness — Tenengrad score within cardiac ROI
    # ------------------------------------------------------------------
    gz, gy, gx = np.gradient(arr_iso.astype(np.float64))
    grad_sq = gz ** 2 + gy ** 2 + gx ** 2

    if cardiac_roi.any():
        tenengrad = float(np.mean(grad_sq[cardiac_roi]))
    else:
        tenengrad = 0.0

    # Sigmoid-style normalisation: reference tuned for typical coronary CTA
    # (good scans ~4000–8000 HU²/vox², poor motion blur <1000)
    _ref = 4000.0
    sharpness = round(tenengrad / (tenengrad + _ref), 3)

    # ------------------------------------------------------------------
    # 2. Z-consistency — stair-step / respiratory motion
    # ------------------------------------------------------------------
    roi_z = cardiac_roi[:-1] & cardiac_roi[1:]
    roi_y = cardiac_roi[:, :-1] & cardiac_roi[:, 1:]
    roi_x = cardiac_roi[:, :, :-1] & cardiac_roi[:, :, 1:]

    z_diff = float(np.abs(arr_iso[1:] - arr_iso[:-1])[roi_z].mean()) if roi_z.any() else 1.0
    y_diff = float(np.abs(arr_iso[:, 1:] - arr_iso[:, :-1])[roi_y].mean()) if roi_y.any() else 1.0
    x_diff = float(np.abs(arr_iso[:, :, 1:] - arr_iso[:, :, :-1])[roi_x].mean()) if roi_x.any() else 1.0
    inplane = (y_diff + x_diff) / 2.0

    # Score approaches 1 when z variation ≈ in-plane variation (isotropic texture)
    # Drops toward 0 when z >> in-plane (stair-step artifact)
    z_consistency = round(float(np.clip(inplane / (z_diff + 1e-6), 0.0, 1.0)), 3)

    # ------------------------------------------------------------------
    # 3. Blood pool SNR
    # ------------------------------------------------------------------
    bp_vals = arr_iso[central_blood_pool].astype(np.float64)
    if bp_vals.size > 50:
        blood_pool_snr = round(float(np.mean(bp_vals)) / (float(np.std(bp_vals)) + 1e-6), 2)
    else:
        blood_pool_snr = 0.0

    # ------------------------------------------------------------------
    # 4. Flag
    # ------------------------------------------------------------------
    issues: list[str] = []

    if sharpness < 0.25:
        issues.append("significant motion blur")
    elif sharpness < 0.40:
        issues.append("mild motion blur")

    if z_consistency < 0.50:
        issues.append("respiratory motion detected")
    elif z_consistency < 0.70:
        issues.append("possible respiratory motion")

    if blood_pool_snr < 3.0:
        issues.append("poor blood pool SNR — check contrast timing")
    elif blood_pool_snr < 6.0:
        issues.append("low blood pool SNR")

    severe = {"significant motion blur", "respiratory motion detected", "poor blood pool SNR — check contrast timing"}
    if any(i in severe for i in issues):
        flag = "fail"
    elif issues:
        flag = "warn"
    else:
        flag = "pass"

    logger.info(
        "quality: sharpness=%.3f z_consistency=%.3f snr=%.1f flag=%s",
        sharpness, z_consistency, blood_pool_snr, flag,
    )

    return {
        "sharpness": sharpness,
        "z_consistency": z_consistency,
        "blood_pool_snr": blood_pool_snr,
        "flag": flag,
        "issues": issues,
    }
