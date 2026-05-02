"""MPR (Multi-Planar Reconstruction) rendering utilities for the accta viewer."""

from __future__ import annotations

import numpy as np
import matplotlib
matplotlib.use("Agg")                       # non-interactive backend for Streamlit
import matplotlib.pyplot as plt
from matplotlib.figure import Figure

# ---------------------------------------------------------------------------
# Window / level presets  (WL, WW) in HU
# ---------------------------------------------------------------------------

WINDOW_PRESETS: dict[str, tuple[float, float]] = {
    "Cardiac / Angio": (300.0,  800.0),
    "Soft Tissue":     ( 40.0,  400.0),
    "Lung":            (-600.0, 1500.0),
    "Bone":            (500.0,  2000.0),
    "Full range":      (  0.0,  4096.0),
}

_BG = "#111111"


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------


def apply_window(arr: np.ndarray, wl: float, ww: float) -> np.ndarray:
    """Map HU values through a window/level transform to [0, 1] float32."""
    lo = wl - ww / 2.0
    hi = wl + ww / 2.0
    span = max(hi - lo, 1.0)
    return np.clip((arr.astype(np.float64) - lo) / span, 0.0, 1.0).astype(np.float32)


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# MPR figure
# ---------------------------------------------------------------------------


def render_mpr(
    arr: np.ndarray,
    spacing: tuple[float, float, float],
    ax_z: int,
    cor_y: int,
    sag_x: int,
    wl: float = 300.0,
    ww: float = 800.0,
) -> Figure:
    """Render a four-panel coronary CTA workstation layout.

    Layout
    ------
    ┌─────────────┬─────────────────────┐
    │  Axial CCTA │  Curved / straight  │
    │   (top-L)   │  MPR  (top-R)       │
    ├─────────────┼─────────────────────┤
    │  Cross-sect │  MIP overview       │
    │  vessel (BL)│  (bottom-R)         │
    └─────────────┴─────────────────────┘

    * **Top-left**   – Axial CCTA view with coronal + sagittal crosshairs.
    * **Top-right**  – Coronal (straightened / longitudinal vessel) MPR,
      superior up.
    * **Bottom-left** – Sagittal cross-section (perpendicular to the vessel).
    * **Bottom-right** – Maximum Intensity Projection (MIP) of the axial slab
      centred on ``ax_z``, acting as a 3-D overview.

    Crosshair colours
    -----------------
    * Gold  (#FFD700) – axial plane indicator in coronal / sagittal.
    * Cyan  (#00E5FF) – sagittal/coronal plane in other views.

    Parameters
    ----------
    arr:
        3-D float32 numpy array in **(nz, ny, nx)** voxel order.
    spacing:
        SimpleITK-convention spacing tuple ``(sx, sy, sz)`` in mm.
    ax_z, cor_y, sag_x:
        Slice indices; clamped to valid range automatically.
    wl, ww:
        Window level and width in HU.

    Returns
    -------
    matplotlib.figure.Figure
        Call ``plt.close(fig)`` after rendering to release memory.
    """
    nz, ny, nx = arr.shape
    sx, sy, sz = float(spacing[0]), float(spacing[1]), float(spacing[2])

    ax_z  = _clamp(ax_z,  0, nz - 1)
    cor_y = _clamp(cor_y, 0, ny - 1)
    sag_x = _clamp(sag_x, 0, nx - 1)

    w = apply_window(arr, wl, ww)

    # ── Slice extraction ────────────────────────────────────────────────────
    axial    = w[ax_z, :, :]              # (ny, nx)  rows=y  cols=x
    coronal  = np.flipud(w[:, cor_y, :])  # (nz, nx)  rows=z↑ cols=x
    sagittal = np.flipud(w[:, :, sag_x])  # (nz, ny)  rows=z↑ cols=y

    # MIP: max over a 10 mm slab centred on ax_z
    slab_half = max(1, int(round(5.0 / sz)))
    z0 = max(0, ax_z - slab_half)
    z1 = min(nz, ax_z + slab_half + 1)
    mip = w[z0:z1].max(axis=0)            # (ny, nx)

    # ── Aspect ratios ───────────────────────────────────────────────────────
    asp_ax   = sy / sx
    asp_cor  = sz / sx
    asp_sag  = sz / sy
    asp_mip  = sy / sx                    # same as axial

    flipped_ax = nz - 1 - ax_z           # crosshair row after flipud

    # ── Figure layout ───────────────────────────────────────────────────────
    fig = plt.figure(figsize=(16, 10), facecolor=_BG)
    gs  = fig.add_gridspec(
        2, 2,
        wspace=0.03, hspace=0.05,
        left=0.005, right=0.995,
        top=0.955, bottom=0.025,
    )
    ax_tl = fig.add_subplot(gs[0, 0])    # top-left  : axial
    ax_tr = fig.add_subplot(gs[0, 1])    # top-right : coronal MPR
    ax_bl = fig.add_subplot(gs[1, 0])    # bottom-L  : sagittal cross-section
    ax_br = fig.add_subplot(gs[1, 1])    # bottom-R  : MIP overview

    def _panel(ax, img, asp, title, h_line, v_line,
               h_color="#FFD700", v_color="#00E5FF"):
        ax.imshow(img, cmap="gray", aspect=asp,
                  interpolation="bilinear", vmin=0.0, vmax=1.0)
        ax.axhline(h_line, color=h_color, lw=0.9, alpha=0.85)
        ax.axvline(v_line, color=v_color, lw=0.9, alpha=0.85)
        ax.set_facecolor(_BG)
        ax.set_title(title, color="#BBBBBB", fontsize=9, pad=3,
                     fontfamily="monospace")
        ax.set_xticks([])
        ax.set_yticks([])
        for sp in ax.spines.values():
            sp.set_edgecolor("#2a2a2a")

    # Top-left – Axial CCTA
    _panel(ax_tl, axial,    asp_ax,
           f"AXIAL  CCTA   z={ax_z}/{nz-1}",
           cor_y, sag_x)

    # Top-right – Coronal (longitudinal MPR)
    _panel(ax_tr, coronal,  asp_cor,
           f"CORONAL  MPR   y={cor_y}/{ny-1}",
           flipped_ax, sag_x)

    # Bottom-left – Sagittal cross-section
    _panel(ax_bl, sagittal, asp_sag,
           f"SAGITTAL  CROSS-SECT   x={sag_x}/{nx-1}",
           flipped_ax, cor_y)

    # Bottom-right – MIP overview (no crosshairs on MIP)
    slab_mm = round((z1 - z0) * sz, 1)
    ax_br.imshow(mip, cmap="gray", aspect=asp_mip,
                 interpolation="bilinear", vmin=0.0, vmax=1.0)
    ax_br.set_facecolor(_BG)
    ax_br.set_title(
        f"MIP OVERVIEW   slab {slab_mm} mm  (z={z0}–{z1-1})",
        color="#BBBBBB", fontsize=9, pad=3, fontfamily="monospace",
    )
    ax_br.axhline(cor_y, color="#FFD700", lw=0.7, alpha=0.6)
    ax_br.axvline(sag_x, color="#00E5FF", lw=0.7, alpha=0.6)
    ax_br.set_xticks([])
    ax_br.set_yticks([])
    for sp in ax_br.spines.values():
        sp.set_edgecolor("#2a2a2a")

    return fig
