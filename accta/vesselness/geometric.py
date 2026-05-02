"""Geometry-based ray-cast tubularity weight for the Frangi vesselness map."""

from __future__ import annotations

import numpy as np
import SimpleITK as sitk
from scipy.ndimage import map_coordinates

# 26-connected neighbourhood directions (unit-normalised)
_RAW_DIRS = np.array(
    [(dz, dy, dx)
     for dz in (-1, 0, 1)
     for dy in (-1, 0, 1)
     for dx in (-1, 0, 1)
     if not (dz == 0 and dy == 0 and dx == 0)],
    dtype=np.float64,
)
_DIRS: np.ndarray = _RAW_DIRS / np.linalg.norm(_RAW_DIRS, axis=1, keepdims=True)
_N_DIRS = len(_DIRS)  # 26


def geometric_weight(
    vesselness: sitk.Image,
    scale: sitk.Image,
    orientation: sitk.Image | None = None,
    large_scale_threshold: float = 1.5,
    ves_threshold: float = 0.08,
    n_steps: int = 6,
) -> sitk.Image:
    """Apply ray-cast tubularity weighting to a Frangi vesselness map.

    When *orientation* is provided (the Hessian tube-axis eigenvector map),
    rays are cast along and perpendicular to the local vessel axis rather than
    along the fixed 26-connected grid.  This gives a more accurate
    along-vs-across comparison:

    * **Along-axis rays** (±tube_axis): integrate vesselness in the vessel
      direction — high for a long vessel, low at a tube end.
    * **Across-axis rays** (4 orthogonal directions in the cross-section
      plane): integrate vesselness perpendicular to the vessel — should drop
      quickly for a thin tube.

    Tubularity score: ``G = along_sum / (along_sum + across_sum + ε)``
    Tube → G ≈ 1; plate/chamber → G ≈ 0 (across dominates).

    When *orientation* is ``None``, falls back to the generic 26-direction
    grid with top-2 scoring.

    Parameters
    ----------
    vesselness:
        Float32 Frangi vesselness map, values in ``[0, 1]``.
    scale:
        Float32 scale map (sigma in mm) from :func:`frangi_vesselness`.
    orientation:
        Float32 3-component vector image (tube-axis eigenvector per voxel,
        z-y-x order) from :func:`frangi_vesselness`.  May be ``None``.
    large_scale_threshold:
        Sigma (mm) above which geometry weighting is applied.
    ves_threshold:
        Minimum vesselness to be considered a candidate voxel.
    n_steps:
        Ray length in voxels.
    """
    ves_arr   = sitk.GetArrayFromImage(vesselness).astype(np.float32)
    scale_arr = sitk.GetArrayFromImage(scale).astype(np.float32)
    nz, ny, nx = ves_arr.shape

    cand_mask = (scale_arr >= large_scale_threshold) & (ves_arr >= ves_threshold)
    cand_idx  = np.argwhere(cand_mask)  # (N, 3) z,y,x

    result = ves_arr.copy()

    if len(cand_idx) == 0:
        out = sitk.GetImageFromArray(result)
        out.CopyInformation(vesselness)
        return out

    steps = np.arange(1, n_steps + 1, dtype=np.float64)

    def _ray_sum(directions: np.ndarray) -> np.ndarray:
        """Integrate vesselness along each direction for all candidates.
        directions: (D, 3).  Returns (N, D) array of summed responses."""
        integrals = np.zeros((len(cand_idx), len(directions)), dtype=np.float64)
        base = cand_idx[:, np.newaxis, :].astype(np.float64)
        for d_idx, d in enumerate(directions):
            coords = base + d[np.newaxis, np.newaxis, :] * steps[np.newaxis, :, np.newaxis]
            coords[..., 0] = np.clip(coords[..., 0], 0, nz - 1)
            coords[..., 1] = np.clip(coords[..., 1], 0, ny - 1)
            coords[..., 2] = np.clip(coords[..., 2], 0, nx - 1)
            flat = coords.reshape(-1, 3).T
            samples = map_coordinates(ves_arr, flat, order=1, mode='nearest')
            integrals[:, d_idx] = samples.reshape(len(cand_idx), n_steps).sum(axis=1)
        return integrals

    if orientation is not None:
        # orientation image: shape (nz, ny, nx, 3), components ordered z,y,x
        orient_arr = sitk.GetArrayFromImage(orientation).astype(np.float32)  # (nz,ny,nx,3)
        cz, cy, cx = cand_idx[:, 0], cand_idx[:, 1], cand_idx[:, 2]
        axes = orient_arr[cz, cy, cx]  # (N, 3) — tube-axis unit vectors

        # Build per-voxel orthonormal cross-section basis (2 perpendicular dirs)
        # Use Gram-Schmidt against a reference vector that isn't collinear with axis
        x_ref = np.array([1., 0., 0.])
        y_ref = np.array([0., 1., 0.])
        use_x = (np.abs(axes[:, 0]) < 0.9)[:, None]   # (N, 1) — broadcast over xyz
        ref = np.where(use_x, x_ref, y_ref).astype(np.float64)  # (N, 3)
        perp1 = ref - (ref * axes).sum(axis=1, keepdims=True) * axes
        norms = np.linalg.norm(perp1, axis=1, keepdims=True)
        perp1 /= np.where(norms > 1e-8, norms, 1.0)
        perp2 = np.cross(axes, perp1)  # (N, 3)

        # Along-axis rays: ±tube_axis → (N, 2) integrals summed
        along_dirs_pos = axes          # (N,3) — one direction per candidate
        along_dirs_neg = -axes

        # Across-axis rays: ±perp1, ±perp2 → 4 directions per candidate
        # We evaluate each set of per-voxel directions using a vectorised loop
        def _per_voxel_ray(dirs: np.ndarray) -> np.ndarray:
            """dirs: (N,3) — one unique direction per candidate. Returns (N,) integral."""
            integrals = np.zeros(len(cand_idx), dtype=np.float64)
            base = cand_idx.astype(np.float64)
            for s in steps:
                coords = base + dirs * s                           # (N,3)
                coords[:, 0] = np.clip(coords[:, 0], 0, nz - 1)
                coords[:, 1] = np.clip(coords[:, 1], 0, ny - 1)
                coords[:, 2] = np.clip(coords[:, 2], 0, nx - 1)
                integrals += map_coordinates(ves_arr, coords.T, order=1, mode='nearest')
            return integrals

        along_sum = _per_voxel_ray(along_dirs_pos) + _per_voxel_ray(along_dirs_neg)
        across_sum = (
            _per_voxel_ray(perp1) + _per_voxel_ray(-perp1)
            + _per_voxel_ray(perp2) + _per_voxel_ray(-perp2)
        )

        tube_score = along_sum / (along_sum + across_sum + 1e-6)
        tube_score = np.clip(tube_score.astype(np.float32), 0.0, 1.0)

    else:
        # Fallback: fixed 26-direction grid, top-2 scoring
        ray_integrals = _ray_sum(_DIRS)
        sorted_integrals = np.sort(ray_integrals, axis=1)[:, ::-1]
        total = ray_integrals.sum(axis=1)
        top2  = sorted_integrals[:, 0] + sorted_integrals[:, 1]
        raw   = top2 / (total + 1e-6)
        iso_floor  = 2.0 / _N_DIRS
        tube_score = np.clip((raw - iso_floor) / (1.0 - iso_floor + 1e-6), 0.0, 1.0).astype(np.float32)
        cz, cy, cx = cand_idx[:, 0], cand_idx[:, 1], cand_idx[:, 2]

    result[cz, cy, cx] *= tube_score

    out = sitk.GetImageFromArray(result)
    out.CopyInformation(vesselness)
    return out
