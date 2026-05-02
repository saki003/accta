"""QAngio stage 6-aorta: segment the ascending aorta from the blood-pool mask."""

from __future__ import annotations

import numpy as np
import SimpleITK as sitk
from skimage.feature import canny
from skimage.measure import label, regionprops
from skimage.transform import hough_circle, hough_circle_peaks


def detect_aorta(
    img: sitk.Image,
    blood_pool_mask: sitk.Image,
    hough_slices: int = 10,
) -> sitk.Image:
    """Detect and segment the ascending aorta lumen from a blood-pool mask.

    Algorithm
    ---------
    1. **Hough seed** – for each of the first *hough_slices* axial slices,
       apply Canny edge detection to the binary blood-pool slice and run
       :func:`skimage.transform.hough_circle` over a physiological radius
       range (8–25 mm).  The best single circle per slice is collected; the
       median centre ``(col, row)`` and median radius across slices become
       the aorta seed.

    2. **Slice-by-slice region growing** – iterate through every axial slice;
       among all connected components of the blood pool, keep the one whose
       centroid lies within ``1.5 × seed_radius`` of the previous centre.
       Two stopping conditions terminate the growing early:

       * Centre shift exceeds **5 mm** between consecutive accepted slices.
       * Mean CT intensity of the accepted component falls **below 100 HU**.

    Parameters
    ----------
    img:
        Float32 CT volume (HU units).
    blood_pool_mask:
        Binary uint8 mask from stage 3-blood-pool.
    hough_slices:
        Number of axial slices used to estimate the aorta seed.

    Returns
    -------
    sitk.Image
        Binary uint8 aorta-lumen mask with the same geometry as *img*.
    """
    img_arr = sitk.GetArrayFromImage(sitk.Cast(img, sitk.sitkFloat32))  # (nz,ny,nx)
    bp_arr = sitk.GetArrayFromImage(blood_pool_mask).astype(np.uint8)   # (nz,ny,nx)

    spacing = img.GetSpacing()      # (sx, sy, sz) in mm
    sp_xy = float(spacing[0])       # x-y voxel size (isotropic assumed)

    nz = img_arr.shape[0]
    n_probe = min(hough_slices, nz)

    # Candidate radii in voxels covering the physiological aorta range 8–25 mm
    r_min = max(3, int(round(8.0 / sp_xy)))
    r_max = min(img_arr.shape[2] // 3, int(round(25.0 / sp_xy)))
    if r_min >= r_max:
        r_max = r_min + 2
    candidate_radii = np.arange(r_min, r_max + 1)

    # ------------------------------------------------------------------
    # Stage 1: Hough circle detection on the first n_probe slices
    # ------------------------------------------------------------------
    det_cols: list[int] = []
    det_rows: list[int] = []
    det_radii: list[float] = []

    for z in range(n_probe):
        sl = bp_arr[z]
        if sl.sum() < 10:
            continue

        # Canny edge image; fall back to binary mask if edge is too sparse
        edge = canny(sl.astype(np.float32))
        if int(edge.sum()) < 5:
            edge = sl > 0

        hspaces = hough_circle(edge, candidate_radii)
        # hough_circle_peaks returns (accums, cx, cy, radii)
        # cx = column (x), cy = row (y)
        accums, cx_arr, cy_arr, r_arr = hough_circle_peaks(
            hspaces, candidate_radii, num_peaks=1,
        )
        if len(cx_arr) > 0:
            det_cols.append(int(cx_arr[0]))
            det_rows.append(int(cy_arr[0]))
            det_radii.append(float(r_arr[0]))

    if not det_cols:
        empty = sitk.Image(img.GetSize(), sitk.sitkUInt8)
        empty.CopyInformation(img)
        return empty

    seed_col = int(np.median(det_cols))
    seed_row = int(np.median(det_rows))
    seed_r = float(np.median(det_radii))

    # ------------------------------------------------------------------
    # Stage 2: Connected-component region growing slice by slice
    # ------------------------------------------------------------------
    aorta = np.zeros_like(bp_arr, dtype=np.uint8)
    prev_col = float(seed_col)
    prev_row = float(seed_row)

    for z in range(nz):
        sl_bp = bp_arr[z]
        if sl_bp.sum() == 0:
            continue

        labeled = label(sl_bp)
        props = regionprops(labeled)

        # Find the component whose centroid is closest to the previous centre
        # and within the 1.5 × seed_r proximity gate
        best_prop = None
        best_dist = np.inf
        for prop in props:
            row_p, col_p = prop.centroid          # (row, col) convention
            dist = np.hypot(col_p - prev_col, row_p - prev_row)
            if dist <= 1.5 * seed_r and dist < best_dist:
                best_dist = dist
                best_prop = prop

        if best_prop is None:
            continue

        row_p, col_p = best_prop.centroid

        # Stopping condition 1: centre shift > 5 mm
        shift_mm = np.hypot(col_p - prev_col, row_p - prev_row) * sp_xy
        if shift_mm > 5.0:
            break

        # Stopping condition 2: mean HU in component < 100 HU
        mask_pixels = img_arr[z][labeled == best_prop.label]
        if float(mask_pixels.mean()) < 100.0:
            break

        aorta[z] = (labeled == best_prop.label).astype(np.uint8)
        prev_col, prev_row = col_p, row_p

    out = sitk.GetImageFromArray(aorta)
    out.CopyInformation(img)
    return sitk.Cast(out, sitk.sitkUInt8)
