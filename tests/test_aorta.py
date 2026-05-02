"""Tests for accta.aorta.segment and accta.aorta.centerline."""

from __future__ import annotations

import numpy as np
import pytest
import SimpleITK as sitk
from skimage.draw import disk

from accta.aorta.centerline import aorta_centerline
from accta.aorta.segment import detect_aorta


# ---------------------------------------------------------------------------
# Phantom builder
# ---------------------------------------------------------------------------

SHAPE = (64, 64, 64)      # (nz, ny, nx)
SPACING = (1.0, 1.0, 1.0) # mm – isotropic 1 mm so radius_vox == radius_mm
TUBE_HU = 300.0
BG_HU = 0.0
TUBE_ROW = 32             # row (y) centre of tube in each slice
TUBE_COL = 32             # col (x) centre of tube in each slice
TUBE_RADIUS_VOX = 12      # 12 voxels = 12 mm at 1 mm spacing


def _make_tube_phantom() -> tuple[sitk.Image, sitk.Image]:
    """Return (ct_image, blood_pool_mask) with a solid cylinder along z."""
    nz, ny, nx = SHAPE
    ct_arr = np.full(SHAPE, BG_HU, dtype=np.float32)
    bp_arr = np.zeros(SHAPE, dtype=np.uint8)

    rr, cc = disk((TUBE_ROW, TUBE_COL), TUBE_RADIUS_VOX, shape=(ny, nx))
    for z in range(nz):
        ct_arr[z, rr, cc] = TUBE_HU
        bp_arr[z, rr, cc] = 1

    ct_img = sitk.GetImageFromArray(ct_arr)
    ct_img.SetSpacing(SPACING)

    bp_img = sitk.GetImageFromArray(bp_arr)
    bp_img.SetSpacing(SPACING)

    return ct_img, bp_img


# Shared phantom (built once per module)
@pytest.fixture(scope="module")
def tube_phantom() -> tuple[sitk.Image, sitk.Image]:
    return _make_tube_phantom()


@pytest.fixture(scope="module")
def aorta_mask(tube_phantom: tuple) -> sitk.Image:
    ct_img, bp_img = tube_phantom
    return detect_aorta(ct_img, bp_img, hough_slices=10)


# ---------------------------------------------------------------------------
# Required tests
# ---------------------------------------------------------------------------


def test_hough_circle_detects_tube(
    tube_phantom: tuple, aorta_mask: sitk.Image
) -> None:
    """detect_aorta must return a non-empty mask whose centroid is close to
    the known tube centre (col=32, row=32) in an arbitrary middle slice."""
    arr = sitk.GetArrayFromImage(aorta_mask)   # (nz, ny, nx)
    assert arr.sum() > 0, "aorta mask is empty – no circle was detected"

    # Check centre position in a mid-stack slice
    mid_z = SHAPE[0] // 2
    mid_slice = arr[mid_z]
    assert mid_slice.sum() > 0, f"slice z={mid_z} is empty in the aorta mask"

    # Centroid of detected region should be within 2 voxels of known centre
    rows, cols = np.where(mid_slice > 0)
    centroid_row = float(rows.mean())
    centroid_col = float(cols.mean())

    assert abs(centroid_row - TUBE_ROW) <= 2.0, (
        f"row centroid {centroid_row:.1f} is too far from expected {TUBE_ROW}"
    )
    assert abs(centroid_col - TUBE_COL) <= 2.0, (
        f"col centroid {centroid_col:.1f} is too far from expected {TUBE_COL}"
    )


def test_centerline_length(aorta_mask: sitk.Image) -> None:
    """Number of centreline points must equal the number of non-empty axial
    slices in the aorta mask."""
    arr = sitk.GetArrayFromImage(aorta_mask)
    non_empty_slices = int((arr.sum(axis=(1, 2)) > 0).sum())

    result = aorta_centerline(aorta_mask)
    assert len(result["points"]) == non_empty_slices, (
        f"centreline has {len(result['points'])} points "
        f"but mask has {non_empty_slices} non-empty slices"
    )
    assert len(result["radii"]) == non_empty_slices


# ---------------------------------------------------------------------------
# Additional tests
# ---------------------------------------------------------------------------


def test_detect_aorta_output_type(aorta_mask: sitk.Image) -> None:
    """detect_aorta must return a uint8 binary mask."""
    assert aorta_mask.GetPixelID() == sitk.sitkUInt8
    arr = sitk.GetArrayViewFromImage(aorta_mask)
    assert set(arr.flat) <= {0, 1}


def test_detect_aorta_preserves_geometry(
    tube_phantom: tuple, aorta_mask: sitk.Image
) -> None:
    """Output mask must have the same size and spacing as the input."""
    ct_img, _ = tube_phantom
    assert aorta_mask.GetSize() == ct_img.GetSize()
    assert aorta_mask.GetSpacing() == pytest.approx(ct_img.GetSpacing())


def test_detect_aorta_covers_most_slices(aorta_mask: sitk.Image) -> None:
    """For a straight tube with constant HU, growing must cover most slices."""
    arr = sitk.GetArrayViewFromImage(aorta_mask)
    covered = int((arr.sum(axis=(1, 2)) > 0).sum())
    # The tube runs all 64 slices; allow at most 2 slice losses (boundary effects)
    assert covered >= SHAPE[0] - 2, (
        f"only {covered}/{SHAPE[0]} slices covered – growing stopped too early"
    )


def test_detect_aorta_empty_blood_pool() -> None:
    """detect_aorta on an all-zero blood-pool mask must return an all-zero mask."""
    nz, ny, nx = (16, 16, 16)
    ct_arr = np.zeros((nz, ny, nx), dtype=np.float32)
    bp_arr = np.zeros((nz, ny, nx), dtype=np.uint8)

    ct_img = sitk.GetImageFromArray(ct_arr)
    ct_img.SetSpacing((1.0, 1.0, 1.0))
    bp_img = sitk.GetImageFromArray(bp_arr)
    bp_img.SetSpacing((1.0, 1.0, 1.0))

    result = detect_aorta(ct_img, bp_img, hough_slices=5)
    arr = sitk.GetArrayViewFromImage(result)
    assert arr.sum() == 0


def test_centerline_physical_coords(aorta_mask: sitk.Image) -> None:
    """Centreline x,y coordinates must map to voxel locations near the tube centre."""
    result = aorta_centerline(aorta_mask)
    assert len(result["points"]) > 0

    spacing = aorta_mask.GetSpacing()
    origin = aorta_mask.GetOrigin()

    x_expected_mm = origin[0] + TUBE_COL * spacing[0]
    y_expected_mm = origin[1] + TUBE_ROW * spacing[1]

    for pt in result["points"]:
        assert abs(pt[0] - x_expected_mm) <= 3.0, (
            f"point x={pt[0]:.1f} is too far from expected {x_expected_mm}"
        )
        assert abs(pt[1] - y_expected_mm) <= 3.0, (
            f"point y={pt[1]:.1f} is too far from expected {y_expected_mm}"
        )


def test_centerline_radii_near_tube_radius(aorta_mask: sitk.Image) -> None:
    """Equivalent-circle radii must be close to the known tube radius (12 mm)."""
    result = aorta_centerline(aorta_mask)
    assert len(result["radii"]) > 0

    for r in result["radii"]:
        assert abs(r - TUBE_RADIUS_VOX) <= 2.0, (
            f"radius {r:.2f} mm is too far from expected {TUBE_RADIUS_VOX} mm"
        )


def test_centerline_empty_mask() -> None:
    """aorta_centerline on an all-zero mask must return empty lists."""
    empty = sitk.Image((32, 32, 32), sitk.sitkUInt8)
    empty.SetSpacing((1.0, 1.0, 1.0))
    result = aorta_centerline(empty)
    assert result["points"] == []
    assert result["radii"] == []
