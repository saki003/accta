/**
 * TypeScript types mirroring the Pydantic schemas defined in accta/api/schemas.py.
 */

// ---------------------------------------------------------------------------
// Study metadata
// ---------------------------------------------------------------------------

export interface StudyMeta {
  uid: string;
  name: string;
  /** Volume shape [Z, Y, X] */
  shape: [number, number, number];
  /** Voxel spacing in mm [dz, dy, dx] */
  spacing: [number, number, number];
  /** World origin in mm [oz, oy, ox] */
  origin: [number, number, number];
  hu_min: number;
  hu_max: number;
  /** Vessel IDs with extracted centrelines saved on disk (e.g. ['LAD', 'RCA']) */
  extracted_vessels?: string[];
}

// ---------------------------------------------------------------------------
// Slice / image responses
// ---------------------------------------------------------------------------

export interface SliceResponse {
  rows: number;
  cols: number;
  /** In-plane pixel spacing in mm [row_spacing, col_spacing] */
  pixel_spacing: [number, number];
  hu_min: number;
  hu_max: number;
  /** Base-64–encoded little-endian float32 buffer, rows × cols values */
  pixel_data_b64: string;
  dtype: string;
}

// ---------------------------------------------------------------------------
// MPR requests
// ---------------------------------------------------------------------------

export interface CenterlineRequest {
  /** N×3 list of [x, y, z] points in world mm */
  points: [number, number, number][];
}

export interface CurvedMPRRequest {
  uid: string;
  /** Ordered centreline points in world mm */
  centerline: [number, number, number][];
  /** Half-width of the MPR slab in mm (default 20) */
  width_mm?: number;
  /** Number of pixels across the vessel lumen (default 64) */
  n_cross?: number;
}

export interface CrossSectionRequest {
  uid: string;
  /** Centre point in world mm [x, y, z] */
  point: [number, number, number];
  /** Vessel tangent direction [tx, ty, tz] */
  tangent: [number, number, number];
  /** Half-width of the cross-section in mm (default 10) */
  radius_mm?: number;
  /** Output image size in pixels, square (default 64) */
  n_pixels?: number;
}

// ---------------------------------------------------------------------------
// Browse / series discovery
// ---------------------------------------------------------------------------

export interface FolderEntry {
  name: string;
  path: string;
  is_dicom_folder: boolean;
}

export interface SeriesInfo {
  series_uid: string;
  series_number: string;
  description: string;
  modality: string;
  slice_count: number;
  slice_thickness_mm: number | null;
  kvp: number | null;
  image_type: string;
  rows: number;
  cols: number;
  folder_path: string; // exact directory where this series' DICOM files reside
}

export interface LoadSeriesRequest {
  path: string;       // patient/study root (fallback)
  series_uid: string;
  folder_path: string; // exact directory — used as fast path
}

// ---------------------------------------------------------------------------
// Algorithm results
// ---------------------------------------------------------------------------

export interface AlgorithmResult {
  uid: string;
  status: 'ok' | 'error' | 'cancelled';
  result: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Centerline / vessel paths
// ---------------------------------------------------------------------------

export const VESSEL_IDS = ['LM', 'LAD', 'LCx', 'RCA', 'D1', 'OM', 'PDA', 'PLV'] as const;
export type VesselId = typeof VESSEL_IDS[number];

export type AnchorType = 'ostium' | 'waypoint' | 'distal';

export interface VesselAnchor {
  type: AnchorType;
  world: [number, number, number];
  locked: boolean;
  valid: boolean;
  /** Sampled HU at the anchor location (75th percentile in 3x3x3 voxel neighborhood) */
  hu?: number;
}

export interface VesselPath {
  vessel: VesselId;
  anchors: VesselAnchor[];
  pathPoints?: [number, number, number][];
  status: 'placing' | 'ready' | 'extracted' | 'locked';
  /** Signature of the vesselness params used when the path was extracted.
   *  If it differs from the current vesselness signature, the path is "stale". */
  vesselnessSig?: string;
  /** Wall-clock timestamp (ms since epoch) of the last successful extract. */
  extractedAt?: number;
}
