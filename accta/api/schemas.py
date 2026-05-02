"""Pydantic request/response models for the accta API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Study metadata
# ---------------------------------------------------------------------------


class StudyMeta(BaseModel):
    """Lightweight metadata returned for a loaded CT study."""

    uid: str
    name: str
    shape: list[int] = Field(..., description="Volume shape [Z, Y, X]")
    spacing: list[float] = Field(..., description="Voxel spacing in mm [dz, dy, dx]")
    origin: list[float] = Field(..., description="World origin in mm [oz, oy, ox]")
    hu_min: float
    hu_max: float
    extracted_vessels: list[str] = Field(
        default_factory=list,
        description="Vessel IDs (LAD, RCA, ...) with an extracted centreline saved on disk",
    )


# ---------------------------------------------------------------------------
# Slice / image responses
# ---------------------------------------------------------------------------


class SliceResponse(BaseModel):
    """2-D image payload returned by slice and MPR endpoints.

    ``pixel_data_b64`` is a base-64–encoded, little-endian float32 buffer
    with ``rows * cols`` values stored in row-major order.
    """

    rows: int
    cols: int
    pixel_spacing: list[float] = Field(
        ..., description="In-plane pixel spacing in mm [row_spacing, col_spacing]"
    )
    hu_min: float
    hu_max: float
    pixel_data_b64: str = Field(..., description="Base-64 float32 raw pixel buffer")
    dtype: str = "float32"


# ---------------------------------------------------------------------------
# MPR requests
# ---------------------------------------------------------------------------


class CenterlineRequest(BaseModel):
    """Raw list of 3-D world-coordinate points defining a vessel centreline."""

    points: list[list[float]] = Field(
        ..., description="N×3 list of [x, y, z] points in world mm"
    )


class CurvedMPRRequest(BaseModel):
    """Request parameters for a straightened curved MPR."""

    uid: str = Field(..., description="Study UID")
    centerline: list[list[float]] = Field(
        ..., description="Ordered centerline points in world mm"
    )
    width_mm: float = Field(20.0, description="Half-width of the MPR slab in mm")
    n_cross: int = Field(64, description="Number of pixels across the vessel lumen")


class CrossSectionRequest(BaseModel):
    """Request parameters for a single perpendicular cross-section."""

    uid: str = Field(..., description="Study UID")
    point: list[float] = Field(..., description="Centre point in world mm [x, y, z]")
    tangent: list[float] = Field(
        ..., description="Vessel tangent direction [tx, ty, tz] (need not be unit)"
    )
    radius_mm: float = Field(10.0, description="Half-width of the cross-section in mm")
    n_pixels: int = Field(64, description="Output image size in pixels (square)")


# ---------------------------------------------------------------------------
# Algorithm requests
# ---------------------------------------------------------------------------


class PreprocessRequest(BaseModel):
    """Parameters for cardiac ROI masking prior to vesselness filtering."""

    hu_floor: float = Field(-100.0, description="Lower HU clamp applied during resampling")
    hu_ceil: float = Field(800.0, description="Upper HU clamp applied during resampling")
    denoise_conductance: float = Field(2.0, description="Edge sensitivity for anisotropic diffusion (lower = sharper edges)")
    denoise_iterations: int = Field(3, description="Number of diffusion iterations (0 disables denoising)")
    blood_pool_threshold: float = Field(120.0, description="Mask voxels above this HU (blood pool)")
    lung_threshold: float = Field(-500.0, description="Mask voxels below this HU (lung/air)")
    roi_margin_mm: float = Field(20.0, description="Dilation margin around blood pool in mm")
    enable_denoise: bool = Field(True, description="Run anisotropic diffusion denoising")
    enable_masks: bool = Field(True, description="Compute blood-pool / lung masks")
    enable_roi: bool = Field(True, description="Restrict downstream processing to the cardiac ROI")


class VesselnessRequest(BaseModel):
    """Tunable parameters for the Frangi vesselness filter."""

    sigma_min: float = Field(0.5, description="Smallest Gaussian scale in mm")
    sigma_max: float = Field(3.0, description="Largest Gaussian scale in mm")
    sigma_steps: int = Field(3, description="Number of log-spaced scales")
    alpha: float = Field(0.5, description="Plate-vs-vessel sensitivity (Ra term)")
    beta: float = Field(0.5, description="Blob-vs-vessel sensitivity (Rb term)")
    c: float = Field(500.0, description="Frobenius-norm background suppression threshold")


# ---------------------------------------------------------------------------
# Algorithm results
# ---------------------------------------------------------------------------


class AlgorithmResult(BaseModel):
    """Generic result envelope returned after running a processing algorithm."""

    uid: str = Field(..., description="Input study UID")
    status: str = Field(..., description="'ok' or 'error'")
    result: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Centerline / pathfinding
# ---------------------------------------------------------------------------


class PointValidateRequest(BaseModel):
    """Request to validate a world-space anchor point."""

    world: list[float] = Field(..., description="World-space coordinate [x, y, z] in mm")


class PathAnchorIn(BaseModel):
    """Single anchor point sent to the extract-path endpoint."""

    type: str = Field(..., description="'ostium' | 'waypoint' | 'distal'")
    world: list[float] = Field(..., description="World-space coordinate [x, y, z] in mm")


class ExtractPathRequest(BaseModel):
    """Request to extract a piecewise shortest path through consecutive anchors."""

    vessel: str = Field(..., description="Vessel label, e.g. 'LAD'")
    anchors: list[PathAnchorIn] = Field(..., description="Ordered list of anchors (ostium … distal)")
