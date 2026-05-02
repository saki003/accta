"""Edge-preserving denoising via curvature anisotropic diffusion."""

from __future__ import annotations

import SimpleITK as sitk


def denoise_anisotropic(
    img: sitk.Image,
    conductance: float = 2.0,
    iterations: int = 5,
    time_step: float = 0.0625,
) -> sitk.Image:
    """Apply curvature anisotropic diffusion to a CT volume.

    Smooths homogeneous regions while preserving vessel walls and other edges.
    The filter requires a float32 image; casting is handled internally.

    Parameters
    ----------
    img:
        Input SimpleITK image (any scalar type).
    conductance:
        Edge sensitivity. Lower values preserve sharper edges; typical range 1–4.
    iterations:
        Number of diffusion iterations. 5–10 is usually sufficient.
    time_step:
        Stability limit for 3-D volumes (1/2^ndim = 0.0625). Keep fixed.
    """
    img_f = sitk.Cast(img, sitk.sitkFloat32)

    filt = sitk.CurvatureAnisotropicDiffusionImageFilter()
    filt.SetConductanceParameter(conductance)
    filt.SetNumberOfIterations(iterations)
    filt.SetTimeStep(time_step)

    return filt.Execute(img_f)
