"""Tests for accta.io.dicom and accta.io.persistence."""

from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pytest
import SimpleITK as sitk

from accta.io.dicom import load_dicom
from accta.io.persistence import load_analysis_zip, save_analysis_zip


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_volume(size: tuple[int, int, int] = (16, 16, 16), spacing: float = 0.5) -> sitk.Image:
    """Return a float32 SimpleITK image filled with random values."""
    arr = np.random.default_rng(0).random(size, dtype=np.float32)
    img = sitk.GetImageFromArray(arr)
    img.SetSpacing((spacing, spacing, spacing))
    return img


# ---------------------------------------------------------------------------
# dicom.py tests
# ---------------------------------------------------------------------------


def test_load_dicom_bad_extension(tmp_path: Path) -> None:
    """load_dicom must raise ValueError for unrecognised file extensions."""
    bogus = tmp_path / "scan.xyz"
    bogus.write_bytes(b"not an image")
    with pytest.raises(ValueError, match="Unrecognised image source"):
        load_dicom(bogus)


def test_load_dicom_bad_extension_variant(tmp_path: Path) -> None:
    """.nrrd is real but not in our supported set – must still raise ValueError."""
    bogus = tmp_path / "scan.nrrd"
    bogus.write_bytes(b"NRRD0001")
    with pytest.raises(ValueError):
        load_dicom(bogus)


def test_load_dicom_image_zip_raises_not_implemented(tmp_path: Path) -> None:
    """A zip that contains lkebdrs_description.xml must raise NotImplementedError."""
    zip_path = tmp_path / "image.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("lkebdrs_description.xml", "<root/>")
    with pytest.raises(NotImplementedError):
        load_dicom(zip_path)


def test_load_dicom_analysis_zip(tmp_path: Path) -> None:
    """load_dicom on an analysis zip returns the resampled sitk.Image."""
    vol = _make_volume()
    zip_path = tmp_path / "analysis.zip"
    save_analysis_zip(
        zip_path,
        volumes={"resampled": vol},
        graph={"vertices": [], "edges": [], "branch_meta": {}},
        metadata={"source_uid": "test-001", "voxel_spacing": [0.5, 0.5, 0.5]},
    )
    result = load_dicom(zip_path)
    assert isinstance(result, sitk.Image)
    assert result.GetSize() == vol.GetSize()


def test_load_dicom_analysis_zip_missing_resampled_raises(tmp_path: Path) -> None:
    """load_dicom on an analysis zip with no resampled volume must raise ValueError."""
    zip_path = tmp_path / "empty_analysis.zip"
    save_analysis_zip(
        zip_path,
        volumes={},
        graph={"vertices": [], "edges": [], "branch_meta": {}},
        metadata={"source_uid": "test-002", "voxel_spacing": [0.5, 0.5, 0.5]},
    )
    with pytest.raises(ValueError, match="resampled"):
        load_dicom(zip_path)


# ---------------------------------------------------------------------------
# persistence.py tests
# ---------------------------------------------------------------------------


def test_roundtrip_persistence(tmp_path: Path) -> None:
    """save_analysis_zip followed by load_analysis_zip must faithfully restore
    a 16×16×16 volume, a graph, and metadata."""
    vol = _make_volume((16, 16, 16), spacing=0.5)
    original_arr = sitk.GetArrayFromImage(vol)

    graph_in = {
        "vertices": [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]],
        "edges": [[0, 1]],
        "branch_meta": {"0-1": {"label": "LAD", "length_mm": 3.74}},
    }
    metadata_in = {
        "source_uid": "patient-42",
        "voxel_spacing": [0.5, 0.5, 0.5],
    }

    zip_path = tmp_path / "result.zip"
    save_analysis_zip(
        zip_path,
        volumes={"resampled": vol, "vesselness": None},
        graph=graph_in,
        metadata=metadata_in,
    )

    assert zip_path.exists()

    volumes_out, graph_out, metadata_out = load_analysis_zip(zip_path)

    # --- volumes ---
    assert volumes_out["resampled"] is not None
    restored_arr = sitk.GetArrayFromImage(volumes_out["resampled"])
    np.testing.assert_allclose(original_arr, restored_arr, atol=1e-5)
    assert volumes_out["resampled"].GetSize() == (16, 16, 16)
    assert volumes_out["vesselness"] is None

    # --- graph ---
    assert graph_out["vertices"] == graph_in["vertices"]
    assert graph_out["edges"] == graph_in["edges"]
    assert graph_out["branch_meta"] == graph_in["branch_meta"]

    # --- metadata ---
    assert metadata_out["source_uid"] == "patient-42"
    assert metadata_out["voxel_spacing"] == [0.5, 0.5, 0.5]
    assert "version" in metadata_out
    assert "created_at" in metadata_out


def test_roundtrip_all_volume_keys(tmp_path: Path) -> None:
    """All five recognised volume keys survive a save/load round-trip."""
    keys = ("resampled", "vesselness", "vesselness_scale", "tree_labels", "unconnected_fragments")
    volumes_in = {k: _make_volume() for k in keys}

    zip_path = tmp_path / "all_vols.zip"
    save_analysis_zip(
        zip_path,
        volumes=volumes_in,
        graph={"vertices": [], "edges": [], "branch_meta": {}},
        metadata={"source_uid": "vol-test", "voxel_spacing": [0.5, 0.5, 0.5]},
    )

    volumes_out, _, _ = load_analysis_zip(zip_path)

    for k in keys:
        assert volumes_out[k] is not None, f"Volume '{k}' was not restored"
        np.testing.assert_allclose(
            sitk.GetArrayFromImage(volumes_in[k]),
            sitk.GetArrayFromImage(volumes_out[k]),
            atol=1e-5,
            err_msg=f"Volume '{k}' data mismatch after round-trip",
        )


def test_zip_internal_layout(tmp_path: Path) -> None:
    """The zip archive must contain the expected member paths."""
    vol = _make_volume()
    zip_path = tmp_path / "layout.zip"
    save_analysis_zip(
        zip_path,
        volumes={"resampled": vol},
        graph={"vertices": [], "edges": [], "branch_meta": {}},
        metadata={"source_uid": "layout-test", "voxel_spacing": [0.5, 0.5, 0.5]},
    )

    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())

    assert "metadata.json" in names
    assert "volumes/resampled.nii.gz" in names
    assert "tree/graph.json" in names
    assert "aorta/centerline.json" in names
    assert "tree/pathlines.json" in names
    assert "edits/modifications.json" in names
    # vesselness was not provided – must be absent
    assert "volumes/vesselness.nii.gz" not in names


def test_metadata_version_injected(tmp_path: Path) -> None:
    """save_analysis_zip must inject 'version' even when caller omits it."""
    zip_path = tmp_path / "version.zip"
    save_analysis_zip(
        zip_path,
        volumes={},
        graph={"vertices": [], "edges": [], "branch_meta": {}},
        metadata={"source_uid": "x", "voxel_spacing": []},
    )
    _, _, meta = load_analysis_zip(zip_path)
    assert meta["version"] == "1.0"
    assert "created_at" in meta
