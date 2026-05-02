/**
 * Client-side DICOM series scanner.
 *
 * Reads the minimal tags needed to group files into series and identify
 * contrast phase — no server round-trip required.
 */

import * as dicomParser from 'dicom-parser';

export interface ScannedSeries {
  series_uid: string;
  series_number: string;
  description: string;
  modality: string;
  image_type: string;
  slice_count: number;
  slice_thickness_mm: number | null;
  kvp: number | null;
  rows: number;
  cols: number;
  contrast: 'contrast' | 'non-contrast' | 'unknown';
  phase: string;          // human-readable phase label
  files: File[];          // all files belonging to this series
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function str(ds: dicomParser.DataSet, tag: string): string {
  try {
    return (ds.string(tag) ?? '').trim();
  } catch {
    return '';
  }
}

function num(ds: dicomParser.DataSet, tag: string): number | null {
  try {
    const v = ds.string(tag);
    if (!v) return null;
    const n = parseFloat(v.trim());
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function intTag(ds: dicomParser.DataSet, tag: string): number {
  try {
    const v = ds.string(tag);
    if (!v) return 0;
    const n = parseInt(v.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Contrast detection
// ---------------------------------------------------------------------------

function detectContrast(
  _imageType: string,
  description: string,
  kvp: number | null,
  contrastAgent: string,
): 'contrast' | 'non-contrast' | 'unknown' {
  const desc = description.toLowerCase();
  const agent = contrastAgent.toLowerCase();

  // Explicit contrast agent tag
  if (agent && agent !== '' && agent !== 'none') return 'contrast';

  // Description clues
  if (/\b(cta|ctp|ce|contrast|angio|arterial|venous|portal|delayed|bolus)\b/.test(desc)) return 'contrast';
  if (/\b(non.?contrast|without|calcium|score|plain|nat(ive)?)\b/.test(desc)) return 'non-contrast';

  // Calcium scoring: low kVp (80–140) with no obvious CTA label
  if (/\b(calcium|score|cac)\b/.test(desc)) return 'non-contrast';

  // CT angiography typically uses 80–120 kVp; calcium scoring also uses 120 kVp
  // We can't reliably distinguish purely from kVp, so only flag when combined
  if (kvp !== null && kvp >= 60 && kvp <= 120 && /segment|ss pulse|cta/i.test(desc)) return 'contrast';

  return 'unknown';
}

function detectPhase(description: string, _imageType: string): string {
  const d = description.toLowerCase();
  if (/arterial/.test(d)) return 'Arterial';
  if (/venous|portal/.test(d)) return 'Portal Venous';
  if (/delayed|late/.test(d)) return 'Delayed';
  if (/timing|bolus/.test(d)) return 'Timing Bolus';
  if (/calcium|score|cac/.test(d)) return 'Calcium Score';
  if (/scout|localizer|loc/.test(d)) return 'Scout';
  if (/recon/.test(d)) return 'Recon';
  if (/segment|ss pulse|cta/.test(d)) return 'CTA';
  return '';
}

// ---------------------------------------------------------------------------
// Parse a single DICOM file — returns null if not a valid DICOM
// ---------------------------------------------------------------------------

interface FileTags {
  series_uid: string;
  series_number: string;
  description: string;
  modality: string;
  image_type: string;
  thickness: number | null;
  kvp: number | null;
  rows: number;
  cols: number;
  contrast_agent: string;
}

async function parseDicomFile(file: File): Promise<FileTags | null> {
  try {
    // Read first 4 KB — enough for all header tags we need
    const slice = file.slice(0, 4096);
    const buf = await slice.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Validate DICM magic at offset 128
    const magic = String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]);
    if (magic !== 'DICM') return null;

    // Parse just the header portion (dicom-parser can handle partial reads)
    const ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });

    return {
      series_uid:     str(ds, 'x0020000e'),
      series_number:  str(ds, 'x00200011'),
      description:    str(ds, 'x0008103e') || str(ds, 'x00081030'),
      modality:       str(ds, 'x00080060'),
      image_type:     str(ds, 'x00080008').replace(/\\/g, '/'),
      thickness:      num(ds, 'x00180050'),
      kvp:            num(ds, 'x00180060'),
      rows:           intTag(ds, 'x00280010'),
      cols:           intTag(ds, 'x00280011'),
      contrast_agent: str(ds, 'x00180010'),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a FileList (from webkitdirectory) and group into series.
 * Parses one file per series to extract metadata — fast even for large folders.
 */
export async function scanDicomFiles(files: File[]): Promise<ScannedSeries[]> {
  const seriesMap = new Map<string, { tags: FileTags; fileList: File[] }>();

  // Group files by SeriesInstanceUID without parsing every file
  // — parse one representative file per series
  const pendingByUID = new Map<string, File[]>();

  for (const file of files) {
    // Quick check: only parse files that look like DICOM
    if (!/\.dcm$/i.test(file.name) && file.type !== 'application/dicom' && file.size < 132) continue;

    // Peek at series UID from the first 4KB — batch parse representative samples
    const tags = await parseDicomFile(file);
    if (!tags || !tags.series_uid) continue;

    if (!pendingByUID.has(tags.series_uid)) {
      pendingByUID.set(tags.series_uid, []);
      seriesMap.set(tags.series_uid, { tags, fileList: [] });
    }
    pendingByUID.get(tags.series_uid)!.push(file);
  }

  // Assign files back
  for (const [uid, fileList] of pendingByUID.entries()) {
    const entry = seriesMap.get(uid);
    if (entry) entry.fileList = fileList;
  }

  // Build ScannedSeries list, sorted by series number
  const result: ScannedSeries[] = [];
  for (const { tags, fileList } of seriesMap.values()) {
    if (fileList.length === 0) continue;
    const contrast = detectContrast(tags.image_type, tags.description, tags.kvp, tags.contrast_agent);
    result.push({
      series_uid:        tags.series_uid,
      series_number:     tags.series_number,
      description:       tags.description || '(no description)',
      modality:          tags.modality || 'CT',
      image_type:        tags.image_type,
      slice_count:       fileList.length,
      slice_thickness_mm: tags.thickness,
      kvp:               tags.kvp,
      rows:              tags.rows,
      cols:              tags.cols,
      contrast,
      phase:             detectPhase(tags.description, tags.image_type),
      files:             fileList,
    });
  }

  result.sort((a, b) => {
    const na = parseInt(a.series_number, 10);
    const nb = parseInt(b.series_number, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.series_number.localeCompare(b.series_number);
  });

  return result;
}
