"""accta MPR Viewer – Streamlit application.

Launch
------
    streamlit run accta/ui/app.py
    # or via the installed entry-point:
    accta-viewer
"""

from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import SimpleITK as sitk
import streamlit as st

from accta.io.dicom import load_dicom, _load_dicom_dir
from accta.ui.mpr import WINDOW_PRESETS, render_mpr

# ---------------------------------------------------------------------------
# Page configuration – must be first Streamlit call
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="accta – MPR Viewer",
    layout="wide",
    page_icon="🫀",
    initial_sidebar_state="expanded",
)

# Minimal dark-theme overrides (Streamlit theming is limited without a config file)
st.markdown(
    """
    <style>
      .block-container { padding-top: 0.8rem; padding-bottom: 0.5rem; }
      [data-testid="stSidebar"] { background-color: #16213e; }
      [data-testid="stSidebar"] .stMarkdown h2,
      [data-testid="stSidebar"] .stMarkdown h3 { color: #e0e0e0; }
      .stSlider label { font-size: 0.82rem; }
      div[data-testid="stFileUploadDropzone"] { border: 1px dashed #555; }
    </style>
    """,
    unsafe_allow_html=True,
)


# ---------------------------------------------------------------------------
# Volume loading helpers
# ---------------------------------------------------------------------------


def _sitk_to_array(img: sitk.Image) -> np.ndarray:
    """Cast to float32 and return (nz, ny, nx) numpy array."""
    return sitk.GetArrayFromImage(sitk.Cast(img, sitk.sitkFloat32))


def _load_from_upload(uploaded_file) -> tuple[np.ndarray, tuple, tuple]:
    """Save *uploaded_file* to a temp path, dispatch to ``load_dicom``.

    Returns ``(arr_float32, spacing, size_xyz)``.
    The numpy array is fully in-memory before the temp dir is deleted.
    """
    suffix = Path(uploaded_file.name).suffix.lower()
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / ("upload" + suffix)
        dest.write_bytes(uploaded_file.getvalue())
        img = load_dicom(dest)
        arr = _sitk_to_array(img)
        spacing = img.GetSpacing()
        size = img.GetSize()
    return arr, spacing, size


def _load_from_local_path(path_str: str) -> tuple[np.ndarray, tuple, tuple]:
    """Load from a local directory or file path."""
    img = load_dicom(path_str)
    arr = _sitk_to_array(img)
    return arr, img.GetSpacing(), img.GetSize()


# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------

with st.sidebar:
    st.markdown("## 🫀 accta Viewer")
    st.caption("Coronary CTA · Multi-Planar Reconstruction")
    st.markdown("---")

    # ── Load section ────────────────────────────────────────────────────────
    st.markdown("### 📂 Load Study")

    uploaded = st.file_uploader(
        "Upload file",
        type=["dcm", "zip", "mhd", "xml", "tif", "tiff"],
        label_visibility="collapsed",
        help=(
            "Supported formats:\n"
            "• **.zip** – DICOM series folder or accta analysis archive\n"
            "• **.dcm** – single/multi-frame DICOM\n"
            "• **.mhd** – MetaImage\n"
            "• **.tif/.tiff** – TIFF stack\n"
            "• **.xml** – DicomSeries manifest"
        ),
    )

    st.markdown("**or** enter a local path:")
    local_path_input = st.text_input(
        "Local path",
        placeholder="/Volumes/MyDrive/DICOM/PatientFolder",
        label_visibility="collapsed",
    )
    load_local_btn = st.button("📁 Load path", use_container_width=True)

    # ── Trigger loading ─────────────────────────────────────────────────────
    if uploaded is not None:
        file_key = (uploaded.name, uploaded.size)
        if st.session_state.get("_loaded_key") != file_key:
            with st.spinner(f"Loading  {uploaded.name} …"):
                try:
                    arr, spacing, size = _load_from_upload(uploaded)
                    st.session_state._arr        = arr
                    st.session_state._spacing    = spacing
                    st.session_state._size       = size
                    st.session_state._loaded_key  = file_key
                    st.session_state._loaded_name = uploaded.name
                    # Reset slice positions to the centre
                    st.session_state._ax_z  = arr.shape[0] // 2
                    st.session_state._cor_y = arr.shape[1] // 2
                    st.session_state._sag_x = arr.shape[2] // 2
                    st.toast(f"Loaded  {uploaded.name}", icon="✅")
                except Exception as exc:
                    st.error(f"**Load failed:** {exc}")

    if load_local_btn and local_path_input.strip():
        p = local_path_input.strip()
        with st.spinner(f"Loading  {p} …"):
            try:
                arr, spacing, size = _load_from_local_path(p)
                st.session_state._arr        = arr
                st.session_state._spacing    = spacing
                st.session_state._size       = size
                st.session_state._loaded_key  = p
                st.session_state._loaded_name = Path(p).name
                st.session_state._ax_z  = arr.shape[0] // 2
                st.session_state._cor_y = arr.shape[1] // 2
                st.session_state._sag_x = arr.shape[2] // 2
                st.toast("Loaded successfully", icon="✅")
            except Exception as exc:
                st.error(f"**Load failed:** {exc}")

    # ── Study info ──────────────────────────────────────────────────────────
    if "_arr" in st.session_state:
        arr   = st.session_state._arr
        sp    = st.session_state._spacing
        sz    = st.session_state._size

        st.markdown("---")
        st.markdown("### 📊 Study Info")
        st.caption(f"**{st.session_state._loaded_name}**")

        col_a, col_b = st.columns(2)
        with col_a:
            st.metric("Columns",  sz[0])
            st.metric("Rows",     sz[1])
            st.metric("Slices",   sz[2])
        with col_b:
            st.metric("Sp X mm", f"{sp[0]:.2f}")
            st.metric("Sp Y mm", f"{sp[1]:.2f}")
            st.metric("Sp Z mm", f"{sp[2]:.2f}")

        fov = tuple(round(sz[i] * sp[i], 1) for i in range(3))
        st.caption(f"FOV: {fov[0]} × {fov[1]} × {fov[2]} mm")
        hu_min = float(arr.min())
        hu_max = float(arr.max())
        st.caption(f"HU range: [{hu_min:.0f},  {hu_max:.0f}]")

    # ── Window / Level ──────────────────────────────────────────────────────
    st.markdown("---")
    st.markdown("### 🎛️ Window / Level")

    preset_names  = list(WINDOW_PRESETS.keys())
    chosen_preset = st.selectbox(
        "Preset",
        options=["Custom"] + preset_names,
        index=1,                  # default: Cardiac / Angio
        key="wl_preset",
    )

    # Apply preset values when the preset changes
    if chosen_preset != "Custom":
        preset_wl, preset_ww = WINDOW_PRESETS[chosen_preset]
        if chosen_preset != st.session_state.get("_last_preset"):
            st.session_state._wl = preset_wl
            st.session_state._ww = preset_ww
            st.session_state._last_preset = chosen_preset

    init_wl = int(st.session_state.get("_wl", 300))
    init_ww = int(st.session_state.get("_ww", 800))

    wl = st.slider("Level  WL (HU)", -1024, 3000, init_wl, step=5, key="wl_slider")
    ww = st.slider("Width  WW (HU)",     1, 5000, init_ww, step=5, key="ww_slider")
    st.session_state._wl = float(wl)
    st.session_state._ww = float(ww)

    st.markdown("---")
    st.caption("accta v0.1 · [source](https://github.com/)")

# ---------------------------------------------------------------------------
# Main area
# ---------------------------------------------------------------------------

st.markdown("## Multi-Planar Reconstruction")

if "_arr" not in st.session_state:
    st.info(
        "⬅️  **Upload a DICOM study** using the sidebar, "
        "or enter the path to a local folder."
    )
    st.markdown(
        """
        **Supported sources**

        | Format | How to load |
        |--------|-------------|
        | DICOM folder | Enter local path in sidebar |
        | DICOM series `.zip` | Upload via file picker |
        | accta analysis `.zip` | Upload via file picker |
        | `.dcm` / `.mhd` / `.tif` | Upload via file picker |
        """
    )
    st.stop()

# Retrieve state
arr     = st.session_state._arr
sp      = st.session_state._spacing
nz, ny, nx = arr.shape
wl_val  = st.session_state.get("_wl", 300.0)
ww_val  = st.session_state.get("_ww", 800.0)

# ── Slice navigation ────────────────────────────────────────────────────────
nav_col1, nav_col2, nav_col3 = st.columns(3)

with nav_col1:
    ax_z = st.slider(
        f"Axial  (z) — {nz} slices",
        0, nz - 1,
        st.session_state.get("_ax_z", nz // 2),
        key="sl_z",
    )

with nav_col2:
    cor_y = st.slider(
        f"Coronal  (y) — {ny} rows",
        0, ny - 1,
        st.session_state.get("_cor_y", ny // 2),
        key="sl_y",
    )

with nav_col3:
    sag_x = st.slider(
        f"Sagittal  (x) — {nx} cols",
        0, nx - 1,
        st.session_state.get("_sag_x", nx // 2),
        key="sl_x",
    )

# Persist positions so they survive preset changes
st.session_state._ax_z  = ax_z
st.session_state._cor_y = cor_y
st.session_state._sag_x = sag_x

# ── Render MPR ──────────────────────────────────────────────────────────────
fig = render_mpr(arr, sp, ax_z, cor_y, sag_x, wl_val, ww_val)
st.pyplot(fig, use_container_width=True)
plt.close(fig)

# ── HU info bar ─────────────────────────────────────────────────────────────
hu_ax  = arr[ax_z]
hu_cor = arr[:, cor_y, :]
hu_sag = arr[:, :, sag_x]

st.caption(
    f"Slice HU —  "
    f"**Axial z={ax_z}:** [{float(hu_ax.min()):.0f}, {float(hu_ax.max()):.0f}]  ·  "
    f"**Coronal y={cor_y}:** [{float(hu_cor.min()):.0f}, {float(hu_cor.max()):.0f}]  ·  "
    f"**Sagittal x={sag_x}:** [{float(hu_sag.min()):.0f}, {float(hu_sag.max()):.0f}]"
)
