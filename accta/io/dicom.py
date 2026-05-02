"""QAngio stage 0-ingest: read a DICOM series into a SimpleITK volume."""

from __future__ import annotations

import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import SimpleITK as sitk

# Sentinel file that marks a zip as a QAngio image archive rather than an
# analysis archive.  Its presence triggers the (not-yet-implemented) image-zip
# extraction path.
_IMAGE_ZIP_SENTINEL = "lkebdrs_description.xml"


def load_dicom(path: str | Path) -> sitk.Image:
    """Load a medical image from *path* and return a SimpleITK volume.

    Supported inputs
    ----------------
    * **Directory** – folder of DICOM slice files; the first DICOM series
      found via ``gdcm`` is loaded.
    * **.dcm** – single DICOM file (typically a multi-frame DICOM).
    * **.tif / .tiff** – TIFF stack readable by SimpleITK.
    * **.mhd** – MetaImage header (companion ``.raw`` must be alongside).
    * **.xml** – list of DICOM slice paths, one ``<File>`` element per
      slice inside a ``<DicomSeries>`` root::

          <DicomSeries>
            <File>/data/series/IM-0001-0001.dcm</File>
            <File>/data/series/IM-0001-0002.dcm</File>
          </DicomSeries>

    * **.zip** – if the archive contains ``lkebdrs_description.xml`` it is
      treated as a QAngio image zip (``NotImplementedError`` – not yet
      implemented); otherwise it is treated as an analysis zip and the
      ``resampled`` volume is extracted via
      :func:`accta.io.persistence.load_analysis_zip`.

    Parameters
    ----------
    path:
        File-system path to the image source.

    Returns
    -------
    sitk.Image
        3-D volume with physical spacing, origin, and direction cosines set.

    Raises
    ------
    ValueError
        When *path* does not match any recognised format.
    NotImplementedError
        When *path* is a QAngio image zip (``lkebdrs_description.xml`` present).
    """
    path = Path(path)

    if path.is_dir():
        return _load_dicom_dir(path)

    suffix = path.suffix.lower()

    if suffix == ".dcm":
        return sitk.ReadImage(str(path))

    if suffix in {".tif", ".tiff"}:
        return sitk.ReadImage(str(path))

    if suffix == ".mhd":
        return sitk.ReadImage(str(path))

    if suffix == ".xml":
        return _load_xml_series(path)

    if suffix == ".zip":
        return _load_zip(path)

    raise ValueError(
        f"Unrecognised image source: '{path}'.  "
        "Expected a directory, .dcm, .tif, .tiff, .mhd, .xml, or .zip path."
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_dicom_dir(directory: Path) -> sitk.Image:
    """Load the first DICOM series found in *directory*."""
    reader = sitk.ImageSeriesReader()
    series_ids = reader.GetGDCMSeriesIDs(str(directory))
    if not series_ids:
        raise ValueError(f"No DICOM series found in directory: '{directory}'")
    file_names = reader.GetGDCMSeriesFileNames(str(directory), series_ids[0])
    reader.SetFileNames(file_names)
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOn()
    return reader.Execute()


def _load_xml_series(xml_path: Path) -> sitk.Image:
    """Parse a ``<DicomSeries>`` XML manifest and load the listed slices."""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    file_paths = [elem.text.strip() for elem in root.iter("File") if elem.text]
    if not file_paths:
        raise ValueError(
            f"No <File> elements found in XML manifest: '{xml_path}'"
        )

    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(file_paths)
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOn()
    return reader.Execute()


def _load_zip(zip_path: Path) -> sitk.Image:
    """Dispatch a zip archive to the correct loader.

    Priority
    --------
    1. QAngio image zip (``lkebdrs_description.xml`` present) → NotImplementedError.
    2. accta analysis zip (``metadata.json`` present) → load resampled volume.
    3. Plain DICOM series zip → extract to temp dir, load as DICOM directory.
    """
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())

    if _IMAGE_ZIP_SENTINEL in names:
        raise NotImplementedError(
            f"QAngio image-zip loading is not yet implemented "
            f"(detected sentinel '{_IMAGE_ZIP_SENTINEL}' in '{zip_path}')."
        )

    if "metadata.json" in names:
        from accta.io.persistence import load_analysis_zip  # local import avoids cycle

        volumes, _graph, _meta = load_analysis_zip(zip_path)
        resampled = volumes.get("resampled")
        if resampled is None:
            raise ValueError(
                f"Analysis zip '{zip_path}' does not contain a 'resampled' volume."
            )
        return resampled

    # Plain DICOM series zip – extract and load
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_path)

        # Try root first, then one level of sub-directories (handles zipped folder)
        candidates = [tmp_path] + sorted(
            p for p in tmp_path.iterdir() if p.is_dir()
        )
        for candidate in candidates:
            try:
                return _load_dicom_dir(candidate)
            except ValueError:
                continue

    raise ValueError(
        f"No DICOM series found in '{zip_path.name}'. "
        "The archive should contain DICOM (.dcm) slice files."
    )
