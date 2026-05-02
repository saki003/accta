"""Router: /mpr — curved MPR and cross-section plane reconstruction."""

from __future__ import annotations

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any

import numpy as np
from scipy.ndimage import map_coordinates
from fastapi import APIRouter, HTTPException

from accta.api.schemas import CrossSectionRequest, CurvedMPRRequest, SliceResponse
from accta.api.session import store

router = APIRouter(prefix="/mpr", tags=["mpr"])

_executor = ThreadPoolExecutor(max_workers=2)


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _normalize(v: np.ndarray) -> np.ndarray:
    """Return the unit vector of *v*, or a fallback if near-zero."""
    n = np.linalg.norm(v)
    if n < 1e-9:
        return np.array([1.0, 0.0, 0.0])
    return v / n


def _perpendicular_pair(tangent: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return two unit vectors (u, v) that are perpendicular to *tangent* and
    to each other, using Gram-Schmidt against the world z-axis (or y-axis when
    the tangent is near-parallel to z).
    """
    t = _normalize(np.array(tangent, dtype=float))
    # Choose an initial guess not parallel to t
    z_hat = np.array([0.0, 0.0, 1.0])
    y_hat = np.array([0.0, 1.0, 0.0])
    guess = z_hat if abs(np.dot(t, z_hat)) < 0.95 else y_hat
    u = _normalize(guess - np.dot(guess, t) * t)
    v = np.cross(t, u)
    return u, v


def _world_to_voxel(
    point_world: np.ndarray,
    spacing: np.ndarray,
    origin: np.ndarray,
) -> np.ndarray:
    """Convert a world-mm point [x,y,z] to voxel index [iz, iy, ix].

    Here we use the simplified assumption that direction cosines are identity
    (axis-aligned volume), which is the common case after resampling.  A full
    implementation would apply the inverse direction matrix; that extension is
    left as a comment below.
    """
    # Full transform would be: idx = D^{-T} @ ((point - origin) / spacing)
    # For axis-aligned volumes:
    diff = point_world - origin  # element-wise (x,y,z) or (z,y,x) depending on convention
    voxel = diff / spacing       # returns (iz, iy, ix) in our (dz,dy,dx) convention
    return voxel


def _compute_curved_mpr(
    entry: dict[str, Any],
    centerline: list[list[float]],
    width_mm: float,
    n_cross: int,
) -> SliceResponse:
    """Straightened curved MPR.

    For each centreline point (world mm) the tangent is estimated from its
    neighbours.  A row of *n_cross* pixels is sampled along the primary
    perpendicular axis at half-widths in [−width_mm/2, +width_mm/2].  All rows
    are stacked into a 2-D image of shape (n_points, n_cross).
    """
    arr: np.ndarray = entry["arr"]
    spacing = np.array(entry["spacing"], dtype=float)   # (dz, dy, dx)
    origin = np.array(entry["origin"], dtype=float)     # (oz, oy, ox) in (z,y,x)

    pts = np.array(centerline, dtype=float)  # (N, 3) in world mm, user convention (x,y,z)?
    # Our internal convention: stored as (Z, Y, X), origin as (oz, oy, ox).
    # Assume centerline points are in the same (x, y, z) world-mm space and we
    # map them to (iz, iy, ix) = ((pz-oz)/dz, (py-oy)/dy, (px-ox)/dx).
    n_pts = len(pts)
    if n_pts < 2:
        raise ValueError("Centerline must have at least 2 points.")

    # Pre-compute tangents via central differences
    tangents = np.zeros_like(pts)
    tangents[0] = pts[1] - pts[0]
    tangents[-1] = pts[-1] - pts[-2]
    tangents[1:-1] = pts[2:] - pts[:-2]

    cross_offsets = np.linspace(-width_mm / 2.0, width_mm / 2.0, n_cross)

    rows_z: list[np.ndarray] = []
    rows_y: list[np.ndarray] = []
    rows_x: list[np.ndarray] = []

    for i in range(n_pts):
        pt = pts[i]           # world mm (x, y, z)
        t = tangents[i]       # world mm tangent

        u, _v = _perpendicular_pair(t)  # unit perpendicular in world mm

        # Sample points along u
        sample_world = pt[np.newaxis, :] + cross_offsets[:, np.newaxis] * u[np.newaxis, :]
        # sample_world: (n_cross, 3) in world (x, y, z)
        # Convert to voxel indices (iz, iy, ix)
        # origin stored as (oz, oy, ox), spacing as (dz, dy, dx)
        iz = (sample_world[:, 2] - origin[0]) / spacing[0]   # z dim
        iy = (sample_world[:, 1] - origin[1]) / spacing[1]   # y dim
        ix = (sample_world[:, 0] - origin[2]) / spacing[2]   # x dim

        rows_z.append(iz)
        rows_y.append(iy)
        rows_x.append(ix)

    coords_z = np.stack(rows_z, axis=0)  # (n_pts, n_cross)
    coords_y = np.stack(rows_y, axis=0)
    coords_x = np.stack(rows_x, axis=0)

    coords = np.array([coords_z, coords_y, coords_x])  # (3, n_pts, n_cross)

    mpr_image = map_coordinates(arr, coords, order=1, mode="constant", cval=-1000.0)
    mpr_image = mpr_image.astype(np.float32)

    # In-plane pixel spacing: row → along centreline arc length, col → cross
    arc_lengths = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    mean_arc_step = float(arc_lengths.mean()) if len(arc_lengths) > 0 else 1.0
    col_spacing = width_mm / max(n_cross - 1, 1)

    raw_bytes = mpr_image.tobytes()
    b64 = base64.b64encode(raw_bytes).decode("ascii")

    return SliceResponse(
        rows=mpr_image.shape[0],
        cols=mpr_image.shape[1],
        pixel_spacing=[mean_arc_step, col_spacing],
        hu_min=float(mpr_image.min()),
        hu_max=float(mpr_image.max()),
        pixel_data_b64=b64,
    )


def _compute_cross_section(
    entry: dict[str, Any],
    point: list[float],
    tangent: list[float],
    radius_mm: float,
    n_pixels: int,
) -> SliceResponse:
    """Sample a single perpendicular plane through *point* with normal *tangent*.

    A square grid of *n_pixels* × *n_pixels* pixels is placed in the plane,
    spanning [−radius_mm, +radius_mm] in both in-plane directions.
    """
    arr: np.ndarray = entry["arr"]
    spacing = np.array(entry["spacing"], dtype=float)
    origin = np.array(entry["origin"], dtype=float)

    pt = np.array(point, dtype=float)    # world (x, y, z)
    t = np.array(tangent, dtype=float)

    u, v = _perpendicular_pair(t)

    offsets = np.linspace(-radius_mm, radius_mm, n_pixels)
    uu, vv = np.meshgrid(offsets, offsets)  # (n_pixels, n_pixels)

    sample_x = pt[0] + uu * u[0] + vv * v[0]
    sample_y = pt[1] + uu * u[1] + vv * v[1]
    sample_z = pt[2] + uu * u[2] + vv * v[2]

    iz = (sample_z - origin[0]) / spacing[0]
    iy = (sample_y - origin[1]) / spacing[1]
    ix = (sample_x - origin[2]) / spacing[2]

    coords = np.array([iz, iy, ix])  # (3, n_pixels, n_pixels)

    img_out = map_coordinates(arr, coords, order=1, mode="constant", cval=-1000.0)
    img_out = img_out.astype(np.float32)

    pixel_spacing = (2.0 * radius_mm) / max(n_pixels - 1, 1)

    raw_bytes = img_out.tobytes()
    b64 = base64.b64encode(raw_bytes).decode("ascii")

    return SliceResponse(
        rows=n_pixels,
        cols=n_pixels,
        pixel_spacing=[pixel_spacing, pixel_spacing],
        hu_min=float(img_out.min()),
        hu_max=float(img_out.max()),
        pixel_data_b64=b64,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/curved", response_model=SliceResponse)
async def curved_mpr(req: CurvedMPRRequest) -> SliceResponse:
    """Compute a straightened curved MPR along the provided centreline.

    Returns a SliceResponse containing the 2-D MPR image encoded as a
    base64 float32 buffer.
    """
    entry = store.get(req.uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{req.uid}' not found.")

    if len(req.centerline) < 2:
        raise HTTPException(
            status_code=422, detail="centerline must have at least 2 points."
        )

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor,
            partial(
                _compute_curved_mpr,
                entry,
                req.centerline,
                req.width_mm,
                req.n_cross,
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return result


@router.post("/crosssection", response_model=SliceResponse)
async def cross_section(req: CrossSectionRequest) -> SliceResponse:
    """Sample a perpendicular cross-section plane at the given point and tangent.

    Returns a SliceResponse containing the 2-D cross-section image encoded as
    a base64 float32 buffer.
    """
    entry = store.get(req.uid)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Study '{req.uid}' not found.")

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            _executor,
            partial(
                _compute_cross_section,
                entry,
                req.point,
                req.tangent,
                req.radius_mm,
                req.n_pixels,
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return result
