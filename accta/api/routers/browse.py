"""Router: /browse — filesystem navigation and DICOM series discovery.

Performance notes
-----------------
* ``list_series`` uses pydicom with a ThreadPoolExecutor (16 workers) instead of
  GDCM's serial scanner — 3700 files in ~3 s vs ~2 min.
* Results are cached in memory keyed by (folder_path, mtime, file_count) so
  repeat visits return instantly.
* ``load_series`` returns StudyMeta immediately after reading one DICOM file for
  spatial metadata; pixel data is loaded in a background thread.  Slice endpoints
  block-wait on the study's threading.Event until the array is ready.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from accta.api.schemas import StudyMeta
from accta.api.session import store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/browse", tags=["browse"])

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class FolderEntry(BaseModel):
    name: str
    path: str
    is_dicom_folder: bool


class SeriesInfo(BaseModel):
    series_uid: str
    series_number: str
    description: str
    modality: str
    slice_count: int
    slice_thickness_mm: float | None
    kvp: float | None
    image_type: str
    rows: int
    cols: int
    folder_path: str


class LoadSeriesRequest(BaseModel):
    path: str
    series_uid: str
    folder_path: str


# ---------------------------------------------------------------------------
# Series scan cache
# ---------------------------------------------------------------------------

_scan_cache: dict[tuple[str, float, int], list[SeriesInfo]] = {}
# Maps series_uid → sorted file paths; populated during scan so load_series skips GDCM
_files_cache: dict[str, list[str]] = {}
_cache_lock = threading.Lock()

_SCAN_WORKERS = 16

_PYDICOM_TAGS = [
    "SeriesInstanceUID", "SeriesNumber", "SeriesDescription", "StudyDescription",
    "Modality", "ImageType", "SliceThickness", "KVP", "Rows", "Columns",
    "InstanceNumber",
]


def _read_file_tags(path: Path) -> dict[str, Any] | None:
    """Read minimal DICOM tags from one file with pydicom (header-only, fast)."""
    try:
        import pydicom  # type: ignore

        ds = pydicom.dcmread(str(path), stop_before_pixels=True, specific_tags=_PYDICOM_TAGS)

        def _s(attr: str) -> str:
            v = getattr(ds, attr, None)
            return str(v).strip() if v else ""

        def _f(attr: str) -> float | None:
            v = getattr(ds, attr, None)
            try:
                return float(v) if v else None
            except (TypeError, ValueError):
                return None

        def _i(attr: str) -> int:
            v = getattr(ds, attr, None)
            try:
                return int(v) if v else 0
            except (TypeError, ValueError):
                return 0

        series_uid = _s("SeriesInstanceUID")
        if not series_uid:
            return None

        return {
            "path": path,
            "series_uid": series_uid,
            "series_number": _s("SeriesNumber"),
            "description": _s("SeriesDescription") or _s("StudyDescription"),
            "modality": _s("Modality") or "CT",
            "image_type": _s("ImageType").replace("\\", "/"),
            "thickness": _f("SliceThickness"),
            "kvp": _f("KVP"),
            "rows": _i("Rows"),
            "cols": _i("Columns"),
            "instance_number": _i("InstanceNumber"),
        }
    except Exception:
        return None


def _scan_dicomdir(dicomdir_path: Path) -> list[SeriesInfo] | None:
    """Read series info from a DICOMDIR index file — instant, no per-file I/O."""
    try:
        import pydicom

        ds = pydicom.dcmread(str(dicomdir_path))
        if not hasattr(ds, "DirectoryRecordSequence"):
            return None

        base_dir = dicomdir_path.parent

        # Walk PATIENT → STUDY → SERIES → IMAGE records
        series_map: dict[str, dict] = {}
        current_series_uid: str | None = None

        for record in ds.DirectoryRecordSequence:
            rtype = getattr(record, "DirectoryRecordType", "").strip().upper()

            if rtype == "SERIES":
                uid = str(getattr(record, "SeriesInstanceUID", "")).strip()
                if uid:
                    current_series_uid = uid
                    series_map[uid] = {
                        "series_uid": uid,
                        "series_number": str(getattr(record, "SeriesNumber", "")).strip(),
                        "description": str(getattr(record, "SeriesDescription", "")).strip(),
                        "modality": str(getattr(record, "Modality", "CT")).strip(),
                        "image_type": "",
                        "thickness": None,
                        "kvp": None,
                        "rows": 0,
                        "cols": 0,
                        "files": [],
                        "folder": str(base_dir),
                    }

            elif rtype == "IMAGE" and current_series_uid:
                ref = getattr(record, "ReferencedFileID", None)
                if ref:
                    # ReferencedFileID is a list of path components
                    parts = ref if isinstance(ref, (list, tuple)) else [ref]
                    file_path = base_dir / Path(*parts)
                    if file_path.exists():
                        series_map[current_series_uid]["files"].append(str(file_path))
                        series_map[current_series_uid]["folder"] = str(file_path.parent)

        if not series_map:
            return None

        infos: list[SeriesInfo] = []
        for s in series_map.values():
            if not s["files"]:
                continue
            with _cache_lock:
                _files_cache[s["series_uid"]] = s["files"]
            infos.append(SeriesInfo(
                series_uid=s["series_uid"],
                series_number=s["series_number"],
                description=s["description"] or "(no description)",
                modality=s["modality"],
                slice_count=len(s["files"]),
                slice_thickness_mm=s["thickness"],
                kvp=s["kvp"],
                image_type=s["image_type"],
                rows=s["rows"],
                cols=s["cols"],
                folder_path=s["folder"],
            ))

        infos.sort(key=lambda s: (int(s.series_number) if s.series_number.isdigit() else 9999, s.series_number))
        return infos

    except Exception:
        return None


def _scan_folder_pydicom(base: Path) -> list[SeriesInfo]:
    """Scan *base* (and one level of subdirs) using parallel pydicom reads."""
    # Collect all candidate DICOM files
    all_files: list[Path] = []
    candidates = [base] + sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))
    for c in candidates:
        for f in c.iterdir():
            if f.is_file() and not f.name.startswith("."):
                all_files.append(f)

    # Parallel header reads
    tag_results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=_SCAN_WORKERS) as ex:
        for tags in ex.map(_read_file_tags, all_files):
            if tags:
                tag_results.append(tags)

    # Group by series_uid, tracking which directory each series lives in
    from collections import defaultdict
    series_files: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in tag_results:
        series_files[t["series_uid"]].append(t)

    # Build SeriesInfo list
    infos: list[SeriesInfo] = []
    for uid, file_tags in series_files.items():
        # Sort by instance number — this is the correct slice order
        file_tags.sort(key=lambda x: x["instance_number"])

        rep = file_tags[0]
        folder = str(rep["path"].parent)

        # Cache sorted file paths so load_series can skip GDCM entirely
        sorted_paths = [str(t["path"]) for t in file_tags]
        with _cache_lock:
            _files_cache[uid] = sorted_paths

        infos.append(SeriesInfo(
            series_uid=uid,
            series_number=rep["series_number"],
            description=rep["description"] or "(no description)",
            modality=rep["modality"],
            slice_count=len(file_tags),
            slice_thickness_mm=rep["thickness"],
            kvp=rep["kvp"],
            image_type=rep["image_type"],
            rows=rep["rows"],
            cols=rep["cols"],
            folder_path=folder,
        ))

    # Sort by series number
    def _sort_key(s: SeriesInfo) -> tuple[int, str]:
        try:
            return (int(s.series_number), "")
        except ValueError:
            return (9999, s.series_number)

    infos.sort(key=_sort_key)
    return infos


def _cache_key(base: Path) -> tuple[str, float, int]:
    try:
        stat = base.stat()
        mtime = stat.st_mtime
        # Count only direct children to detect additions/removals quickly
        n_files = sum(1 for _ in base.iterdir())
    except OSError:
        mtime, n_files = 0.0, 0
    return (str(base), mtime, n_files)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class MkdirRequest(BaseModel):
    parent: str
    name: str


@router.post("/mkdir")
async def make_folder(req: MkdirRequest) -> dict:
    """Create a new folder under *parent*.  Used by the workspace picker."""
    parent = Path(req.parent).expanduser()
    if not parent.is_dir():
        raise HTTPException(status_code=400, detail=f"Parent is not a directory: {parent}")
    name = req.name.strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid folder name.")
    new_path = parent / name
    if new_path.exists():
        raise HTTPException(status_code=409, detail="A folder with that name already exists.")
    try:
        new_path.mkdir(parents=False, exist_ok=False)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"path": str(new_path)}


@router.get("/folders", response_model=list[FolderEntry])
async def list_folders(path: str, check_dicom: bool = True) -> list[FolderEntry]:
    """List immediate subfolders of *path*.

    When ``check_dicom`` is True (default), each subfolder is also tested for
    `.dcm` files (used by the DICOM Browse modal to highlight loadable folders).
    Set to False for plain folder navigation (e.g. workspace picker) — the
    recursive `.dcm` scan is slow and can fail on unreadable system folders.
    """
    base = Path(path)
    if not base.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {path!r}")
    if not base.is_dir():
        raise HTTPException(status_code=422, detail=f"Not a directory: {path!r}")

    try:
        children = sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    entries: list[FolderEntry] = []
    for child in children:
        has_dcm = False
        if check_dicom:
            try:
                has_dcm = any(True for _ in child.glob("*.dcm"))
                if not has_dcm:
                    has_dcm = any(True for _ in child.rglob("*.dcm"))
            except (PermissionError, OSError):
                has_dcm = False  # unreadable subtree — don't fail the whole listing
        entries.append(FolderEntry(name=child.name, path=str(child), is_dicom_folder=has_dcm))

    return entries


@router.get("/series", response_model=list[SeriesInfo])
async def list_series(path: str) -> list[SeriesInfo]:
    """Return all DICOM series in *path* using fast parallel pydicom scan.

    Results are cached by (folder_path, mtime, file_count) so repeat calls
    for the same unchanged folder return instantly.
    """
    base = Path(path)
    if not base.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {path!r}")

    key = _cache_key(base)
    with _cache_lock:
        cached = _scan_cache.get(key)
    if cached is not None:
        return cached

    # Fast path: DICOMDIR index file (single-file table of contents)
    for name in ("DICOMDIR", "dicomdir"):
        dicomdir = base / name
        if not dicomdir.exists():
            # Also check one level up (some datasets put DICOMDIR at root)
            dicomdir = base.parent / name
        if dicomdir.exists():
            result = _scan_dicomdir(dicomdir)
            if result is not None:
                with _cache_lock:
                    _scan_cache[key] = result
                return result

    # Fallback: parallel pydicom header scan
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _scan_folder_pydicom, base)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Scan failed: {exc}") from exc

    with _cache_lock:
        _scan_cache[key] = result

    return result


@router.post("/load", response_model=StudyMeta, status_code=201)
async def load_series(req: LoadSeriesRequest) -> StudyMeta:
    """Load a DICOM series into the study store.

    Returns StudyMeta immediately after reading spatial metadata from a single
    file.  Pixel data is loaded in a background thread; slice/MPR endpoints
    will wait for it automatically.
    """
    # ── 1. Locate the files ─────────────────────────────────────────────────
    base = Path(req.path)
    file_names: list[str] | None = None

    # Fast path: use file list cached by the pydicom scanner (instant)
    with _cache_lock:
        cached_files = _files_cache.get(req.series_uid)
    if cached_files:
        file_names = cached_files

    # Fallback: GDCM scan (slower — only hits when Browse was skipped)
    if not file_names:
        sr_reader = sitk.ImageSeriesReader()
        folder = Path(req.folder_path)
        if folder.exists() and folder.is_dir():
            try:
                uids = sr_reader.GetGDCMSeriesIDs(str(folder))
                if req.series_uid in uids:
                    file_names = list(sr_reader.GetGDCMSeriesFileNames(str(folder), req.series_uid))
            except Exception:
                pass

    if not file_names:
        sr_reader = sitk.ImageSeriesReader()
        if not base.exists():
            raise HTTPException(status_code=404, detail=f"Path not found: {req.path!r}")
        candidates = [base] + sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))
        for candidate in candidates:
            try:
                uids = sr_reader.GetGDCMSeriesIDs(str(candidate))
                if req.series_uid in uids:
                    file_names = list(sr_reader.GetGDCMSeriesFileNames(str(candidate), req.series_uid))
                    break
            except Exception:
                continue

    if not file_names:
        raise HTTPException(status_code=404, detail=f"Series '{req.series_uid}' not found.")

    # ── 2. Read spatial metadata from the first file only (fast) ───────────
    try:
        r = sitk.ImageFileReader()
        r.SetFileName(file_names[0])
        r.LoadPrivateTagsOn()
        r.ReadImageInformation()

        size_xy = r.GetSize()          # (nx, ny) — pixel dimensions
        spacing_xy = r.GetSpacing()    # (sx, sy) in mm
        origin_xy = r.GetOrigin()      # (ox, oy) in mm
        direction_2d = r.GetDirection()

        # Estimate slice spacing from SliceThickness tag; fall back to 1 mm
        try:
            dz = float(r.GetMetaData("0018|0050").strip()) or 1.0
        except Exception:
            dz = 1.0
        try:
            oz = float(r.GetMetaData("0020|0032").strip().split("\\")[-1])
        except Exception:
            oz = 0.0
        try:
            desc = r.GetMetaData("0008|103e").strip()
        except Exception:
            desc = ""

        nz = len(file_names)
        ny, nx = int(size_xy[1]), int(size_xy[0])
        spacing = (dz, float(spacing_xy[1]), float(spacing_xy[0]))
        origin  = (oz, float(origin_xy[1]),  float(origin_xy[0]))

        # Build the 3D direction from the full ImageOrientationPatient tag (6 floats).
        # The 2D direction from GetDirection() drops the z-component of each axis,
        # producing a degenerate matrix when column direction has a z-component.
        try:
            iop_str = r.GetMetaData("0020|0037").strip()
            iop = [float(v) for v in iop_str.replace("\\", " ").split()]
            if len(iop) == 6:
                row_dir = np.array(iop[:3], dtype=float)
                col_dir = np.array(iop[3:], dtype=float)
                slice_dir = np.cross(row_dir, col_dir)
                direction = (
                    row_dir[0], col_dir[0], slice_dir[0],
                    row_dir[1], col_dir[1], slice_dir[1],
                    row_dir[2], col_dir[2], slice_dir[2],
                )
            else:
                raise ValueError("unexpected IOP length")
        except Exception:
            direction = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to read metadata: {exc}") from exc

    uid = str(uuid.uuid4())
    name = base.name + (f" — {desc}" if desc else "")

    # ── 3. Register stub then load pixels (synchronous in executor) ────────
    # Loading pixels before returning avoids connection-pool starvation:
    # if we returned the stub first, Cornerstone3D would immediately queue
    # 177 slice requests that each block on wait_ready(), consuming all 6
    # of Chrome's per-origin connections and locking out every other request.
    store.add_stub(uid, (nz, ny, nx), spacing, origin, direction, name)

    def _load_pixels() -> None:
        reader = sitk.ImageSeriesReader()
        reader.SetFileNames(file_names)
        reader.MetaDataDictionaryArrayUpdateOn()
        reader.LoadPrivateTagsOn()
        img = reader.Execute()
        arr = sitk.GetArrayFromImage(img).astype(np.float32)
        store.set_array(uid, arr)

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_pixels)
    except Exception as exc:
        store.remove(uid)
        raise HTTPException(status_code=500, detail=f"Failed to load pixel data: {exc}") from exc

    # Persist a tiny manifest so the study survives a backend restart.
    # The DICOM files stay in place — we only record the path list.
    try:
        from accta.pipeline.cache import save_study_meta
        save_study_meta(uid, name, file_names)
    except Exception as exc:
        logger.warning("Failed to persist study manifest for %s: %s", uid, exc)

    entry = store.get(uid)
    hu_min = float(entry["hu_min"]) if entry else -1024.0
    hu_max = float(entry["hu_max"]) if entry else 3071.0

    # ── 4. Return metadata — pixels are ready ──────────────────────────────
    return StudyMeta(
        uid=uid,
        name=name,
        shape=[nz, ny, nx],
        spacing=list(spacing),
        origin=list(origin),
        hu_min=hu_min,
        hu_max=hu_max,
    )
