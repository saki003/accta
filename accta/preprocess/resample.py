"""QAngio stage 1-resample: isotropic resampling of the CT volume."""

from __future__ import annotations

import logging

import SimpleITK as sitk

logger = logging.getLogger(__name__)


def resample(
    img: sitk.Image,
    target_spacing: float = 0.5,
    hu_floor: float = -32768.0,
    hu_ceil: float = 1500.0,
) -> sitk.Image:
    """Resample *img* to isotropic voxels and suppress calcification peaks.

    Steps:
    1. Cast to float32.
    2. Clamp pixel values at *hu_ceil* (removes calcification spikes that
       would otherwise inflate the Hessian response).
    3. Resample to ``(target_spacing, target_spacing, target_spacing)`` mm
       using linear interpolation.  Origin and direction cosines are
       preserved exactly.

    Parameters
    ----------
    img:
        Input CT volume.  Any pixel type is accepted; output is float32.
    target_spacing:
        Isotropic target voxel size in millimetres.
    hu_ceil:
        Upper HU clamp value applied before resampling.

    Returns
    -------
    sitk.Image
        Float32 volume with spacing ``(target_spacing,) * 3``.
    """
    img_f = sitk.Cast(img, sitk.sitkFloat32)
    img_f = sitk.Clamp(img_f, lowerBound=float(hu_floor), upperBound=float(hu_ceil))

    orig_spacing = img_f.GetSpacing()   # (sx, sy, sz) mm
    orig_size = img_f.GetSize()         # (nx, ny, nz) voxels

    new_size = [
        max(1, int(round(orig_size[i] * orig_spacing[i] / target_spacing)))
        for i in range(3)
    ]
    new_spacing = (target_spacing, target_spacing, target_spacing)

    logger.info(
        "resample: size %s @ spacing %s mm  ->  size %s @ spacing %s mm",
        tuple(orig_size), tuple(orig_spacing), tuple(new_size), new_spacing,
    )

    resampler = sitk.ResampleImageFilter()
    resampler.SetOutputSpacing(new_spacing)
    resampler.SetSize(new_size)
    resampler.SetOutputOrigin(img_f.GetOrigin())
    resampler.SetOutputDirection(img_f.GetDirection())
    resampler.SetInterpolator(sitk.sitkLinear)
    resampler.SetDefaultPixelValue(-1024.0)
    return resampler.Execute(img_f)
