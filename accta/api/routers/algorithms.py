"""Router: /algorithms — vesselness, blood-pool, and aorta-centerline processing."""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any

import numpy as np
import SimpleITK as sitk
from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

from accta.api.schemas import (
    AlgorithmResult, ExtractPathRequest, PathAnchorIn,
    PointValidateRequest, PreprocessRequest, VesselnessRequest,
)
from accta.api.session import store
from accta.api import cancellation
from accta.api.cancellation import Cancelled

router = APIRouter(prefix="/algorithms", tags=["algorithms"])

# Shared thread-pool for CPU-bound work so we don't block the event loop
_executor = ThreadPoolExecutor(max_workers=2)

# Per-uid preprocess progress — written by the worker thread, read by polling endpoint
_preprocess_progress: dict[str, dict] = {}  # uid → {"current": str|None, "completed": [str]}


# ---------------------------------------------------------------------------
# Internal CPU-bound workers (run in executor threads)
# ---------------------------------------------------------------------------


def _run_preprocess(entry: dict[str, Any], params: PreprocessRequest, cancel_ev: "threading.Event | None" = None) -> dict[str, Any]:
    """Resample, clip, denoise, and apply cardiac ROI masking. Stores result for vesselness."""
    from accta.preprocess.resample import resample
    from accta.preprocess.denoise import denoise_anisotropic
    from accta.preprocess.masks import create_cardiac_roi
    from accta.preprocess.quality import assess_quality
    from accta.pipeline.cache import is_valid, load_preprocess, save_preprocess

    uid = entry["uid"]
    params_dict = params.model_dump()

    # Fast path: return cached result if params haven't changed
    if is_valid(uid, "preprocess", params_dict):
        cached = load_preprocess(uid)
        if cached is not None:
            _preprocess_progress[uid] = {"current": None, "completed": ["clip", "denoise", "mask", "roi"]}
            preprocess_uid = f"preprocess_{uid}"
            store.add(preprocess_uid, cached["arr"], cached["spacing"],
                      cached["origin"], cached["direction"],
                      name=f"preprocess({entry['name']})")
            pre_entry = store.get(preprocess_uid)
            if pre_entry is not None:
                with store._lock:
                    pre_entry["cardiac_roi"]          = cached["cardiac_roi"]
                    pre_entry["central_blood_pool"]   = cached["central_blood_pool"]
                    pre_entry["blood_pool_hu_median"] = cached["blood_pool_hu_median"]
            logger.info("preprocess: loaded from cache for %s", uid)
            return {
                "preprocess_uid": preprocess_uid,
                "shape": list(cached["arr"].shape),
                "spacing": list(cached["spacing"]),
                "quality": cached["quality"],
                "from_cache": True,
            }

    arr: np.ndarray = entry["arr"]
    spacing = entry["spacing"]

    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin((float(entry["origin"][2]), float(entry["origin"][1]), float(entry["origin"][0])))
    img.SetDirection(entry["direction"])

    _preprocess_progress[uid] = {"current": "clip", "completed": []}
    native_min_mm = float(min(spacing))
    target_mm = max(native_min_mm, 0.5)
    img_iso = resample(img, target_spacing=target_mm,
                       hu_floor=params.hu_floor, hu_ceil=params.hu_ceil)
    cancellation.check(cancel_ev)

    _preprocess_progress[uid] = {"current": "denoise", "completed": ["clip"]}
    if params.enable_denoise and params.denoise_iterations > 0:
        img_iso = denoise_anisotropic(
            img_iso,
            conductance=params.denoise_conductance,
            iterations=params.denoise_iterations,
        )
    cancellation.check(cancel_ev)

    arr_iso = sitk.GetArrayFromImage(img_iso).astype(np.float32)

    resampler_orig = sitk.ResampleImageFilter()
    resampler_orig.SetReferenceImage(img_iso)
    resampler_orig.SetInterpolator(sitk.sitkLinear)
    resampler_orig.SetDefaultPixelValue(-1024.0)
    arr_orig_iso = sitk.GetArrayFromImage(resampler_orig.Execute(img)).astype(np.float32)

    _preprocess_progress[uid] = {"current": "mask", "completed": ["clip", "denoise"]}

    if params.enable_masks:
        def _on_masks_done() -> None:
            _preprocess_progress[uid] = {"current": "roi", "completed": ["clip", "denoise", "mask"]}

        masks = create_cardiac_roi(
            original_hu=arr_orig_iso,
            processing_hu=arr_iso,
            spacing_mm=target_mm,
            blood_pool_threshold=params.blood_pool_threshold,
            lung_threshold=params.lung_threshold,
            roi_margin_mm=params.roi_margin_mm,
            on_masks_done=_on_masks_done,
        )
        cancellation.check(cancel_ev)
        cardiac_roi_mask = masks["cardiac_roi"]
        central_blood_pool_mask = masks["central_blood_pool"]
        # If ROI gating is disabled, keep blood-pool mask but don't restrict
        # the processing array — pass the full denoised volume to vesselness.
        if params.enable_roi:
            proc_arr = masks["processing_for_vesselness"].astype(np.float32)
        else:
            proc_arr = arr_iso.astype(np.float32)
            cardiac_roi_mask = np.ones_like(arr_iso, dtype=bool)
    else:
        # Masks disabled — no ROI, no blood-pool segmentation.
        logger.info("preprocess: masks disabled by user — skipping blood-pool / ROI")
        proc_arr = arr_iso.astype(np.float32)
        cardiac_roi_mask = np.ones_like(arr_iso, dtype=bool)
        central_blood_pool_mask = np.zeros_like(arr_iso, dtype=bool)

    iso_spacing = (target_mm, target_mm, target_mm)
    iso_origin = tuple(float(v) for v in img_iso.GetOrigin()[::-1])
    iso_direction = img_iso.GetDirection()

    quality = assess_quality(
        arr_iso=proc_arr,
        cardiac_roi=cardiac_roi_mask,
        central_blood_pool=central_blood_pool_mask,
    )

    # Patient-specific blood-pool HU: median of original (unclipped) HU
    # within the central blood pool mask — used to centre the HU likelihood
    # in the vesselness combine step.
    if central_blood_pool_mask.any():
        bp_vals = arr_orig_iso[central_blood_pool_mask]
        blood_pool_hu_median = float(np.median(bp_vals))
    else:
        blood_pool_hu_median = 300.0
    logger.info("blood-pool median HU: %.1f", blood_pool_hu_median)

    save_preprocess(
        uid=uid,
        arr=proc_arr,
        spacing=iso_spacing,
        origin=iso_origin,
        direction=iso_direction,
        cardiac_roi=cardiac_roi_mask,
        central_blood_pool=central_blood_pool_mask,
        params=params_dict,
        quality=quality,
        blood_pool_hu_median=blood_pool_hu_median,
    )

    _preprocess_progress[uid] = {"current": None, "completed": ["clip", "denoise", "mask", "roi"]}

    preprocess_uid = f"preprocess_{uid}"
    store.add(preprocess_uid, proc_arr, iso_spacing, iso_origin, iso_direction,
              name=f"preprocess({entry['name']})")
    pre_entry = store.get(preprocess_uid)
    if pre_entry is not None:
        with store._lock:
            pre_entry["cardiac_roi"]           = cardiac_roi_mask
            pre_entry["central_blood_pool"]    = central_blood_pool_mask
            pre_entry["blood_pool_hu_median"]  = blood_pool_hu_median

    return {
        "preprocess_uid": preprocess_uid,
        "shape": list(proc_arr.shape),
        "spacing": list(iso_spacing),
        "roi_voxels": int(cardiac_roi_mask.sum()),
        "blood_pool_components": int(central_blood_pool_mask.max()) if central_blood_pool_mask.any() else 0,
        "blood_pool_hu_median": blood_pool_hu_median,
        "quality": quality,
        "from_cache": False,
    }


def _run_vesselness(entry: dict[str, Any], params: VesselnessRequest, cancel_ev: "threading.Event | None" = None) -> dict[str, Any]:
    """Multi-scale Frangi → geometric weight → HU likelihood + ROI combine."""
    from accta.preprocess.resample import resample
    from accta.vesselness.hessian import frangi_vesselness
    from accta.vesselness.geometric import geometric_weight
    from accta.vesselness.combine import combine_vesselness
    from accta.vesselness.cost import build_cost_image
    from accta.pipeline.cache import (
        is_valid, load_vesselness, save_vesselness, load_cost, save_cost,
    )

    uid = entry["uid"]
    params_dict = params.model_dump()

    # Fast path: return cached result if params haven't changed
    if is_valid(uid, "vesselness", params_dict):
        cached = load_vesselness(uid)
        if cached is not None:
            result_uid = f"vesselness_{uid}"
            store.add(result_uid, cached["arr"], cached["spacing"],
                      cached["origin"], cached["direction"],
                      name=f"vesselness({entry['name']})")
            # Restore cost image too if it's on disk so Extract Path works
            cached_cost = load_cost(uid)
            if cached_cost is not None:
                cost_uid = f"cost_{uid}"
                store.add(cost_uid, cached_cost["arr"], cached_cost["spacing"],
                          cached_cost["origin"], cached_cost["direction"],
                          name=f"cost({entry['name']})")
            logger.info("vesselness: loaded from cache for %s", uid)
            return {
                "vesselness_uid": result_uid,
                "shape": list(cached["arr"].shape),
                "percentiles": cached.get("percentiles", {}),
                "from_cache": True,
            }

    native_arr: np.ndarray = entry["arr"]
    spacing = entry["spacing"]

    img_native = sitk.GetImageFromArray(native_arr)
    img_native.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img_native.SetOrigin((float(entry["origin"][2]), float(entry["origin"][1]), float(entry["origin"][0])))
    img_native.SetDirection(entry["direction"])

    preprocess_uid = f"preprocess_{uid}"
    pre_entry = store.get(preprocess_uid)
    if pre_entry is None:
        raise HTTPException(
            status_code=409,
            detail="Preprocess must be run before vesselness. "
                   "Run /algorithms/{uid}/preprocess first.",
        )
    pre_arr    = pre_entry["arr"]
    pre_spacing = pre_entry["spacing"]
    pre_origin  = pre_entry["origin"]
    img_iso = sitk.GetImageFromArray(pre_arr)
    img_iso.SetSpacing((float(pre_spacing[2]), float(pre_spacing[1]), float(pre_spacing[0])))
    img_iso.SetOrigin((float(pre_origin[2]), float(pre_origin[1]), float(pre_origin[0])))
    img_iso.SetDirection(pre_entry["direction"])
    target_mm = float(pre_spacing[0])
    cardiac_roi        = pre_entry.get("cardiac_roi")
    central_blood_pool = pre_entry.get("central_blood_pool")
    blood_pool_hu_median = pre_entry.get("blood_pool_hu_median", 300.0)

    frangi_img, scale_img, orient_img = frangi_vesselness(
        img_iso,
        sigma_min=params.sigma_min,
        sigma_max=params.sigma_max,
        sigma_steps=params.sigma_steps,
        alpha=params.alpha,
        beta=params.beta,
        c=params.c,
        tau=params.tau,
        roi_mask=cardiac_roi,
        cancel_ev=cancel_ev,
    )
    cancellation.check(cancel_ev)

    weighted_img = geometric_weight(
        vesselness=frangi_img,
        scale=scale_img,
        orientation=orient_img,
        large_scale_threshold=params.sigma_max * 0.6,
    )
    cancellation.check(cancel_ev)

    hu_arr = sitk.GetArrayFromImage(img_iso).astype(np.float32)
    ves_arr = sitk.GetArrayFromImage(weighted_img).astype(np.float32)

    combined = combine_vesselness(
        vesselness=ves_arr,
        hu_arr=hu_arr,
        cardiac_roi=cardiac_roi,
        central_blood_pool=central_blood_pool,
        hu_target=blood_pool_hu_median,
        vesselness_weight=0.70,
        hu_weight=0.30,
    )

    # Cost image — explicit additive multi-term formulation
    scale_arr   = sitk.GetArrayFromImage(scale_img).astype(np.float32)
    orient_arr  = sitk.GetArrayFromImage(orient_img).astype(np.float32)
    cost = build_cost_image(
        vesselness=combined,
        hu_arr=hu_arr,
        scale_arr=scale_arr,
        orientation=orient_arr,
        cardiac_roi=cardiac_roi,
        central_blood_pool=central_blood_pool,
        hu_target=blood_pool_hu_median,
        hu_sigma=120.0,
        sigma_min=params.sigma_min,
        sigma_max=params.sigma_max,
    )

    def _resample_to_native(arr_iso_in: np.ndarray) -> np.ndarray:
        tmp = sitk.GetImageFromArray(arr_iso_in)
        tmp.CopyInformation(img_iso)
        rs = sitk.ResampleImageFilter()
        rs.SetReferenceImage(img_native)
        rs.SetInterpolator(sitk.sitkLinear)
        rs.SetDefaultPixelValue(0.0)
        return sitk.GetArrayFromImage(rs.Execute(tmp)).astype(np.float32)

    v_arr    = _resample_to_native(combined)
    cost_arr = _resample_to_native(cost)

    # Percentile thresholds over non-zero native-space voxels.
    # cardiac_roi is in iso space and has a different shape after _resample_to_native,
    # so we rely on the default-fill (0.0) to implicitly gate to the ROI.
    roi_vals = v_arr[v_arr > 0]
    if roi_vals.size > 0:
        p990, p993, p995, p998 = np.percentile(roi_vals, [99.0, 99.3, 99.5, 99.8]).tolist()
    else:
        p990 = p993 = p995 = p998 = 0.0

    percentiles_dict = {"p990": p990, "p993": p993, "p995": p995, "p998": p998}

    save_vesselness(
        uid=uid,
        arr=v_arr,
        spacing=entry["spacing"],
        origin=entry["origin"],
        direction=entry["direction"],
        params=params_dict,
        percentiles=percentiles_dict,
    )
    save_cost(
        uid=uid,
        arr=cost_arr,
        spacing=entry["spacing"],
        origin=entry["origin"],
        direction=entry["direction"],
    )

    result_uid = f"vesselness_{uid}"
    cost_uid   = f"cost_{uid}"
    store.add(result_uid, v_arr,    entry["spacing"], entry["origin"],
              entry["direction"], name=f"vesselness({entry['name']})")
    store.add(cost_uid,   cost_arr, entry["spacing"], entry["origin"],
              entry["direction"], name=f"cost({entry['name']})")

    return {
        "vesselness_uid": result_uid,
        "cost_uid": cost_uid,
        "shape": list(v_arr.shape),
        "blood_pool_hu_median": blood_pool_hu_median,
        "percentiles": percentiles_dict,
        "from_cache": False,
    }


def _run_blood_pool(entry: dict[str, Any]) -> dict[str, Any]:
    """Extract blood-pool mask and store it, returning the new UID."""
    from accta.preprocess.blood_pool import extract_blood_pool_mask

    arr: np.ndarray = entry["arr"]
    spacing = entry["spacing"]

    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin(
        (float(entry["origin"][2]), float(entry["origin"][1]), float(entry["origin"][0]))
    )
    img.SetDirection(entry["direction"])

    mask_img = extract_blood_pool_mask(img)
    mask_arr = sitk.GetArrayFromImage(mask_img).astype(np.float32)

    result_uid = f"bloodpool_{entry['uid']}"
    store.add(
        result_uid,
        mask_arr,
        entry["spacing"],
        entry["origin"],
        entry["direction"],
        name=f"bloodpool({entry['name']})",
    )
    return {"mask_uid": result_uid, "shape": list(mask_arr.shape)}


def _run_aorta_centerline(entry: dict[str, Any]) -> dict[str, Any]:
    """Detect the aorta and extract its centreline, returning points and radii."""
    from accta.aorta.centerline import aorta_centerline
    from accta.aorta.segment import detect_aorta
    from accta.preprocess.blood_pool import extract_blood_pool_mask

    arr: np.ndarray = entry["arr"]
    spacing = entry["spacing"]

    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin(
        (float(entry["origin"][2]), float(entry["origin"][1]), float(entry["origin"][0]))
    )
    img.SetDirection(entry["direction"])

    blood_pool = extract_blood_pool_mask(img)
    aorta_mask = detect_aorta(img, blood_pool)
    result = aorta_centerline(aorta_mask)  # {"points": [...], "radii": [...]}

    return {
        "points": result["points"],
        "radii": result["radii"],
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{uid}/pipeline-status")
async def get_pipeline_status(uid: str) -> dict:
    """Return cached pipeline state for each step without running anything."""
    from accta.pipeline.cache import pipeline_status
    return pipeline_status(uid)


@router.get("/{uid}/session")
async def get_session(uid: str) -> dict:
    """Return the persisted per-study session state (anchors, paths, viewer prefs)."""
    from accta.pipeline.cache import load_session
    return load_session(uid)


@router.put("/{uid}/session")
async def put_session(uid: str, data: dict) -> dict:
    """Persist the per-study session state.  Frontend writes the full document."""
    from accta.pipeline.cache import save_session
    save_session(uid, data)
    return {"ok": True}


@router.get("/{uid}/preprocess-progress")
async def get_preprocess_progress(uid: str) -> dict:
    """Return live preprocess step progress for the given study."""
    return _preprocess_progress.get(uid, {"current": None, "completed": []})


@router.post("/{uid}/preprocess", response_model=AlgorithmResult)
async def run_preprocess(uid: str, params: PreprocessRequest = PreprocessRequest()) -> AlgorithmResult:
    """Resample, clip, and apply cardiac ROI masking.

    Stores the result as ``preprocess_{uid}`` so the vesselness endpoint can
    consume it directly without repeating the masking step.
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    cancel_ev = cancellation.register("preprocess", uid)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor, partial(_run_preprocess, entry, params, cancel_ev)
        )
    except Cancelled:
        return AlgorithmResult(uid=uid, status="cancelled", result={"reason": "user-cancelled"})
    except Exception as exc:
        return AlgorithmResult(uid=uid, status="error", result={"error": str(exc)})
    finally:
        cancellation.clear("preprocess", uid)

    return AlgorithmResult(uid=uid, status="ok", result=result)


@router.post("/{uid}/vesselness", response_model=AlgorithmResult)
async def run_vesselness(uid: str, params: VesselnessRequest = VesselnessRequest()) -> AlgorithmResult:
    """Run multi-scale Frangi vesselness on the stored volume.

    Accepts an optional JSON body with filter parameters; omitting the body
    uses the defaults defined in ``VesselnessRequest``.
    The result is stored as a new study (``vesselness_{uid}``).
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    cancel_ev = cancellation.register("vesselness", uid)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor, partial(_run_vesselness, entry, params, cancel_ev)
        )
    except Cancelled:
        return AlgorithmResult(uid=uid, status="cancelled", result={"reason": "user-cancelled"})
    except Exception as exc:
        return AlgorithmResult(uid=uid, status="error", result={"error": str(exc)})
    finally:
        cancellation.clear("vesselness", uid)

    return AlgorithmResult(uid=uid, status="ok", result=result)


@router.post("/{uid}/cancel/{step}")
async def cancel_step(uid: str, step: str) -> dict:
    """Request cancellation of a running preprocess or vesselness job.

    Cancellation is cooperative — the worker raises at its next checkpoint,
    typically within seconds for preprocess and within one Frangi sigma for
    vesselness (~30–60 s).
    """
    if step not in ("preprocess", "vesselness"):
        raise HTTPException(status_code=400, detail=f"Unknown step: {step!r}")
    ok = cancellation.cancel(step, uid)
    return {"ok": ok, "step": step, "uid": uid}


@router.post("/{uid}/blood-pool", response_model=AlgorithmResult)
async def run_blood_pool(uid: str) -> AlgorithmResult:
    """Extract the blood-pool binary mask from the CT volume.

    The mask is stored as a new study (``bloodpool_{uid}``).
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(_executor, partial(_run_blood_pool, entry))
    except Exception as exc:
        return AlgorithmResult(uid=uid, status="error", result={"error": str(exc)})

    return AlgorithmResult(uid=uid, status="ok", result=result)


def _run_validate_point(pre_entry: dict[str, Any], world_xyz: list[float]) -> dict[str, Any]:
    """Check whether a world-space point lies within the cardiac ROI and return proximity info."""
    import SimpleITK as sitk
    from scipy.ndimage import distance_transform_edt

    arr      = pre_entry["arr"]
    spacing  = pre_entry["spacing"]   # (dz, dy, dx)
    origin   = pre_entry["origin"]    # (oz, oy, ox)
    direction = pre_entry["direction"]

    cardiac_roi        = pre_entry.get("cardiac_roi")
    central_blood_pool = pre_entry.get("central_blood_pool")

    if cardiac_roi is None or central_blood_pool is None:
        return {"valid": False, "in_roi": False, "in_blood_pool": False, "nearest_pool_mm": 9999.0}

    # Build a minimal ITK image solely for the world↔voxel transform
    nz, ny, nx = arr.shape
    img = sitk.Image(nx, ny, nz, sitk.sitkFloat32)
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))  # ITK: x, y, z
    img.SetOrigin((float(origin[2]),  float(origin[1]),  float(origin[0])))   # ITK: x, y, z
    img.SetDirection(direction)

    try:
        idx = img.TransformPhysicalPointToIndex(
            [float(world_xyz[0]), float(world_xyz[1]), float(world_xyz[2])]
        )  # returns (ix, iy, iz) in ITK convention
    except Exception:
        return {"valid": False, "in_roi": False, "in_blood_pool": False, "nearest_pool_mm": 9999.0}

    iz = int(min(max(idx[2], 0), nz - 1))
    iy = int(min(max(idx[1], 0), ny - 1))
    ix = int(min(max(idx[0], 0), nx - 1))

    in_roi        = bool(cardiac_roi[iz, iy, ix])
    in_blood_pool = bool(central_blood_pool[iz, iy, ix])

    spacing_mm = float(spacing[0])  # isotropic
    dist_arr = distance_transform_edt(~central_blood_pool, sampling=spacing_mm)
    nearest_pool_mm = float(dist_arr[iz, iy, ix])

    valid = in_roi or nearest_pool_mm < 20.0

    # Robust HU sample: 75th percentile in a 3x3x3 voxel neighborhood.
    # Favours the brightest voxels in the cluster (likely lumen) so a
    # slightly off-center click still reports vessel HU rather than wall.
    z0, z1 = max(0, iz - 1), min(nz, iz + 2)
    y0, y1 = max(0, iy - 1), min(ny, iy + 2)
    x0, x1 = max(0, ix - 1), min(nx, ix + 2)
    neighborhood = arr[z0:z1, y0:y1, x0:x1]
    hu_at_point = float(np.percentile(neighborhood, 75)) if neighborhood.size else float(arr[iz, iy, ix])

    return {
        "valid": valid,
        "in_roi": in_roi,
        "in_blood_pool": in_blood_pool,
        "nearest_pool_mm": round(nearest_pool_mm, 2),
        "hu": round(hu_at_point, 1),
    }


def _sample_anchor_hu(hu_arr: np.ndarray, voxel_zyx: tuple[int, int, int]) -> float:
    """Robust HU sample at an anchor: 75th percentile in a 3x3x3 neighborhood."""
    nz, ny, nx = hu_arr.shape
    iz, iy, ix = voxel_zyx
    z0, z1 = max(0, iz - 1), min(nz, iz + 2)
    y0, y1 = max(0, iy - 1), min(ny, iy + 2)
    x0, x1 = max(0, ix - 1), min(nx, ix + 2)
    nb = hu_arr[z0:z1, y0:y1, x0:x1]
    return float(np.percentile(nb, 75)) if nb.size else float(hu_arr[iz, iy, ix])


def _anchor_aware_cost_adjustment(
    cost_arr: np.ndarray,
    hu_arr: np.ndarray,
    anchor_voxels: list[tuple[int, int, int]],
    anchor_hus: list[float],
    spacing_mm: float,
    sigma_hu_min: float = 60.0,
    sigma_hu_max: float = 150.0,
    boost_alpha: float = 0.5,
) -> np.ndarray:
    """Reduce cost where local HU matches the IDW-interpolated expected HU
    derived from anchor samples.  Voxels whose HU matches the locally-expected
    blood HU get up to `boost_alpha` reduction; mismatch leaves cost unchanged.

    Sigma scales with distance to the nearest anchor: tight (sigma_hu_min) at
    anchors, loose (sigma_hu_max) far from any anchor.
    """
    if len(anchor_voxels) < 2 or len(anchor_voxels) != len(anchor_hus):
        return cost_arr

    nz, ny, nx = cost_arr.shape
    zs = np.arange(nz, dtype=np.float32) * spacing_mm
    ys = np.arange(ny, dtype=np.float32) * spacing_mm
    xs = np.arange(nx, dtype=np.float32) * spacing_mm

    expected_hu = np.zeros_like(cost_arr, dtype=np.float32)
    weight_sum  = np.zeros_like(cost_arr, dtype=np.float32)
    nearest_d2  = np.full_like(cost_arr, np.inf, dtype=np.float32)

    for (vz, vy, vx), hu in zip(anchor_voxels, anchor_hus):
        pz, py, px = vz * spacing_mm, vy * spacing_mm, vx * spacing_mm
        dz = zs[:, None, None] - pz
        dy = ys[None, :, None] - py
        dx = xs[None, None, :] - px
        d2 = dz * dz + dy * dy + dx * dx                # (nz,ny,nx) mm^2
        w = 1.0 / (d2 + 1.0)                            # IDW with 1 mm^2 epsilon
        expected_hu += w * float(hu)
        weight_sum  += w
        np.minimum(nearest_d2, d2, out=nearest_d2)

    expected_hu /= weight_sum
    nearest_d_mm = np.sqrt(nearest_d2)

    # Map distance-to-nearest-anchor → HU sigma. Saturate at 50 mm.
    t = np.clip(nearest_d_mm / 50.0, 0.0, 1.0)
    sigma_hu = sigma_hu_min + (sigma_hu_max - sigma_hu_min) * t

    hu_diff = hu_arr.astype(np.float32) - expected_hu
    match = np.exp(-0.5 * (hu_diff * hu_diff) / (sigma_hu * sigma_hu))   # 0..1

    # Reduce cost only inside ROI (preserve 1e6 hard barrier outside)
    out = cost_arr.astype(np.float32).copy()
    inside = out < 1e5
    out[inside] = out[inside] * (1.0 - boost_alpha * match[inside])
    return out


def _polyline_corridor_cost(
    cost_arr: np.ndarray,
    anchor_voxels: list[tuple[int, int, int]],
    spacing_mm: float,
    sigma_mm: float = 5.0,
    alpha: float = 0.7,
    free_radius_mm: float = 6.0,
    far_penalty: float = 4.0,
    far_clamp_mm: float = 25.0,
) -> np.ndarray:
    """Tube-shaped prior along the polyline connecting consecutive anchors.

    Two effects:
      * **Pull near** — voxels close to the polyline get up to ``alpha`` cost
        reduction (Gaussian, width ``sigma_mm``).
      * **Push far** — voxels >``free_radius_mm`` from the polyline get
        progressively higher cost (linear ramp, capped at ``far_penalty`` ×
        original cost at ``far_clamp_mm`` and beyond).

    Pull alone wasn't enough when vesselness is weak and chamber/cavity voxels
    happen to be cheap.  Adding the far-penalty makes Dijkstra commit to the
    user's anchor sequence even when alternative routes look attractive.
    """
    if len(anchor_voxels) < 2:
        return cost_arr
    nz, ny, nx = cost_arr.shape
    zs = np.arange(nz, dtype=np.float32)[:, None, None] * spacing_mm
    ys = np.arange(ny, dtype=np.float32)[None, :, None] * spacing_mm
    xs = np.arange(nx, dtype=np.float32)[None, None, :] * spacing_mm

    min_d2 = np.full(cost_arr.shape, np.inf, dtype=np.float32)
    for i in range(len(anchor_voxels) - 1):
        a = np.array(anchor_voxels[i],     dtype=np.float32) * spacing_mm  # (z,y,x)
        b = np.array(anchor_voxels[i + 1], dtype=np.float32) * spacing_mm
        ab = b - a
        ab2 = float((ab * ab).sum())
        if ab2 < 1e-6:
            d2 = (zs - a[0]) ** 2 + (ys - a[1]) ** 2 + (xs - a[2]) ** 2
        else:
            t = ((zs - a[0]) * ab[0] + (ys - a[1]) * ab[1] + (xs - a[2]) * ab[2]) / ab2
            t = np.clip(t, 0.0, 1.0)
            cz = a[0] + t * ab[0]
            cy = a[1] + t * ab[1]
            cx = a[2] + t * ab[2]
            d2 = (zs - cz) ** 2 + (ys - cy) ** 2 + (xs - cx) ** 2
        np.minimum(min_d2, d2, out=min_d2)

    d_mm = np.sqrt(min_d2, dtype=np.float32)

    # Pull near: Gaussian falloff
    pull = np.exp(-0.5 * min_d2 / (sigma_mm * sigma_mm))
    # Push far: linear ramp from 0 (at free_radius) to far_penalty (at far_clamp)
    excess = np.clip(d_mm - free_radius_mm, 0.0, far_clamp_mm - free_radius_mm)
    push = 1.0 + far_penalty * (excess / max(far_clamp_mm - free_radius_mm, 1e-6))

    out = cost_arr.astype(np.float32).copy()
    inside = out < 1e5
    out[inside] = out[inside] * (1.0 - alpha * pull[inside]) * push[inside]
    return out


def _run_extract_path(
    cost_entry: dict[str, Any],
    pre_entry: dict[str, Any] | None,
    req: ExtractPathRequest,
) -> dict[str, Any]:
    """Piecewise shortest-path through the cost image via skimage MCP.

    If a preprocessed HU volume is available, the cost image is locally adjusted
    using anchor-driven HU expectations (IDW interpolation of anchor HU samples)
    before Dijkstra.  This lets dim distal vessels (HU 60-100) be traced as long
    as the user places anchors there.
    """
    import SimpleITK as sitk
    from skimage.graph import route_through_array

    cost_arr  = cost_entry["arr"]
    spacing   = cost_entry["spacing"]   # (dz, dy, dx)
    origin    = cost_entry["origin"]    # (oz, oy, ox)
    direction = cost_entry["direction"]

    nz, ny, nx = cost_arr.shape

    img = sitk.Image(nx, ny, nz, sitk.sitkFloat32)
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin((float(origin[2]),  float(origin[1]),  float(origin[0])))
    img.SetDirection(direction)

    def world_to_voxel(world_xyz: list[float]) -> tuple[int, int, int]:
        idx = img.TransformPhysicalPointToIndex(
            [float(world_xyz[0]), float(world_xyz[1]), float(world_xyz[2])]
        )
        iz = int(min(max(idx[2], 0), nz - 1))
        iy = int(min(max(idx[1], 0), ny - 1))
        ix = int(min(max(idx[0], 0), nx - 1))
        return (iz, iy, ix)

    def voxel_to_world(zyx: tuple[int, int, int]) -> list[float]:
        z, y, x = zyx
        world = img.TransformIndexToPhysicalPoint((int(x), int(y), int(z)))
        return [float(world[0]), float(world[1]), float(world[2])]

    anchors = req.anchors
    if len(anchors) < 2:
        raise ValueError("At least 2 anchors required for path extraction")

    anchor_voxels_raw = [world_to_voxel(a.world) for a in anchors]

    # Drop near-duplicate anchors (within ~3 mm of the previous kept, or of
    # the final distal anchor).  Two stacked clicks force Dijkstra to visit
    # both in sequence, producing visible hairpin loops in the path even when
    # they're effectively the same point.  Always preserve the first (ostium)
    # and last (distal) anchors.
    DEDUP_MM = 3.0
    sp = float(spacing[0])
    last_idx = len(anchor_voxels_raw) - 1
    last_v = anchor_voxels_raw[last_idx]

    def _dist_mm(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
        return sp * float(np.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2))

    kept_idx: list[int] = [0]
    for i in range(1, last_idx):
        v = anchor_voxels_raw[i]
        if _dist_mm(v, anchor_voxels_raw[kept_idx[-1]]) < DEDUP_MM:
            logger.info("extract-path: drop anchor %d (too close to anchor %d)", i, kept_idx[-1])
            continue
        if _dist_mm(v, last_v) < DEDUP_MM:
            logger.info("extract-path: drop anchor %d (too close to distal)", i)
            continue
        kept_idx.append(i)
    kept_idx.append(last_idx)

    if len(kept_idx) < len(anchor_voxels_raw):
        logger.info("extract-path: deduplicated %d → %d anchors", len(anchor_voxels_raw), len(kept_idx))
    anchor_voxels = [anchor_voxels_raw[i] for i in kept_idx]
    anchors = [anchors[i] for i in kept_idx]

    # Anchor-driven cost adjustment: requires the preprocessed HU array.
    if pre_entry is not None and "arr" in pre_entry:
        hu_arr = pre_entry["arr"].astype(np.float32)
        if hu_arr.shape == cost_arr.shape:
            anchor_hus = [_sample_anchor_hu(hu_arr, vox) for vox in anchor_voxels]
            logger.info("extract-path: anchor HUs = %s", [round(h, 1) for h in anchor_hus])
            cost_arr = _anchor_aware_cost_adjustment(
                cost_arr, hu_arr, anchor_voxels, anchor_hus,
                spacing_mm=float(spacing[0]),
            )
        else:
            logger.warning(
                "extract-path: hu/cost shape mismatch (%s vs %s) — skipping anchor HU adjustment",
                hu_arr.shape, cost_arr.shape,
            )

    # Polyline corridor: pull the path toward the anchor sequence so it can't
    # detour into cheaper-but-anatomically-wrong regions between sparse waypoints.
    cost_arr = _polyline_corridor_cost(
        cost_arr, anchor_voxels,
        spacing_mm=float(spacing[0]),
    )

    cost_f64 = cost_arr.astype(np.float64)

    full_path: list[list[float]] = []
    for i in range(len(anchors) - 1):
        start = anchor_voxels[i]
        end   = anchor_voxels[i + 1]
        logger.info("extract-path segment %d: %s → %s", i, start, end)
        indices, _ = route_through_array(cost_f64, start, end, fully_connected=True)
        seg_world = [voxel_to_world(idx) for idx in indices]
        # Skip first point of each subsequent segment to avoid duplicates
        full_path.extend(seg_world if i == 0 else seg_world[1:])

    return {"vessel": req.vessel, "path": full_path}


@router.post("/{uid}/aorta-centerline", response_model=AlgorithmResult)
async def run_aorta_centerline(uid: str) -> AlgorithmResult:
    """Detect the ascending aorta and compute its centreline.

    Returns a list of physical-space points and equivalent radii.
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor, partial(_run_aorta_centerline, entry)
        )
    except Exception as exc:
        return AlgorithmResult(uid=uid, status="error", result={"error": str(exc)})

    return AlgorithmResult(uid=uid, status="ok", result=result)


# ---------------------------------------------------------------------------
# Centerline / pathfinding endpoints
# ---------------------------------------------------------------------------


@router.post("/{uid}/validate-point")
async def validate_point(uid: str, req: PointValidateRequest) -> dict:
    """Check whether a world-space anchor point lies within the cardiac ROI."""
    pre_uid = f"preprocess_{uid}"
    pre_entry = store.get(pre_uid)
    if pre_entry is None:
        raise HTTPException(status_code=404, detail="Preprocess not available — run preprocess first.")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor, partial(_run_validate_point, pre_entry, req.world)
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return result


@router.post("/{uid}/extract-path")
async def extract_path(uid: str, req: ExtractPathRequest) -> dict:
    """Extract a piecewise least-cost path through the stored cost image."""
    cost_uid = f"cost_{uid}"
    cost_entry = store.get(cost_uid)
    if cost_entry is None:
        # Lazy-restore from disk: backend may have been restarted since vesselness ran
        from accta.pipeline.cache import load_cost
        cached = load_cost(uid)
        if cached is None:
            raise HTTPException(
                status_code=404,
                detail="Cost image not available — run vesselness first.",
            )
        study_entry = store.get(uid)
        name = f"cost({study_entry['name']})" if study_entry else f"cost({uid})"
        store.add(cost_uid, cached["arr"], cached["spacing"],
                  cached["origin"], cached["direction"], name=name)
        cost_entry = store.get(cost_uid)
        logger.info("extract-path: restored cost image from disk for %s", uid)

    pre_entry = store.get(f"preprocess_{uid}")  # may be None — anchor HU adjustment is best-effort

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor, partial(_run_extract_path, cost_entry, pre_entry, req)
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return result
