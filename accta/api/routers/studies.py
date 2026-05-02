"""Router: /studies — upload, list, inspect, and delete CT studies."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

import numpy as np
import SimpleITK as sitk
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from accta.api.schemas import StudyMeta
from accta.api.session import store
from accta.io.dicom import load_dicom

router = APIRouter(prefix="/studies", tags=["studies"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sitk_to_store(uid: str, img: sitk.Image, name: str) -> StudyMeta:
    """Convert a SimpleITK image to float32, store it, and return StudyMeta."""
    arr = sitk.GetArrayFromImage(img).astype(np.float32)  # shape: (Z, Y, X)

    spacing_raw = img.GetSpacing()       # (sx, sy, sz) in SimpleITK convention
    origin_raw = img.GetOrigin()         # (ox, oy, oz)
    direction = img.GetDirection()       # 9-element tuple row-major

    # Store as (dz, dy, dx) to match array axis order
    spacing = (float(spacing_raw[2]), float(spacing_raw[1]), float(spacing_raw[0]))
    origin = (float(origin_raw[2]), float(origin_raw[1]), float(origin_raw[0]))

    store.add(uid, arr, spacing, origin, direction, name)

    entry = store.get(uid)
    assert entry is not None

    return StudyMeta(
        uid=uid,
        name=name,
        shape=list(arr.shape),
        spacing=list(spacing),
        origin=list(origin),
        hu_min=float(entry["hu_min"]),
        hu_max=float(entry["hu_max"]),
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/upload", response_model=StudyMeta, status_code=201)
async def upload_study(file: UploadFile) -> StudyMeta:
    """Upload a DICOM archive (.zip, .dcm, .mhd) and load it into the study store.

    Returns the StudyMeta for the newly created study.
    """
    filename = file.filename or "unknown"
    suffix = Path(filename).suffix.lower() or ".dcm"
    uid = str(uuid.uuid4())

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    try:
        img = load_dicom(tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Failed to load image: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    name = Path(filename).stem
    return _sitk_to_store(uid, img, name)


@router.post("/upload-folder", response_model=StudyMeta, status_code=201)
async def upload_folder(request: Request) -> StudyMeta:
    """Upload multiple DICOM files (a whole folder) and load them as one series.

    Parses the multipart form directly so we can raise Starlette's default
    limits (max_files=1000, max_part_size=1 MB) to handle full CCTA folders
    which can contain 500–2000 files at up to 2 MB each.
    """
    form = await request.form(
        max_files=5000,
        max_fields=100,
        max_part_size=10 * 1024 * 1024,  # 10 MB per file
    )
    uploads = [v for k, v in form.multi_items() if k == "files" and hasattr(v, "read")]

    if not uploads:
        raise HTTPException(status_code=422, detail="No files received. Send files as 'files' form fields.")

    uid = str(uuid.uuid4())
    first_filename = getattr(uploads[0], "filename", None) or "upload"

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)

        for uf in uploads:
            fname = Path(getattr(uf, "filename", None) or "unknown.dcm").name
            dest = tmp_path / fname
            content = await uf.read()
            dest.write_bytes(content)

        try:
            from accta.io.dicom import _load_dicom_dir
            img = _load_dicom_dir(tmp_path)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Failed to load series: {exc}") from exc

    raw_parts = Path(first_filename).parts
    name = raw_parts[-2] if len(raw_parts) >= 2 else Path(first_filename).stem
    return _sitk_to_store(uid, img, name)


_DERIVED_PREFIXES = ("preprocess_", "vesselness_", "cost_")


def _extracted_vessels(uid: str) -> list[str]:
    """Return list of vessel IDs that have an extracted path saved on disk."""
    from accta.pipeline.cache import load_session
    state = load_session(uid)
    vessels = state.get("vessels", {}) if isinstance(state, dict) else {}
    out: list[str] = []
    for vid, vdata in vessels.items():
        if isinstance(vdata, dict) and vdata.get("status") in ("extracted", "locked"):
            out.append(vid)
    return out


@router.get("/", response_model=list[StudyMeta])
async def list_studies() -> list[StudyMeta]:
    """Return metadata for all studies currently in the store.

    Derived volumes (preprocess_*, vesselness_*, cost_*) are excluded — they
    are intermediate pipeline outputs, not loadable studies.
    """
    entries = store.list_studies()
    result: list[StudyMeta] = []
    for e in entries:
        if e["uid"].startswith(_DERIVED_PREFIXES):
            continue
        full = store.get(e["uid"])
        if full is None:
            continue
        result.append(
            StudyMeta(
                uid=full["uid"],
                name=full["name"],
                shape=list(full["shape"]),
                spacing=list(full["spacing"]),
                origin=list(full["origin"]),
                hu_min=full["hu_min"],
                hu_max=full["hu_max"],
                extracted_vessels=_extracted_vessels(full["uid"]),
            )
        )
    return result


@router.get("/{uid}", response_model=StudyMeta)
async def get_study(uid: str) -> StudyMeta:
    """Return metadata for a single study by UID."""
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")
    return StudyMeta(
        uid=entry["uid"],
        name=entry["name"],
        shape=list(entry["shape"]),
        spacing=list(entry["spacing"]),
        origin=list(entry["origin"]),
        hu_min=entry["hu_min"],
        hu_max=entry["hu_max"],
    )


@router.delete("/{uid}")
async def delete_study(uid: str) -> JSONResponse:
    """Remove a study from the store and delete its on-disk derivatives.

    The original DICOM source files are left untouched.
    """
    import shutil
    from accta.api.config import DATA_DIR

    removed = store.remove(uid)
    workspace_dir = DATA_DIR / uid
    if workspace_dir.exists():
        try:
            shutil.rmtree(workspace_dir)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to delete workspace: {exc}") from exc
    elif not removed:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")
    return JSONResponse({"status": "deleted", "uid": uid})
