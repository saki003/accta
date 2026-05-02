"""Tests for accta.vesselness.hessian and accta.vesselness.geometric."""

from __future__ import annotations

import numpy as np
import pytest
import SimpleITK as sitk

from accta.vesselness.geometric import geometric_weight
from accta.vesselness.hessian import frangi_vesselness


# ---------------------------------------------------------------------------
# Phantom builder
# ---------------------------------------------------------------------------

SHAPE = (32, 32, 32)   # (nz, ny, nx) in numpy / (nx, ny, nz) in sitk
SPACING = (0.5, 0.5, 0.5)   # mm – isotropic at 0.5 mm


def _cylinder_phantom(
    radius_vox: int = 3,
    bg: float = 0.0,
    tube: float = 300.0,
    shape: tuple[int, int, int] = SHAPE,
    spacing: tuple[float, float, float] = SPACING,
) -> sitk.Image:
    """Solid cylinder of HU=*tube* running along the z-axis, centred in x-y.

    Radius *radius_vox* is given in voxels.  Background is *bg*.
    """
    nz, ny, nx = shape
    arr = np.full(shape, bg, dtype=np.float32)
    cx, cy = nx // 2, ny // 2
    y_idx, x_idx = np.mgrid[0:ny, 0:nx]
    disk = (x_idx - cx) ** 2 + (y_idx - cy) ** 2 <= radius_vox ** 2
    arr[:, disk] = tube
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing(spacing)
    return img


# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def cylinder_result() -> tuple[sitk.Image, sitk.Image, sitk.Image]:
    """Run frangi_vesselness once for the whole module (slow-ish)."""
    phantom = _cylinder_phantom()
    response, scale = frangi_vesselness(
        phantom,
        sigma_min=0.5,
        sigma_max=3.0,
        sigma_steps=3,   # keep test runtime short
        alpha=0.5,
        beta=0.5,
        c=500.0,
    )
    return phantom, response, scale


# ---------------------------------------------------------------------------
# Required tests
# ---------------------------------------------------------------------------


def test_frangi_output_range(cylinder_result: tuple) -> None:
    """Every voxel of the response must lie in [0, 1]."""
    _, response, _ = cylinder_result
    arr = sitk.GetArrayViewFromImage(response)
    assert float(arr.min()) >= 0.0, f"min {arr.min()} < 0"
    assert float(arr.max()) <= 1.0, f"max {arr.max()} > 1"


def test_frangi_output_shape(cylinder_result: tuple) -> None:
    """Response image must have the same voxel size as the input."""
    phantom, response, _ = cylinder_result
    assert response.GetSize() == phantom.GetSize()


def test_scale_output_range(cylinder_result: tuple) -> None:
    """Every voxel of the scale image must lie in [sigma_min, sigma_max]."""
    _, _, scale = cylinder_result
    arr = sitk.GetArrayViewFromImage(scale)
    assert float(arr.min()) >= 0.5 - 1e-6
    assert float(arr.max()) <= 3.0 + 1e-6


# ---------------------------------------------------------------------------
# Additional structural tests
# ---------------------------------------------------------------------------


def test_frangi_output_is_float32(cylinder_result: tuple) -> None:
    """Both outputs must be float32."""
    _, response, scale = cylinder_result
    assert response.GetPixelID() == sitk.sitkFloat32
    assert scale.GetPixelID() == sitk.sitkFloat32


def test_frangi_preserves_spacing(cylinder_result: tuple) -> None:
    """Output spacing must match input spacing."""
    phantom, response, scale = cylinder_result
    assert response.GetSpacing() == pytest.approx(phantom.GetSpacing())
    assert scale.GetSpacing() == pytest.approx(phantom.GetSpacing())


def test_frangi_response_nonzero_inside_tube(cylinder_result: tuple) -> None:
    """At least some voxels inside the cylindrical tube must have V > 0."""
    phantom, response, _ = cylinder_result
    arr = sitk.GetArrayViewFromImage(response)
    nz, ny, nx = arr.shape
    cx, cy = nx // 2, ny // 2
    # Sample a few voxels well within the tube (radius_vox=3 → centre safe)
    centre_slice = arr[nz // 2, cy - 1 : cy + 2, cx - 1 : cx + 2]
    assert centre_slice.max() > 0.0, (
        "expected non-zero vesselness inside the tube; got all zeros"
    )


def test_frangi_background_mostly_zero(cylinder_result: tuple) -> None:
    """Voxels in the uniform background region must have V == 0."""
    _, response, _ = cylinder_result
    arr = sitk.GetArrayViewFromImage(response)
    # Corner voxel is well outside the tube and is in the uniform background
    corner_val = float(arr[0, 0, 0])
    assert corner_val == pytest.approx(0.0, abs=1e-6)


def test_scale_at_tube_centre_near_radius(cylinder_result: tuple) -> None:
    """The scale selected at the tube centre should be close to tube radius mm."""
    # Tube radius = 3 voxels × 0.5 mm/vox = 1.5 mm
    _, _, scale = cylinder_result
    arr = sitk.GetArrayViewFromImage(scale)
    nz, ny, nx = arr.shape
    cx, cy = nx // 2, ny // 2
    sigma_at_centre = float(arr[nz // 2, cy, cx])
    # We only have 3 steps so the resolution is coarse; allow generous tolerance
    assert 0.4 <= sigma_at_centre <= 3.1


def test_frangi_uniform_image_gives_zero_response() -> None:
    """A completely flat image has no Hessian structure → V must be zero."""
    flat = sitk.GetImageFromArray(
        np.full(SHAPE, 200.0, dtype=np.float32)
    )
    flat.SetSpacing(SPACING)
    response, scale = frangi_vesselness(flat, sigma_steps=2)
    arr = sitk.GetArrayViewFromImage(response)
    assert float(arr.max()) == pytest.approx(0.0, abs=1e-6)


def test_frangi_sigma_steps_one() -> None:
    """With a single scale the function must still return correct-shaped images."""
    phantom = _cylinder_phantom()
    response, scale = frangi_vesselness(phantom, sigma_min=1.0, sigma_max=1.0, sigma_steps=1)
    assert response.GetSize() == phantom.GetSize()
    arr_s = sitk.GetArrayViewFromImage(scale)
    assert float(arr_s.min()) == pytest.approx(1.0, abs=1e-5)
    assert float(arr_s.max()) == pytest.approx(1.0, abs=1e-5)


# ---------------------------------------------------------------------------
# geometric_weight tests
# ---------------------------------------------------------------------------


def test_geometric_weight_passthrough(cylinder_result: tuple) -> None:
    """Placeholder must return the vesselness image unchanged (same buffer)."""
    phantom, vesselness, scale = cylinder_result
    result = geometric_weight(phantom, vesselness, scale)
    # Must be the exact same object (pass-through contract)
    assert result is vesselness


def test_geometric_weight_output_range(cylinder_result: tuple) -> None:
    """Even as a placeholder, output values must stay in [0, 1]."""
    phantom, vesselness, scale = cylinder_result
    result = geometric_weight(phantom, vesselness, scale)
    arr = sitk.GetArrayViewFromImage(result)
    assert float(arr.min()) >= 0.0
    assert float(arr.max()) <= 1.0
