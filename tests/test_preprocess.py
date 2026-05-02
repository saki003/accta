"""Tests for accta.preprocess modules (resample, lung_mask, blood_pool)."""

from __future__ import annotations

import numpy as np
import pytest
import SimpleITK as sitk

from accta.preprocess.blood_pool import extract_blood_pool_mask
from accta.preprocess.lung_mask import remove_lung_vessels
from accta.preprocess.resample import resample


# ---------------------------------------------------------------------------
# Phantom helpers
# ---------------------------------------------------------------------------


def _uniform_image(
    value: float,
    shape: tuple[int, int, int] = (32, 32, 32),
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> sitk.Image:
    arr = np.full(shape, value, dtype=np.float32)
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing(spacing)
    return img


def _sphere_phantom(
    shape: tuple[int, int, int] = (32, 32, 32),
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
    bg_hu: float = -1024.0,
    sphere_hu: float = 300.0,
    radius_vox: int = 6,
) -> sitk.Image:
    """Float32 image filled with *bg_hu*, sphere of *sphere_hu* at centre."""
    arr = np.full(shape, bg_hu, dtype=np.float32)
    nz, ny, nx = shape
    z, y, x = np.mgrid[0:nz, 0:ny, 0:nx]
    cz, cy, cx = nz // 2, ny // 2, nx // 2
    inside = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= radius_vox ** 2
    arr[inside] = sphere_hu
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing(spacing)
    return img


def _lung_phantom(
    shape: tuple[int, int, int] = (32, 32, 32),
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> sitk.Image:
    """Float32 image: lung-air region (HU = -800) in a central slab,
    soft-tissue fill (HU = 50) everywhere else."""
    arr = np.full(shape, 50.0, dtype=np.float32)
    # Low-HU slab occupying the left quarter – simulates lung air
    arr[:, :, : shape[2] // 4] = -800.0
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing(spacing)
    return img


# ---------------------------------------------------------------------------
# resample tests
# ---------------------------------------------------------------------------


def test_resample_spacing() -> None:
    """Output spacing must equal (target_spacing,) * 3 for any input spacing."""
    img = _uniform_image(0.0, spacing=(1.0, 1.0, 2.0))
    out = resample(img, target_spacing=0.5)
    assert out.GetSpacing() == pytest.approx((0.5, 0.5, 0.5))


def test_resample_spacing_already_isotropic() -> None:
    """Already-isotropic input still produces correct output spacing."""
    img = _uniform_image(0.0, spacing=(0.5, 0.5, 0.5))
    out = resample(img, target_spacing=0.5)
    assert out.GetSpacing() == pytest.approx((0.5, 0.5, 0.5))


def test_resample_output_shape_consistent_with_spacing() -> None:
    """Output size must be consistent with the input physical extent."""
    orig_size = (16, 16, 16)
    orig_spacing = (1.0, 1.0, 1.0)
    target = 0.5
    img = _uniform_image(0.0, shape=orig_size, spacing=orig_spacing)
    out = resample(img, target_spacing=target)
    expected_size = tuple(
        round(orig_size[i] * orig_spacing[i] / target) for i in range(3)
    )
    assert out.GetSize() == expected_size


def test_resample_preserves_origin_and_direction() -> None:
    """Origin and direction cosines must be unchanged after resampling."""
    img = _uniform_image(0.0, spacing=(1.0, 1.0, 1.0))
    origin = (10.0, -5.0, 3.5)
    img.SetOrigin(origin)
    out = resample(img, target_spacing=0.5)
    assert out.GetOrigin() == pytest.approx(origin)
    assert out.GetDirection() == pytest.approx(img.GetDirection())


def test_hu_ceiling() -> None:
    """No output voxel must exceed hu_ceil after resampling."""
    hu_ceil = 1500.0
    # Fill with a value well above the ceiling
    img = _uniform_image(3000.0, spacing=(1.0, 1.0, 1.0))
    out = resample(img, target_spacing=0.5, hu_ceil=hu_ceil)
    arr = sitk.GetArrayFromImage(out)
    assert float(arr.max()) <= hu_ceil + 1e-4


def test_hu_ceiling_exact_when_uniform() -> None:
    """When every input voxel is above hu_ceil, every output voxel equals it."""
    hu_ceil = 800.0
    img = _uniform_image(2000.0, spacing=(1.0, 1.0, 1.0))
    out = resample(img, target_spacing=1.0, hu_ceil=hu_ceil)  # same spacing → no interpolation blur
    arr = sitk.GetArrayFromImage(out)
    assert float(arr.max()) == pytest.approx(hu_ceil, abs=1e-3)
    assert float(arr.min()) == pytest.approx(hu_ceil, abs=1e-3)


def test_resample_output_is_float32() -> None:
    """Output pixel type must be float32 regardless of input type."""
    arr = np.zeros((16, 16, 16), dtype=np.int16)
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((1.0, 1.0, 1.0))
    out = resample(img)
    assert out.GetPixelID() == sitk.sitkFloat32


# ---------------------------------------------------------------------------
# lung_mask tests
# ---------------------------------------------------------------------------


def test_lung_mask_dims() -> None:
    """Output image must have the same size as the input."""
    img = _lung_phantom(shape=(32, 32, 32), spacing=(1.0, 1.0, 1.0))
    # Use a small closing radius so the test stays fast
    out = remove_lung_vessels(img, lung_threshold_hu=-400.0, closing_radius_mm=2.0)
    assert out.GetSize() == img.GetSize()


def test_lung_mask_preserves_spacing() -> None:
    """Output spacing must match input spacing."""
    img = _lung_phantom(spacing=(0.5, 0.5, 0.5))
    out = remove_lung_vessels(img, closing_radius_mm=1.0)
    assert out.GetSpacing() == pytest.approx(img.GetSpacing())


def test_lung_mask_zeros_out_air_region() -> None:
    """Voxels that were deeply negative (lung air) must be 0 in the output."""
    img = _lung_phantom(shape=(32, 32, 32), spacing=(1.0, 1.0, 1.0))
    out = remove_lung_vessels(img, lung_threshold_hu=-400.0, closing_radius_mm=2.0)
    arr = sitk.GetArrayFromImage(out)
    # The -800 HU column is in the first quarter (x-indices 0..7).
    # After masking, those voxels should be 0, not -800.
    assert float(arr[:, :, 0].max()) == pytest.approx(0.0, abs=1e-4)


def test_lung_mask_preserves_non_lung_region() -> None:
    """Tissue voxels well above the lung threshold must be unchanged."""
    img = _lung_phantom(shape=(32, 32, 32), spacing=(1.0, 1.0, 1.0))
    out = remove_lung_vessels(img, lung_threshold_hu=-400.0, closing_radius_mm=2.0)
    arr_in = sitk.GetArrayFromImage(sitk.Cast(img, sitk.sitkFloat32))
    arr_out = sitk.GetArrayFromImage(out)
    # The rightmost column (far from the lung slab) should be unchanged (50 HU)
    np.testing.assert_allclose(
        arr_in[:, :, -1], arr_out[:, :, -1], atol=1e-4
    )


# ---------------------------------------------------------------------------
# blood_pool tests
# ---------------------------------------------------------------------------


def test_blood_pool_binary() -> None:
    """Output mask must contain only 0 and 1."""
    img = _sphere_phantom(sphere_hu=300.0)
    mask = extract_blood_pool_mask(img, low_hu=150.0, high_hu=500.0)
    arr = sitk.GetArrayViewFromImage(mask)
    unique = set(arr.flat)
    assert unique <= {0, 1}


def test_blood_pool_pixel_type() -> None:
    """Output must be uint8."""
    mask = extract_blood_pool_mask(_sphere_phantom())
    assert mask.GetPixelID() == sitk.sitkUInt8


def test_blood_pool_detects_sphere() -> None:
    """A sphere of contrast-HU voxels must produce a non-empty mask."""
    img = _sphere_phantom(sphere_hu=300.0, radius_vox=6)
    mask = extract_blood_pool_mask(img, low_hu=150.0, high_hu=500.0)
    arr = sitk.GetArrayViewFromImage(mask)
    assert arr.sum() > 0, "expected a non-empty blood-pool mask"


def test_blood_pool_single_component() -> None:
    """Only the largest component is kept; isolated small blobs are removed."""
    shape = (32, 32, 32)
    arr = np.full(shape, -1024.0, dtype=np.float32)
    # Large sphere at centre
    z, y, x = np.mgrid[0:32, 0:32, 0:32]
    arr[(x - 16) ** 2 + (y - 16) ** 2 + (z - 16) ** 2 <= 36] = 300.0
    # Tiny isolated blob (2 voxels) far from centre
    arr[1, 1, 1] = 300.0
    arr[1, 1, 2] = 300.0
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((1.0, 1.0, 1.0))

    mask = extract_blood_pool_mask(img, low_hu=150.0, high_hu=500.0)
    arr_mask = sitk.GetArrayViewFromImage(mask)

    # The tiny blob at [1,1,1] and [1,1,2] must be absent
    assert arr_mask[1, 1, 1] == 0
    assert arr_mask[1, 1, 2] == 0

    # The central sphere must still be present
    assert arr_mask[16, 16, 16] == 1


def test_blood_pool_no_contrast_gives_empty_mask() -> None:
    """An image without contrast-enhanced voxels must return an all-zero mask."""
    img = _uniform_image(-1024.0)
    mask = extract_blood_pool_mask(img, low_hu=150.0, high_hu=500.0)
    arr = sitk.GetArrayViewFromImage(mask)
    assert arr.sum() == 0
