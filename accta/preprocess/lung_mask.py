"""QAngio stage 2-lung-mask: segment lung tissue to restrict downstream search."""

from __future__ import annotations

import SimpleITK as sitk


def remove_lung_vessels(
    img: sitk.Image,
    lung_threshold_hu: float = -400.0,
    closing_radius_mm: float = 10.0,
) -> sitk.Image:
    """Zero out lung-region voxels so downstream filters ignore lung vessels.

    The Hessian vesselness filter responds strongly to pulmonary vessels,
    which would otherwise appear as false-positive coronary candidates.
    This step suppresses them by:

    1. Thresholding below *lung_threshold_hu* to obtain a coarse lung-air
       binary mask.
    2. Applying a spherical morphological closing of radius
       *closing_radius_mm* to fill parenchymal vessels and airways into a
       solid lung region.
    3. Setting all voxels inside that region to 0 HU in a float32 copy of
       the input.

    Parameters
    ----------
    img:
        Resampled CT volume (float32, HU units expected).
    lung_threshold_hu:
        Voxels at or below this value seed the lung-air binary mask.
    closing_radius_mm:
        Morphological closing ball radius in millimetres.  Converted to
        voxels using the first (x) spacing component of *img*.

    Returns
    -------
    sitk.Image
        Float32 volume with the same size, spacing, origin, and direction as
        *img*; lung-region voxels replaced with 0 HU.
    """
    img_f = sitk.Cast(img, sitk.sitkFloat32)

    # Build lung-air seed mask (1 = lung air, 0 = tissue)
    lung_air = sitk.BinaryThreshold(
        img_f,
        lowerThreshold=-32768.0,
        upperThreshold=float(lung_threshold_hu),
        insideValue=1,
        outsideValue=0,
    )

    # Closing fills parenchymal vessels/airways into a solid lung region.
    # Radius is given in mm; convert to voxels using isotropic spacing.
    spacing_mm = img_f.GetSpacing()[0]
    closing_radius_vox = max(1, int(round(closing_radius_mm / spacing_mm)))

    closing = sitk.BinaryMorphologicalClosingImageFilter()
    closing.SetKernelType(sitk.sitkBall)
    closing.SetKernelRadius(closing_radius_vox)
    lung_region = closing.Execute(lung_air)

    # Zero out lung-region voxels: output = img * (1 - lung_region)
    lung_region_f = sitk.Cast(lung_region, sitk.sitkFloat32)
    inv_mask = sitk.Cast(
        sitk.InvertIntensity(lung_region, maximum=1),
        sitk.sitkFloat32,
    )
    return sitk.Multiply(img_f, inv_mask)
