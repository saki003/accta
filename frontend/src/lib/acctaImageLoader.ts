/**
 * Custom Cornerstone3D image loader for the accta backend.
 *
 * Image IDs have the form:
 *   accta://<uid>/<axis>/<index>
 *
 * where axis ∈ { axial, coronal, sagittal } and index is a zero-based integer.
 *
 * The loader fetches the slice from GET /volumes/{uid}/slice/{axis}/{index},
 * decodes the base64 float32 payload, and returns a Cornerstone IImage.
 */

import * as cornerstone from '@cornerstonejs/core';
import { metaData, Enums, cache } from '@cornerstonejs/core';
import type { IImage } from '@cornerstonejs/core/types';

const SCHEME = 'accta';

interface CachedImagePlane {
  rowPixelSpacing: number;
  columnPixelSpacing: number;
  imagePositionPatient: [number, number, number];
  rowCosines: [number, number, number];
  columnCosines: [number, number, number];
  rows?: number;
  columns?: number;
}

const _imagePlaneCache = new Map<string, CachedImagePlane>();

// ---------------------------------------------------------------------------
// Helper: base-64 → Float32Array
// ---------------------------------------------------------------------------

function b64ToFloat32Array(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ---------------------------------------------------------------------------
// Parse imageId
// ---------------------------------------------------------------------------

interface ParsedId {
  uid: string;
  axis: string;
  index: number;
}

function parseImageId(imageId: string): ParsedId {
  // imageId: "accta://uid/axis/index"
  const withoutScheme = imageId.replace(/^accta:\/\//, '');
  const parts = withoutScheme.split('/');
  if (parts.length < 3) {
    throw new Error(`Invalid accta imageId: ${imageId}`);
  }
  const [uid, axis, indexStr] = parts;
  return { uid, axis, index: parseInt(indexStr, 10) };
}

// ---------------------------------------------------------------------------
// The loader function
// ---------------------------------------------------------------------------

interface SliceResponseJSON {
  rows: number;
  cols: number;
  pixel_spacing: [number, number];
  hu_min: number;
  hu_max: number;
  pixel_data_b64: string;
}

function acctaLoader(imageId: string): { promise: Promise<IImage> } {
  const promise = (async (): Promise<IImage> => {
    const { uid, axis, index } = parseImageId(imageId);

    const url = `/volumes/${uid}/slice/${axis}/${index}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `accta image loader: HTTP ${response.status} for ${url}`,
      );
    }

    const json: SliceResponseJSON = await response.json();

    const pixelData = b64ToFloat32Array(json.pixel_data_b64);

    const rows = json.rows;
    const cols = json.cols;
    const huMin = json.hu_min;
    const huMax = json.hu_max;

    // Update spacing/dimensions, preserving any pre-cached position/orientation
    const existing = _imagePlaneCache.get(imageId);
    _imagePlaneCache.set(imageId, {
      rowPixelSpacing: json.pixel_spacing[0],
      columnPixelSpacing: json.pixel_spacing[1],
      imagePositionPatient: existing?.imagePositionPatient ?? [0, 0, 0],
      rowCosines: existing?.rowCosines ?? [1, 0, 0],
      columnCosines: existing?.columnCosines ?? [0, 1, 0],
      rows: rows,
      columns: cols,
    });

    // Default cardiac window/level
    const windowWidth = Math.max(huMax - huMin, 1);
    const windowCenter = huMin + windowWidth / 2;

    const image: IImage = {
      imageId,
      minPixelValue: huMin,
      maxPixelValue: huMax,
      slope: 1,
      intercept: 0,
      windowCenter,
      windowWidth,
      voiLUTFunction: Enums.VOILUTFunctionType.LINEAR,
      getPixelData: () => pixelData,
      getCanvas: () => document.createElement('canvas'),
      rows,
      columns: cols,
      height: rows,
      width: cols,
      color: false,
      rgba: false,
      numberOfComponents: 1,
      columnPixelSpacing: json.pixel_spacing[1],
      rowPixelSpacing: json.pixel_spacing[0],
      invert: false,
      sizeInBytes: pixelData.byteLength,
      dataType: 'Float32Array',
      imageFrame: {},
    } as unknown as IImage;

    return image;
  })();

  return { promise };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let _registered = false;

export function registerAcctaImageLoader(): void {
  if (_registered) return;
  cornerstone.imageLoader.registerImageLoader(SCHEME, acctaLoader as never);

  metaData.addProvider((type: string, imageId: string) => {
    if (!imageId.startsWith(`${SCHEME}://`)) return undefined;

    if (type === 'imagePixelModule') {
      const s = _imagePlaneCache.get(imageId);
      return {
        pixelRepresentation: 0,
        bitsAllocated: 32,
        bitsStored: 32,
        highBit: 31,
        photometricInterpretation: 'MONOCHROME2',
        samplesPerPixel: 1,
        rows: s?.rows,
        columns: s?.columns,
      };
    }

    if (type === 'generalSeriesModule') {
      return { modality: 'CT' };
    }

    if (type === 'imagePlaneModule') {
      const s = _imagePlaneCache.get(imageId);
      const ipp = s?.imagePositionPatient ?? [0, 0, 0];
      const rc  = s?.rowCosines           ?? [1, 0, 0];
      const cc  = s?.columnCosines        ?? [0, 1, 0];
      const rsp = s?.rowPixelSpacing    ?? 1;
      const csp = s?.columnPixelSpacing ?? 1;
      return {
        rowPixelSpacing:    rsp,
        columnPixelSpacing: csp,
        // pixelSpacing array expected by the streaming volume loader
        pixelSpacing: [rsp, csp],
        rowCosines:         rc,
        columnCosines:      cc,
        imagePositionPatient:    ipp,
        imageOrientationPatient: [...rc, ...cc],
        rows:    s?.rows,
        columns: s?.columns,
        usingDefaultValues: !s,
      };
    }

    return undefined;
  }, 100); // priority 100 = high, runs before the default provider

  _registered = true;
}

// ---------------------------------------------------------------------------
// Pre-cache helpers
// ---------------------------------------------------------------------------

/**
 * Pre-populate the full image-plane metadata cache for an entire stack
 * before setStack() is called.
 *
 * Coordinate conventions (matching the backend's numpy arr[Z, Y, X]):
 *   axial   slice i → arr[i, :, :] rows=Y, cols=X
 *   coronal slice j → arr[:, j, :] rows=Z, cols=X
 *   sagittal slice k → arr[:, :, k] rows=Z, cols=Y
 *
 * @param spacing  [dz, dy, dx] in mm
 * @param origin   [oz, oy, ox] in mm  (world position of voxel [0,0,0])
 */
export function preCacheFullMetadata(
  uid: string,
  axis: 'axial' | 'coronal' | 'sagittal',
  sliceCount: number,
  spacing: [number, number, number],
  origin: [number, number, number],
  /** Full volume shape [nz, ny, nx] — required for VolumeViewport to know image dimensions. */
  studyShape?: [number, number, number],
): void {
  const [dz, dy, dx] = spacing;
  const [oz, oy, ox] = origin;
  const [nz, ny, nx] = studyShape ?? [0, 0, 0];

  for (let i = 0; i < sliceCount; i++) {
    let imagePositionPatient: [number, number, number];
    let rowCosines: [number, number, number];
    let columnCosines: [number, number, number];
    let rowPixelSpacing: number;
    let columnPixelSpacing: number;
    let rows: number | undefined;
    let columns: number | undefined;

    switch (axis) {
      case 'axial':
        imagePositionPatient = [ox, oy, oz + i * dz];
        rowCosines    = [1, 0, 0];
        columnCosines = [0, 1, 0];
        rowPixelSpacing    = dy;
        columnPixelSpacing = dx;
        rows = ny || undefined; columns = nx || undefined;
        break;
      case 'coronal':
        imagePositionPatient = [ox, oy + i * dy, oz];
        rowCosines    = [1, 0, 0];
        columnCosines = [0, 0, 1];
        rowPixelSpacing    = dz;
        columnPixelSpacing = dx;
        rows = nz || undefined; columns = nx || undefined;
        break;
      case 'sagittal':
        imagePositionPatient = [ox + i * dx, oy, oz];
        rowCosines    = [0, 1, 0];
        columnCosines = [0, 0, 1];
        rowPixelSpacing    = dz;
        columnPixelSpacing = dy;
        rows = nz || undefined; columns = ny || undefined;
        break;
    }

    _imagePlaneCache.set(`${SCHEME}://${uid}/${axis}/${i}`, {
      rowPixelSpacing,
      columnPixelSpacing,
      imagePositionPatient,
      rowCosines,
      columnCosines,
      rows,
      columns,
    });
  }
}

/**
 * Simpler spacing-only pre-cache (used when full origin is unavailable).
 * Preserves any existing imagePositionPatient/cosines.
 */
export function preCacheSpacingForStack(
  uid: string,
  axis: string,
  sliceCount: number,
  rowPixelSpacing: number,
  columnPixelSpacing: number,
): void {
  for (let i = 0; i < sliceCount; i++) {
    const key = `${SCHEME}://${uid}/${axis}/${i}`;
    const existing = _imagePlaneCache.get(key);
    _imagePlaneCache.set(key, {
      rowPixelSpacing,
      columnPixelSpacing,
      imagePositionPatient: existing?.imagePositionPatient ?? [0, 0, 0],
      rowCosines:    existing?.rowCosines    ?? [1, 0, 0],
      columnCosines: existing?.columnCosines ?? [0, 1, 0],
    });
  }
}

/**
 * Build the list of Cornerstone imageIds for an entire axial stack.
 */
export function buildAxialImageIds(uid: string, depth: number): string[] {
  return Array.from(
    { length: depth },
    (_, i) => `${SCHEME}://${uid}/axial/${i}`,
  );
}

/**
 * Build a single imageId for an arbitrary slice (used for MPR panels when
 * we want to display a single pre-computed image).
 */
export function buildSingleImageId(label: string): string {
  return `${SCHEME}://${label}/axial/0`;
}

/**
 * Remove the cached VolumeViewport volume object for a given study UID.
 * Call this when a study is unloaded to free GPU/CPU memory.
 */
export function clearVolumeCache(uid: string): void {
  const vId = `accta-vol:${uid}`;
  try {
    cache.removeVolumeLoadObject(vId);
  } catch {
    /* ignore — volume may not have been cached */
  }
}
