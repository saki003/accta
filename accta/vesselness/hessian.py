"""QAngio stage 4-hessian: multi-scale Hessian-based vesselness filter."""

from __future__ import annotations

import numpy as np
import SimpleITK as sitk
from scipy.ndimage import gaussian_filter


def frangi_vesselness(
    img: sitk.Image,
    sigma_min: float = 0.5,
    sigma_max: float = 3.0,
    sigma_steps: int = 3,
    alpha: float = 0.5,
    beta: float = 0.5,
    c: float = 500.0,
    roi_mask: np.ndarray | None = None,
    cancel_ev=None,  # threading.Event — checked between sigma scales for cancellation
    tau: float = 0.5,
) -> tuple[sitk.Image, sitk.Image, sitk.Image]:
    """Multi-scale Frangi vesselness filter for bright tubular structures.

    Implements Frangi et al. (1998) "Multiscale vessel enhancement filtering"
    in 3-D.  At each of *sigma_steps* log-spaced scales, the scale-normalised
    Hessian is computed, eigenvalues are extracted, and the Frangi score is
    evaluated.  The per-voxel maximum over all scales is returned together with
    the scale at which that maximum was attained.

    Parameters
    ----------
    img:
        Float32 CT volume.  HU units are assumed; *c* is scaled accordingly.
    sigma_min / sigma_max / sigma_steps:
        Log-spaced Gaussian scales in mm.
    alpha / beta / c:
        Frangi shape and noise suppression parameters.
    roi_mask:
        Optional bool array (same shape as img). When provided, the
        eigendecomposition is only run on ROI voxels, skipping the majority
        of the volume and reducing runtime 3-5×.
    """
    img_f = sitk.Cast(img, sitk.sitkFloat32)
    arr = sitk.GetArrayFromImage(img_f).astype(np.float32)   # (nz, ny, nx), float32

    spacing = img_f.GetSpacing()[0]

    sigmas: np.ndarray = np.logspace(
        np.log10(sigma_min), np.log10(sigma_max), sigma_steps
    )

    nz, ny, nx = arr.shape
    n_vox = nz * ny * nx

    best_response = np.zeros(arr.shape, dtype=np.float32)
    best_scale    = np.full(arr.shape, sigmas[0], dtype=np.float32)
    best_axis     = np.zeros((nz, ny, nx, 3), dtype=np.float32)

    # Precompute ROI flat indices once
    if roi_mask is not None:
        roi_flat = roi_mask.ravel()
        roi_idx  = np.where(roi_flat)[0]
    else:
        roi_idx = None

    for sigma_mm in sigmas:
        if cancel_ev is not None and cancel_ev.is_set():
            from accta.api.cancellation import Cancelled
            raise Cancelled()
        sigma_vox = sigma_mm / spacing
        s2 = sigma_vox ** 2

        Hxx = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[0, 0, 2])).ravel()
        Hxy = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[0, 1, 1])).ravel()
        Hxz = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[1, 0, 1])).ravel()
        Hyy = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[0, 2, 0])).ravel()
        Hyz = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[1, 1, 0])).ravel()
        Hzz = (s2 * gaussian_filter(arr, sigma=sigma_vox, order=[2, 0, 0])).ravel()

        if roi_idx is not None:
            # Only build and decompose H for ROI voxels
            n_roi = len(roi_idx)
            H = np.empty((n_roi, 3, 3), dtype=np.float32)
            H[:, 0, 0] = Hxx[roi_idx];  H[:, 0, 1] = Hxy[roi_idx]; H[:, 0, 2] = Hxz[roi_idx]
            H[:, 1, 0] = Hxy[roi_idx];  H[:, 1, 1] = Hyy[roi_idx]; H[:, 1, 2] = Hyz[roi_idx]
            H[:, 2, 0] = Hxz[roi_idx];  H[:, 2, 1] = Hyz[roi_idx]; H[:, 2, 2] = Hzz[roi_idx]

            ev, evec = np.linalg.eigh(H)   # (n_roi,3), (n_roi,3,3)

            abs_order = np.argsort(np.abs(ev), axis=1)
            ev   = np.take_along_axis(ev, abs_order, axis=1)
            evec = evec[np.arange(n_roi)[:, None, None],
                        np.arange(3)[None, :, None],
                        abs_order[:, None, :]]

            l1_r, l2_r, l3_r = ev[:, 0], ev[:, 1], ev[:, 2]
            axis_r = evec[:, :, 0]   # (n_roi, 3)

            # Expand back to full volume
            l1 = np.zeros(n_vox, dtype=np.float32)
            l2 = np.zeros(n_vox, dtype=np.float32)
            l3 = np.zeros(n_vox, dtype=np.float32)
            l1[roi_idx] = l1_r;  l2[roi_idx] = l2_r;  l3[roi_idx] = l3_r

            tube_axis = np.zeros((n_vox, 3), dtype=np.float32)
            tube_axis[roi_idx] = axis_r
        else:
            H = np.empty((n_vox, 3, 3), dtype=np.float32)
            H[:, 0, 0] = Hxx;  H[:, 0, 1] = Hxy;  H[:, 0, 2] = Hxz
            H[:, 1, 0] = Hxy;  H[:, 1, 1] = Hyy;  H[:, 1, 2] = Hyz
            H[:, 2, 0] = Hxz;  H[:, 2, 1] = Hyz;  H[:, 2, 2] = Hzz

            ev, evec = np.linalg.eigh(H)
            abs_order = np.argsort(np.abs(ev), axis=1)
            ev   = np.take_along_axis(ev, abs_order, axis=1)
            evec = evec[np.arange(n_vox)[:, None, None],
                        np.arange(3)[None, :, None],
                        abs_order[:, None, :]]
            l1, l2, l3 = ev[:, 0], ev[:, 1], ev[:, 2]
            tube_axis = evec[:, :, 0]

        valid = (l2 < 0.0) & (l3 < 0.0)

        abs_l2 = np.abs(l2)
        abs_l3 = np.abs(l3)

        # ── λ₃ regularization (Cui et al. 2019, eq. 20) ────────────────
        # Voxels with |λ₃| smaller than τ·max|λ₃| (noisy / low-contrast)
        # have their value clamped UP to τ·max|λ₃|.  This prevents the
        # Ra=|λ₂|/|λ₃| ratio from blowing up in low-signal regions and
        # also caps the dynamic range so calcium-driven extreme |λ₃|
        # don't dominate the scale.
        # Outside-ROI voxels are zero in abs_l3 (eigendecomposition was skipped),
        # so the global max equals the ROI max — no need to mask explicitly.
        max_abs_l3 = float(abs_l3.max()) if abs_l3.size > 0 else 0.0
        threshold = tau * max_abs_l3 if max_abs_l3 > 0 else 0.0
        abs_l3_reg    = np.maximum(abs_l3, threshold)
        abs_l2l3_sqrt = np.sqrt(abs_l2 * abs_l3_reg)
        safe = valid & (abs_l3_reg > 1e-10) & (abs_l2l3_sqrt > 1e-10)

        safe_l3   = np.where(abs_l3_reg > 1e-10, abs_l3_reg, 1.0)
        safe_l2l3 = np.where(abs_l2l3_sqrt > 1e-10, abs_l2l3_sqrt, 1.0)
        Ra = np.where(safe, abs_l2 / safe_l3,   0.0)
        Rb = np.where(safe, np.abs(l1) / safe_l2l3, 0.0)
        S2 = l1 ** 2 + l2 ** 2 + l3 ** 2  # raw λ — no regularization here

        V: np.ndarray = np.where(
            safe,
            (1.0 - np.exp(-Ra ** 2 / (2.0 * alpha ** 2)))
            * np.exp(-Rb ** 2 / (2.0 * beta ** 2))
            * (1.0 - np.exp(-S2 / (2.0 * c ** 2))),
            0.0,
        ).astype(np.float32).reshape(nz, ny, nx)

        np.clip(V, 0.0, 1.0, out=V)

        better = V > best_response
        best_response = np.where(better, V, best_response)
        best_scale    = np.where(better, float(sigma_mm), best_scale)

        axis_reshape = tube_axis.reshape(nz, ny, nx, 3)
        flip = np.sign(axis_reshape[..., 0])
        flip = np.where(flip == 0, 1.0, flip)
        axis_reshape = axis_reshape * flip[..., np.newaxis]

        best_axis = np.where(better[..., np.newaxis], axis_reshape, best_axis)

    response_img = sitk.GetImageFromArray(best_response)
    response_img.CopyInformation(img_f)

    scale_img = sitk.GetImageFromArray(best_scale)
    scale_img.CopyInformation(img_f)

    orient_img = sitk.GetImageFromArray(best_axis.astype(np.float32))
    orient_img.CopyInformation(img_f)

    return response_img, scale_img, orient_img
