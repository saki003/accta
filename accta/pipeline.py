"""Top-level orchestrator mapping all QAngio pipeline stages 0-ingest through 12-edit."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def run_pipeline(dicom_dir: Path, output_dir: Path, *, stages: list[int] | None = None) -> dict[str, Any]:
    """Execute the full (or partial) accta pipeline.

    Parameters
    ----------
    dicom_dir:
        Directory containing the input DICOM series.
    output_dir:
        Directory where all stage outputs will be written.
    stages:
        Optional list of stage indices to run.  Runs all stages when *None*.

    Returns
    -------
    dict[str, Any]
        Mapping of stage name → stage result object.
    """
    raise NotImplementedError
