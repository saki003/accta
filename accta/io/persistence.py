"""QAngio stage 11-save: serialise and deserialise pipeline artefacts."""

from __future__ import annotations

import io
import json
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import SimpleITK as sitk

# ---------------------------------------------------------------------------
# Analysis-zip contract
# ---------------------------------------------------------------------------
#
# Layout inside the zip:
#   metadata.json
#   volumes/<name>.nii.gz          (only present keys are written)
#   aorta/centerline.json
#   tree/graph.json
#   tree/pathlines.json
#   edits/modifications.json
#
# volumes dict keys (all optional, value = sitk.Image | None):
#   resampled, vesselness, vesselness_scale, tree_labels, unconnected_fragments
#
# graph dict keys (JSON-serialisable):
#   vertices, edges, branch_meta
#
# metadata dict keys:
#   version, source_uid, voxel_spacing, created_at

_VOLUME_KEYS: tuple[str, ...] = (
    "resampled",
    "vesselness",
    "vesselness_scale",
    "tree_labels",
    "unconnected_fragments",
)

_FORMAT_VERSION = "1.0"


def save_analysis_zip(
    path: str | Path,
    volumes: dict[str, sitk.Image | None],
    graph: dict[str, Any],
    metadata: dict[str, Any],
) -> None:
    """Serialise pipeline artefacts to a self-contained zip archive.

    Parameters
    ----------
    path:
        Destination ``.zip`` file path (created or overwritten).
    volumes:
        Mapping of volume name to ``sitk.Image`` (or ``None`` to skip).
        Known keys: ``resampled``, ``vesselness``, ``vesselness_scale``,
        ``tree_labels``, ``unconnected_fragments``.
    graph:
        JSON-serialisable dict with keys ``vertices``, ``edges``,
        ``branch_meta``.
    metadata:
        Provenance dict; ``version`` and ``created_at`` are injected
        automatically when absent.
    """
    path = Path(path)

    # Ensure mandatory metadata fields have defaults
    meta_out: dict[str, Any] = {
        "version": _FORMAT_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        **metadata,
    }

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # ---- metadata -------------------------------------------------------
        zf.writestr("metadata.json", json.dumps(meta_out, indent=2))

        # ---- volumes --------------------------------------------------------
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            for key in _VOLUME_KEYS:
                image = volumes.get(key)
                if image is None:
                    continue
                tmp_file = tmp_path / f"{key}.nii.gz"
                sitk.WriteImage(image, str(tmp_file))
                zf.write(tmp_file, arcname=f"volumes/{key}.nii.gz")

        # ---- graph ----------------------------------------------------------
        graph_doc = {
            "vertices": graph.get("vertices", []),
            "edges": graph.get("edges", []),
            "branch_meta": graph.get("branch_meta", {}),
        }
        zf.writestr("tree/graph.json", json.dumps(graph_doc, indent=2))

        # ---- ancillary JSON stubs (written empty when not provided) ---------
        zf.writestr("aorta/centerline.json", json.dumps({}))
        zf.writestr("tree/pathlines.json", json.dumps([]))
        zf.writestr("edits/modifications.json", json.dumps([]))


def load_analysis_zip(
    path: str | Path,
) -> tuple[dict[str, sitk.Image | None], dict[str, Any], dict[str, Any]]:
    """Restore pipeline artefacts from a zip archive written by
    :func:`save_analysis_zip`.

    Parameters
    ----------
    path:
        Path to the ``.zip`` archive.

    Returns
    -------
    tuple[dict, dict, dict]
        ``(volumes, graph, metadata)`` where:

        * *volumes* – ``{name: sitk.Image | None}`` for each of the five
          known volume keys; absent keys map to ``None``.
        * *graph* – dict with ``vertices``, ``edges``, ``branch_meta``.
        * *metadata* – provenance dict from ``metadata.json``.
    """
    path = Path(path)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        with zipfile.ZipFile(path, "r") as zf:
            names = set(zf.namelist())

            # ---- metadata ---------------------------------------------------
            metadata: dict[str, Any] = json.loads(zf.read("metadata.json"))

            # ---- volumes ----------------------------------------------------
            volumes: dict[str, sitk.Image | None] = {}
            for key in _VOLUME_KEYS:
                arc_name = f"volumes/{key}.nii.gz"
                if arc_name in names:
                    dest = tmp_path / f"{key}.nii.gz"
                    dest.write_bytes(zf.read(arc_name))
                    volumes[key] = sitk.ReadImage(str(dest))
                else:
                    volumes[key] = None

            # ---- graph ------------------------------------------------------
            graph: dict[str, Any] = {"vertices": [], "edges": [], "branch_meta": {}}
            if "tree/graph.json" in names:
                graph_doc: dict[str, Any] = json.loads(zf.read("tree/graph.json"))
                graph.update(graph_doc)

    return volumes, graph, metadata


# ---------------------------------------------------------------------------
# Legacy single-file helpers (kept for backwards compatibility with pipeline.py)
# ---------------------------------------------------------------------------


def save_volume(image: sitk.Image, path: str | Path) -> None:
    """Write *image* to *path*; format is inferred from the file suffix."""
    sitk.WriteImage(image, str(Path(path)))


def load_volume(path: str | Path) -> sitk.Image:
    """Read a SimpleITK image from *path*."""
    return sitk.ReadImage(str(Path(path)))


def save_centerline(centerline: Any, path: str | Path) -> None:
    """Serialise *centerline* (list of points or networkx graph) to JSON."""
    import json

    path = Path(path)
    if hasattr(centerline, "nodes"):
        # networkx Graph
        import networkx as nx

        data = nx.node_link_data(centerline)
    else:
        # assume numpy array or list
        try:
            data = centerline.tolist()
        except AttributeError:
            data = list(centerline)

    path.write_text(json.dumps(data, indent=2))


def load_centerline(path: str | Path) -> Any:
    """Deserialise a centreline previously saved by :func:`save_centerline`.

    Returns a plain Python list (of point lists or node-link dict).
    """
    import json

    return json.loads(Path(path).read_text())
