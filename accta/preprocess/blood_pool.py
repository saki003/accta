"""QAngio stage 3-blood-pool: threshold the contrast-enhanced blood pool."""

from __future__ import annotations

import SimpleITK as sitk


def extract_blood_pool_mask(
    img: sitk.Image,
    low_hu: float = 150.0,
    high_hu: float = 500.0,
) -> sitk.Image:
    """Return a binary mask of the dominant contrast-enhanced blood pool.

    Steps:
    1. Threshold the image to ``[low_hu, high_hu]`` – the HU window that
       captures contrast-enhanced blood while excluding bone (> 500 HU)
       and soft tissue (< 150 HU).
    2. Label connected components and sort them by descending volume.
    3. Retain only the largest component (the cardiac pool / great vessels).

    Parameters
    ----------
    img:
        Resampled CT volume (float32 or int16, HU units).
    low_hu:
        Lower bound of the contrast-agent intensity window.
    high_hu:
        Upper bound of the contrast-agent intensity window.

    Returns
    -------
    sitk.Image
        Binary uint8 mask (1 = blood pool, 0 = background) with the same
        size, spacing, origin, and direction as *img*.
    """
    # Step 1 – intensity threshold
    binary = sitk.BinaryThreshold(
        sitk.Cast(img, sitk.sitkFloat32),
        lowerThreshold=float(low_hu),
        upperThreshold=float(high_hu),
        insideValue=1,
        outsideValue=0,
    )

    # Step 2 – connected-component labelling (largest component = label 1)
    cc = sitk.ConnectedComponent(binary)
    relabeled = sitk.RelabelComponent(cc, sortByObjectSize=True)

    # Step 3 – keep label 1 only
    largest = sitk.BinaryThreshold(
        relabeled,
        lowerThreshold=1,
        upperThreshold=1,
        insideValue=1,
        outsideValue=0,
    )
    return sitk.Cast(largest, sitk.sitkUInt8)
