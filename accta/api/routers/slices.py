"""Router: /volumes — slice extraction and full NRRD streaming."""

from __future__ import annotations

import asyncio
import base64
import io
import struct
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from accta.api.schemas import SliceResponse, StudyMeta
from accta.api.session import store

router = APIRouter(prefix="/volumes", tags=["volumes"])

_AXIS = Literal["axial", "coronal", "sagittal"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_slice(
    arr: np.ndarray,
    spacing: list[float],
    axis: str,
    index: int,
) -> tuple[np.ndarray, list[float]]:
    """Return a 2-D slice from arr and its in-plane pixel spacing.

    Array axis convention: arr[z, y, x], spacing = [dz, dy, dx].
    """
    dz, dy, dx = spacing[0], spacing[1], spacing[2]
    if axis == "axial":
        # axial: z fixed → (y, x) plane
        slc = arr[index, :, :]
        pixel_spacing = [dy, dx]
    elif axis == "coronal":
        # coronal: y fixed → (z, x) plane
        slc = arr[:, index, :]
        pixel_spacing = [dz, dx]
    elif axis == "sagittal":
        # sagittal: x fixed → (z, y) plane
        slc = arr[:, :, index]
        pixel_spacing = [dz, dy]
    else:
        raise ValueError(f"Unknown axis: {axis!r}")
    return slc, pixel_spacing


def _encode_slice(slc: np.ndarray, pixel_spacing: list[float]) -> SliceResponse:
    """Encode a 2-D float32 array into a SliceResponse with base64 pixel data."""
    slc_f32 = slc.astype(np.float32)
    raw_bytes = slc_f32.tobytes()  # little-endian on all modern platforms
    b64 = base64.b64encode(raw_bytes).decode("ascii")
    return SliceResponse(
        rows=slc_f32.shape[0],
        cols=slc_f32.shape[1],
        pixel_spacing=pixel_spacing,
        hu_min=float(slc_f32.min()),
        hu_max=float(slc_f32.max()),
        pixel_data_b64=b64,
    )


def _build_nrrd(arr: np.ndarray, spacing: list[float], origin: list[float]) -> bytes:
    """Construct a minimal NRRD (Nearly Raw Raster Data) byte stream.

    The NRRD spec is at http://teem.sourceforge.net/nrrd/format.html.
    We produce a detached-header NRRD (header + raw data in one buffer).

    arr shape: (Z, Y, X).  Spacing: [dz, dy, dx].  Origin: [oz, oy, ox].
    NRRD wants the fastest-changing axis first (C-order), which means x.
    We therefore write the array transposed to (X, Y, Z) so sizes/spacings
    match the NRRD x,y,z convention expected by VTK.js NrrdReader.
    """
    arr_f32 = arr.astype(np.float32)
    # Transpose to (X, Y, Z) – NRRD fastest-axis-first
    arr_out = np.ascontiguousarray(arr_f32.transpose(2, 1, 0))
    nx, ny, nz = arr_out.shape
    dx, dy, dz = spacing[2], spacing[1], spacing[0]
    ox, oy, oz = origin[2], origin[1], origin[0]

    header_lines = [
        "NRRD0004",
        "type: float",
        "dimension: 3",
        f"sizes: {nx} {ny} {nz}",
        "space: left-posterior-superior",
        f"space directions: ({dx},0,0) (0,{dy},0) (0,0,{dz})",
        f"space origin: ({ox},{oy},{oz})",
        "endian: little",
        "encoding: raw",
        "",  # blank line terminates header
    ]
    header_bytes = "\n".join(header_lines).encode("ascii")
    raw_bytes = arr_out.tobytes()
    return header_bytes + raw_bytes


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{uid}/metadata", response_model=StudyMeta)
async def volume_metadata(uid: str) -> StudyMeta:
    """Return StudyMeta for a loaded volume."""
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


@router.get("/{uid}/slice/{axis}/{index}", response_model=SliceResponse)
async def get_slice(uid: str, axis: str, index: int) -> SliceResponse:
    """Return a single 2-D slice as a base64-encoded float32 buffer.

    ``axis`` must be one of ``axial``, ``coronal``, or ``sagittal``.
    ``index`` is zero-based within the corresponding dimension.
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    # Wait for background pixel loading if needed (non-blocking for the event loop)
    if entry["arr"] is None:
        loop = asyncio.get_event_loop()
        ready = await loop.run_in_executor(None, store.wait_ready, uid, 300.0)
        if not ready:
            raise HTTPException(status_code=504, detail="Volume loading timed out.")
        entry = store.get(uid)

    arr: np.ndarray = entry["arr"]
    spacing: list[float] = list(entry["spacing"])
    shape = arr.shape  # (Z, Y, X)

    axis_lower = axis.lower()
    axis_to_dim = {"axial": 0, "coronal": 1, "sagittal": 2}
    if axis_lower not in axis_to_dim:
        raise HTTPException(
            status_code=422,
            detail=f"axis must be one of axial/coronal/sagittal, got {axis!r}",
        )

    dim_size = shape[axis_to_dim[axis_lower]]
    if not (0 <= index < dim_size):
        raise HTTPException(
            status_code=422,
            detail=f"index {index} out of range for axis {axis!r} (size {dim_size})",
        )

    slc, pixel_spacing = _extract_slice(arr, spacing, axis_lower, index)
    return _encode_slice(slc, pixel_spacing)


@router.get("/{uid}/nrrd")
async def stream_nrrd(uid: str) -> StreamingResponse:
    """Stream the full volume as an NRRD byte blob (kept for compatibility)."""
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    arr: np.ndarray = entry["arr"]
    spacing: list[float] = list(entry["spacing"])
    origin: list[float] = list(entry["origin"])

    nrrd_bytes = _build_nrrd(arr, spacing, origin)

    return StreamingResponse(
        io.BytesIO(nrrd_bytes),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{uid}.nrrd"'},
    )


@router.get("/{uid}/volume")
async def get_volume_json(uid: str, max_voxels: int = 8_000_000) -> dict:
    """Return a (possibly downsampled) volume as JSON with base64-encoded float32 data.

    ``max_voxels`` limits the total number of voxels in the response (default 8M,
    ~30 MB base64).  The volume is downsampled uniformly if it exceeds this limit.
    Use max_voxels=0 to get the full resolution volume.

    Response keys
    -------------
    shape      [nz, ny, nx]  (after downsampling)
    spacing    [dz, dy, dx] in mm  (adjusted for downsample factor)
    origin     [oz, oy, ox] in mm
    data_b64   flat C-order float32 array encoded as base64
    """
    entry = store.get(uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{uid}' not found.")

    arr: np.ndarray = entry["arr"].astype(np.float32)
    spacing = list(entry["spacing"])
    origin  = list(entry["origin"])

    # Downsample if needed — simple stride-based decimation (fast, no scipy needed)
    if max_voxels > 0 and arr.size > max_voxels:
        factor = max(1, int((arr.size / max_voxels) ** (1 / 3)) + 1)
        arr = arr[::factor, ::factor, ::factor]
        spacing = [s * factor for s in spacing]

    b64 = base64.b64encode(arr.tobytes()).decode("ascii")

    return {
        "shape": list(arr.shape),
        "spacing": spacing,
        "origin": origin,
        "data_b64": b64,
    }
