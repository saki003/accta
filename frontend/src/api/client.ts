/**
 * API client — thin wrappers around the accta FastAPI backend.
 *
 * All paths are relative to `/api` which Vite proxies to http://localhost:8000
 * (the `/api` prefix is stripped by the proxy rewrite rule).
 *
 * Non-proxied paths (/volumes, /studies, /mpr, /algorithms) are proxied
 * verbatim.
 */

import axios, { type AxiosError } from 'axios';

/** Extract a human-readable message from an axios error, including the server's detail field. */
export function axiosErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ae = err as AxiosError<{ detail?: string | { msg: string }[] }>;
    const detail = ae.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((d) => d.msg).join('; ');
    return ae.message;
  }
  return err instanceof Error ? err.message : String(err);
}
import type {
  AlgorithmResult,
  CrossSectionRequest,
  CurvedMPRRequest,
  SliceResponse,
  StudyMeta,
} from './types';

// Base instance — points at the Vite proxy's /api prefix
const api = axios.create({
  baseURL: '/api',
  timeout: 60_000,
});

// Longer timeout for DICOM browse/load — scanning large folders or reading
// hundreds of slices can easily exceed 60 s.
const browseApi = axios.create({
  baseURL: '/api',
  timeout: 300_000, // 5 minutes
});

// ---------------------------------------------------------------------------
// Studies
// ---------------------------------------------------------------------------

/**
 * Upload a single DICOM file (.zip / .dcm / .mhd) and return the StudyMeta.
 */
export async function uploadStudy(file: File): Promise<StudyMeta> {
  const form = new FormData();
  form.append('file', file, file.name);
  const { data } = await api.post<StudyMeta>('/studies/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/**
 * Upload a folder of DICOM files (all files at once) and return the StudyMeta.
 * Uses POST /studies/upload-folder with multiple `files` fields.
 */
export async function uploadFolder(files: File[]): Promise<StudyMeta> {
  const form = new FormData();
  for (const f of files) {
    // Preserve the relative path so the backend can use the folder name
    form.append('files', f, f.webkitRelativePath || f.name);
  }
  const { data } = await api.post<StudyMeta>('/studies/upload-folder', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300_000,
  });
  return data;
}

/**
 * Return metadata for all studies currently loaded in the backend store.
 */
export async function getStudies(): Promise<StudyMeta[]> {
  const { data } = await api.get<StudyMeta[]>('/studies/');
  return data;
}

/**
 * Return metadata for a single study by UID.
 */
export async function getStudy(uid: string): Promise<StudyMeta> {
  const { data } = await api.get<StudyMeta>(`/studies/${uid}`);
  return data;
}

/**
 * Remove a study from the backend store.
 */
export async function removeStudy(uid: string): Promise<void> {
  await api.delete(`/studies/${uid}`);
}

// ---------------------------------------------------------------------------
// Volumes / slices
// ---------------------------------------------------------------------------

/**
 * Fetch a single 2-D slice from the stored volume.
 *
 * @param uid   Study UID
 * @param axis  'axial' | 'coronal' | 'sagittal'
 * @param index Zero-based slice index along the chosen axis
 */
export async function getSlice(
  uid: string,
  axis: 'axial' | 'coronal' | 'sagittal',
  index: number,
): Promise<SliceResponse> {
  const { data } = await api.get<SliceResponse>(
    `/volumes/${uid}/slice/${axis}/${index}`,
  );
  return data;
}

/**
 * Return the URL that VTK.js should fetch to get the full NRRD volume.
 * This path is proxied verbatim (no /api prefix).
 */
export function getNrrdUrl(uid: string): string {
  return `/volumes/${uid}/nrrd`;
}

export interface VolumeJSON {
  shape: [number, number, number];      // [nz, ny, nx]
  spacing: [number, number, number];    // [dz, dy, dx] mm
  origin: [number, number, number];     // [oz, oy, ox] mm
  data_b64: string;                     // flat C-order float32 base64
}

/**
 * Fetch the full volume as a JSON payload with base64 float32 data.
 */
export async function getVolumeJSON(uid: string): Promise<VolumeJSON> {
  const { data } = await api.get<VolumeJSON>(`/volumes/${uid}/volume`);
  return data;
}

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

// Long timeout for CPU-heavy algorithm endpoints (vesselness can take several minutes)
const algorithmApi = axios.create({
  baseURL: '/api',
  timeout: 600_000, // 10 minutes
});

export interface PreprocessParams {
  hu_floor: number;
  hu_ceil: number;
  denoise_conductance: number;
  denoise_iterations: number;
  blood_pool_threshold: number;
  lung_threshold: number;
  roi_margin_mm: number;
  enable_denoise: boolean;
  enable_masks: boolean;
  enable_roi: boolean;
}

export const DEFAULT_PREPROCESS_PARAMS: PreprocessParams = {
  hu_floor: -100.0,
  hu_ceil: 800.0,
  denoise_conductance: 2.0,
  denoise_iterations: 3,
  blood_pool_threshold: 120.0,
  lung_threshold: -500.0,
  roi_margin_mm: 20.0,
  enable_denoise: true,
  enable_masks: true,
  enable_roi: true,
};

export async function cancelStep(uid: string, step: 'preprocess' | 'vesselness'): Promise<void> {
  await api.post(`/algorithms/${uid}/cancel/${step}`);
}

export async function runPreprocess(uid: string, params: PreprocessParams = DEFAULT_PREPROCESS_PARAMS): Promise<AlgorithmResult> {
  const { data } = await algorithmApi.post<AlgorithmResult>(
    `/algorithms/${uid}/preprocess`,
    params,
  );
  return data;
}

export interface VesselnessParams {
  sigma_min: number;
  sigma_max: number;
  sigma_steps: number;
  alpha: number;
  beta: number;
  c: number;
  tau: number;
}

export const DEFAULT_VESSELNESS_PARAMS: VesselnessParams = {
  sigma_min: 0.5,
  sigma_max: 3.0,
  sigma_steps: 5,
  alpha: 0.5,
  beta: 0.5,
  c: 100.0,
  tau: 0.5,
};

/**
 * Run multi-scale Frangi vesselness on the given study.
 */
export async function runVesselness(uid: string, params: VesselnessParams = DEFAULT_VESSELNESS_PARAMS): Promise<AlgorithmResult> {
  const { data } = await algorithmApi.post<AlgorithmResult>(
    `/algorithms/${uid}/vesselness`,
    params,
  );
  return data;
}

/**
 * Extract the blood-pool mask from the given study.
 */
export async function runBloodPool(uid: string): Promise<AlgorithmResult> {
  const { data } = await api.post<AlgorithmResult>(
    `/algorithms/${uid}/blood-pool`,
  );
  return data;
}

export interface PipelineStatus {
  preprocess: { done: boolean; params: Partial<PreprocessParams>; quality: Record<string, unknown> };
  vesselness:  { done: boolean; params: Partial<VesselnessParams>; percentiles: Record<string, number> };
}

/**
 * Return the cached pipeline state for a study (no computation triggered).
 */
export async function getPipelineStatus(uid: string): Promise<PipelineStatus> {
  const { data } = await api.get<PipelineStatus>(`/algorithms/${uid}/pipeline-status`);
  return data;
}

export interface PreprocessProgress {
  current: string | null;
  completed: string[];
}

export async function getPreprocessProgress(uid: string): Promise<PreprocessProgress> {
  const { data } = await api.get<PreprocessProgress>(`/algorithms/${uid}/preprocess-progress`);
  return data;
}

/**
 * Detect the ascending aorta and compute its centreline.
 */
export async function runAortaCenterline(
  uid: string,
): Promise<AlgorithmResult> {
  const { data } = await api.post<AlgorithmResult>(
    `/algorithms/${uid}/aorta-centerline`,
  );
  return data;
}

// ---------------------------------------------------------------------------
// MPR
// ---------------------------------------------------------------------------

/**
 * Compute a straightened curved MPR along the given centreline.
 */
export async function getCurvedMPR(
  req: CurvedMPRRequest,
): Promise<SliceResponse> {
  const { data } = await api.post<SliceResponse>('/mpr/curved', req);
  return data;
}

/**
 * Sample a single perpendicular cross-section plane.
 */
export async function getCrossSection(
  req: CrossSectionRequest,
): Promise<SliceResponse> {
  const { data } = await api.post<SliceResponse>('/mpr/crosssection', req);
  return data;
}

// ---------------------------------------------------------------------------
// Browse / series discovery
// ---------------------------------------------------------------------------

import type { FolderEntry, SeriesInfo, LoadSeriesRequest } from './types';

export async function listFolders(path: string, checkDicom = true): Promise<FolderEntry[]> {
  const { data } = await browseApi.get<FolderEntry[]>('/browse/folders', {
    params: { path, check_dicom: checkDicom },
  });
  return data;
}

export async function makeFolder(parent: string, name: string): Promise<{ path: string }> {
  const { data } = await api.post<{ path: string }>('/browse/mkdir', { parent, name });
  return data;
}

export async function listSeries(path: string): Promise<SeriesInfo[]> {
  const { data } = await browseApi.get<SeriesInfo[]>('/browse/series', { params: { path } });
  return data;
}

export async function loadSeries(req: LoadSeriesRequest): Promise<StudyMeta> {
  const { data } = await browseApi.post<StudyMeta>('/browse/load', req);
  return data;
}

// ---------------------------------------------------------------------------
// Centerline / pathfinding
// ---------------------------------------------------------------------------

import type { VesselAnchor, VesselId, VesselPath } from './types';

export interface ValidatePointResponse {
  valid: boolean;
  in_roi: boolean;
  in_blood_pool: boolean;
  nearest_pool_mm: number;
  hu: number;
}

export async function validatePoint(
  uid: string,
  world: [number, number, number],
): Promise<ValidatePointResponse> {
  const { data } = await api.post<ValidatePointResponse>(
    `/algorithms/${uid}/validate-point`,
    { world },
  );
  return data;
}

export interface ExtractPathResponse {
  vessel: string;
  path: [number, number, number][];
}

export async function extractPath(
  uid: string,
  vessel: VesselId,
  anchors: Pick<VesselAnchor, 'type' | 'world'>[],
): Promise<ExtractPathResponse> {
  const { data } = await algorithmApi.post<ExtractPathResponse>(
    `/algorithms/${uid}/extract-path`,
    { vessel, anchors },
  );
  return data;
}

// ---------------------------------------------------------------------------
// Persisted per-study session (anchors, paths, viewer prefs)
// ---------------------------------------------------------------------------

export interface SavedVesselState {
  anchors: VesselAnchor[];
  pathPoints?: [number, number, number][];
  status: VesselPath['status'];
  vesselnessSig?: string;
  extractedAt?: number;
}

export interface SessionState {
  vessels?: Partial<Record<VesselId, SavedVesselState>>;
  viewer?: { wl?: number; ww?: number; slabMm?: number; layout?: string };
}

export async function getSession(uid: string): Promise<SessionState> {
  const { data } = await api.get<SessionState>(`/algorithms/${uid}/session`);
  return data ?? {};
}

export async function saveSession(uid: string, state: SessionState): Promise<void> {
  await api.put(`/algorithms/${uid}/session`, state);
}

// ---------------------------------------------------------------------------
// Workspace configuration
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  data_dir: string;
  default_data_dir: string;
  configured_via: 'env' | 'config-file' | 'default';
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  const { data } = await api.get<WorkspaceInfo>('/config/workspace');
  return data;
}

export async function setWorkspace(dataDir: string): Promise<{ data_dir: string; restart_required: boolean }> {
  const { data } = await api.put<{ data_dir: string; restart_required: boolean }>(
    '/config/workspace',
    { data_dir: dataDir },
  );
  return data;
}

export default api;
