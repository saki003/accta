"""Pipeline result cache — persist and restore per-step outputs to disk."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk

from accta.api.config import DATA_DIR, pipeline_dir, study_dir

logger = logging.getLogger(__name__)

_PIPELINE_VERSION = "6"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def params_hash(params: dict[str, Any]) -> str:
    """Stable SHA-256 hex digest of a JSON-serialisable params dict."""
    raw = json.dumps(params, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _meta_path(uid: str, step: str) -> Path:
    return pipeline_dir(uid) / f"{step}.json"


def _vol_path(uid: str, step: str) -> Path:
    return pipeline_dir(uid) / f"{step}.nii.gz"


def _mask_path(uid: str, name: str) -> Path:
    return pipeline_dir(uid) / f"{name}.npy"


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------

def save_preprocess(
    uid: str,
    arr: np.ndarray,
    spacing: tuple,
    origin: tuple,
    direction: tuple,
    cardiac_roi: np.ndarray,
    central_blood_pool: np.ndarray,
    params: dict[str, Any],
    quality: dict[str, Any],
    blood_pool_hu_median: float = 300.0,
) -> None:
    img = sitk.GetImageFromArray(arr.astype(np.float32))
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin((float(origin[2]), float(origin[1]), float(origin[0])))
    img.SetDirection(direction)
    sitk.WriteImage(img, str(_vol_path(uid, "preprocess")))

    np.save(str(_mask_path(uid, "cardiac_roi")), cardiac_roi.astype(np.bool_))
    np.save(str(_mask_path(uid, "central_blood_pool")), central_blood_pool.astype(np.bool_))

    meta = {
        "pipeline_version": _PIPELINE_VERSION,
        "params_hash": params_hash(params),
        "params": params,
        "spacing": list(spacing),
        "origin": list(origin),
        "direction": list(direction),
        "quality": quality,
        "blood_pool_hu_median": blood_pool_hu_median,
    }
    _meta_path(uid, "preprocess").write_text(json.dumps(meta, indent=2))
    logger.info("cache: saved preprocess for %s", uid)


def save_vesselness(
    uid: str,
    arr: np.ndarray,
    spacing: tuple,
    origin: tuple,
    direction: tuple,
    params: dict[str, Any],
    percentiles: dict[str, float] | None = None,
) -> None:
    img = sitk.GetImageFromArray(arr.astype(np.float32))
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin((float(origin[2]), float(origin[1]), float(origin[0])))
    img.SetDirection(direction)
    sitk.WriteImage(img, str(_vol_path(uid, "vesselness")))

    meta = {
        "pipeline_version": _PIPELINE_VERSION,
        "params_hash": params_hash(params),
        "params": params,
        "spacing": list(spacing),
        "origin": list(origin),
        "direction": list(direction),
        "percentiles": percentiles or {},
    }
    _meta_path(uid, "vesselness").write_text(json.dumps(meta, indent=2))
    logger.info("cache: saved vesselness for %s", uid)


def save_cost(
    uid: str,
    arr: np.ndarray,
    spacing: tuple,
    origin: tuple,
    direction: tuple,
) -> None:
    """Persist the path-finding cost image so Extract Path works after backend restart."""
    img = sitk.GetImageFromArray(arr.astype(np.float32))
    img.SetSpacing((float(spacing[2]), float(spacing[1]), float(spacing[0])))
    img.SetOrigin((float(origin[2]), float(origin[1]), float(origin[0])))
    img.SetDirection(direction)
    sitk.WriteImage(img, str(_vol_path(uid, "cost")))
    logger.info("cache: saved cost image for %s", uid)


def load_cost(uid: str) -> dict[str, Any] | None:
    """Load cached cost image. Returns None if not present."""
    vol_p = _vol_path(uid, "cost")
    if not vol_p.exists():
        return None
    try:
        img = sitk.ReadImage(str(vol_p))
        arr = sitk.GetArrayFromImage(img).astype(np.float32)
        spacing   = tuple(reversed(img.GetSpacing()))
        origin    = tuple(reversed(img.GetOrigin()))
        direction = img.GetDirection()
    except Exception as exc:
        logger.warning("cache: failed to load cost for %s: %s", uid, exc)
        return None
    return {
        "arr": arr,
        "spacing": spacing,
        "origin": origin,
        "direction": direction,
    }


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

def _load_meta(uid: str, step: str) -> dict[str, Any] | None:
    p = _meta_path(uid, step)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def is_valid(uid: str, step: str, params: dict[str, Any]) -> bool:
    """Return True if a cached result exists and was produced with the same params."""
    meta = _load_meta(uid, step)
    if meta is None:
        return False
    if meta.get("pipeline_version") != _PIPELINE_VERSION:
        return False
    if not _vol_path(uid, step).exists():
        return False
    return meta.get("params_hash") == params_hash(params)


def load_preprocess(uid: str) -> dict[str, Any] | None:
    """Load cached preprocess result. Returns None if not present."""
    meta = _load_meta(uid, "preprocess")
    vol_p = _vol_path(uid, "preprocess")
    roi_p = _mask_path(uid, "cardiac_roi")
    bp_p  = _mask_path(uid, "central_blood_pool")

    if meta is None or not vol_p.exists() or not roi_p.exists() or not bp_p.exists():
        return None

    try:
        img = sitk.ReadImage(str(vol_p))
        arr = sitk.GetArrayFromImage(img).astype(np.float32)
        spacing   = tuple(reversed(img.GetSpacing()))    # (dz, dy, dx)
        origin    = tuple(reversed(img.GetOrigin()))     # (oz, oy, ox)
        direction = img.GetDirection()
        cardiac_roi        = np.load(str(roi_p))
        central_blood_pool = np.load(str(bp_p))
    except Exception as exc:
        logger.warning("cache: failed to load preprocess for %s: %s", uid, exc)
        return None

    return {
        "arr": arr,
        "spacing": spacing,
        "origin": origin,
        "direction": direction,
        "cardiac_roi": cardiac_roi,
        "central_blood_pool": central_blood_pool,
        "quality": meta.get("quality", {}),
        "params": meta.get("params", {}),
        "blood_pool_hu_median": meta.get("blood_pool_hu_median", 300.0),
    }


def load_vesselness(uid: str) -> dict[str, Any] | None:
    """Load cached vesselness result. Returns None if not present."""
    meta = _load_meta(uid, "vesselness")
    vol_p = _vol_path(uid, "vesselness")

    if meta is None or not vol_p.exists():
        return None

    try:
        img = sitk.ReadImage(str(vol_p))
        arr = sitk.GetArrayFromImage(img).astype(np.float32)
        spacing   = tuple(reversed(img.GetSpacing()))
        origin    = tuple(reversed(img.GetOrigin()))
        direction = img.GetDirection()
    except Exception as exc:
        logger.warning("cache: failed to load vesselness for %s: %s", uid, exc)
        return None

    return {
        "arr": arr,
        "spacing": spacing,
        "origin": origin,
        "direction": direction,
        "params": meta.get("params", {}),
        "percentiles": meta.get("percentiles", {}),
    }


# ---------------------------------------------------------------------------
# Study manifest — minimal record of which DICOM files a study UID points at.
# Persisted at workspace/<uid>/study.json so studies survive backend restarts.
# Source DICOM stays in place; we only record the file paths.
# ---------------------------------------------------------------------------

def save_study_meta(uid: str, name: str, file_names: list[str]) -> None:
    """Persist enough info to reload this study from disk on next backend startup."""
    p = study_dir(uid) / "study.json"
    p.write_text(json.dumps({
        "uid": uid,
        "name": name,
        "file_names": list(file_names),
    }, indent=2))


def load_study_meta(uid: str) -> dict[str, Any] | None:
    p = DATA_DIR / uid / "study.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as exc:
        logger.warning("cache: failed to load study meta for %s: %s", uid, exc)
        return None


def list_persisted_study_uids() -> list[str]:
    """Return UIDs of all studies that have a study.json on disk."""
    if not DATA_DIR.exists():
        return []
    return sorted(p.parent.name for p in DATA_DIR.glob("*/study.json"))


# ---------------------------------------------------------------------------
# Per-study session state (anchors, paths, viewer prefs) — durable across
# backend restarts.  Read on Session mount, written on every state change
# (debounced from the frontend).
# ---------------------------------------------------------------------------

def _session_path(uid: str) -> Path:
    return pipeline_dir(uid) / "session.json"


def load_session(uid: str) -> dict[str, Any]:
    """Return the saved session state for a study, or {} if none exists."""
    p = _session_path(uid)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception as exc:
        logger.warning("cache: failed to load session for %s: %s", uid, exc)
        return {}


def save_session(uid: str, data: dict[str, Any]) -> None:
    """Persist the session state for a study."""
    _session_path(uid).write_text(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def pipeline_status(uid: str) -> dict[str, Any]:
    """Return cached state for all pipeline steps."""
    pre_meta = _load_meta(uid, "preprocess")
    ves_meta = _load_meta(uid, "vesselness")

    return {
        "preprocess": {
            "done": pre_meta is not None and _vol_path(uid, "preprocess").exists(),
            "params": pre_meta.get("params", {}) if pre_meta else {},
            "quality": pre_meta.get("quality", {}) if pre_meta else {},
        },
        "vesselness": {
            "done": ves_meta is not None and _vol_path(uid, "vesselness").exists(),
            "params": ves_meta.get("params", {}) if ves_meta else {},
            "percentiles": ves_meta.get("percentiles", {}) if ves_meta else {},
        },
    }
