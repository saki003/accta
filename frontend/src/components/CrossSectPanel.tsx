/**
 * CrossSectPanel — perpendicular cross-section at a single centreline point.
 *
 * Behaviour
 * ---------
 * - If no centreline: placeholder.
 * - If centreline present: a slider lets the user navigate to any point index.
 *   Each slider move calls POST /mpr/crosssection and renders the result.
 *
 * Tangents are estimated from finite differences of the centreline points.
 */

import React, { useEffect, useRef, useState } from 'react';
import { getCrossSection } from '../api/client';
import type { CrossSectionRequest, SliceResponse } from '../api/types';

interface Props {
  uid: string | null;
  centerline: [number, number, number][] | null;
  centerlineIdx: number;
  wl: number;
  ww: number;
  onCenterlineIdxChange: (idx: number) => void;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function b64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

function renderToCanvas(
  canvas: HTMLCanvasElement,
  slc: SliceResponse,
  wl: number,
  ww: number,
) {
  const { rows, cols, pixel_data_b64 } = slc;
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const pixels = b64ToFloat32(pixel_data_b64);
  const imgData = ctx.createImageData(cols, rows);
  const low = wl - ww / 2;
  const high = wl + ww / 2;
  const range = high - low;

  for (let i = 0; i < pixels.length; i++) {
    const v = Math.max(0, Math.min(255, ((pixels[i] - low) / range) * 255));
    const byte = Math.round(v);
    const base = i * 4;
    imgData.data[base] = byte;
    imgData.data[base + 1] = byte;
    imgData.data[base + 2] = byte;
    imgData.data[base + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

function getTangent(
  centerline: [number, number, number][],
  idx: number,
): [number, number, number] {
  const n = centerline.length;
  let a: [number, number, number];
  let b: [number, number, number];

  if (n < 2) return [0, 0, 1];

  if (idx === 0) {
    a = centerline[0];
    b = centerline[1];
  } else if (idx === n - 1) {
    a = centerline[n - 2];
    b = centerline[n - 1];
  } else {
    a = centerline[idx - 1];
    b = centerline[idx + 1];
  }

  const tx = b[0] - a[0];
  const ty = b[1] - a[1];
  const tz = b[2] - a[2];
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  return [tx / len, ty / len, tz / len];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CrossSectPanel: React.FC<Props> = ({
  uid,
  centerline,
  centerlineIdx,
  wl,
  ww,
  onCenterlineIdxChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sliceData, setSliceData] = useState<SliceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch cross-section when inputs change
  useEffect(() => {
    if (!uid || !centerline || centerline.length < 2) {
      setSliceData(null);
      return;
    }

    const safeIdx = Math.max(0, Math.min(centerlineIdx, centerline.length - 1));
    const point = centerline[safeIdx];
    const tangent = getTangent(centerline, safeIdx);

    let cancelled = false;
    setLoading(true);
    setError(null);

    const req: CrossSectionRequest = {
      uid,
      point,
      tangent,
      radius_mm: 10.0,
      n_pixels: 64,
    };

    getCrossSection(req)
      .then((data) => {
        if (!cancelled) setSliceData(data);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [uid, centerline, centerlineIdx]);

  // Re-render on W/L change
  useEffect(() => {
    if (canvasRef.current && sliceData) {
      renderToCanvas(canvasRef.current, sliceData, wl, ww);
    }
  }, [sliceData, wl, ww]);

  const hasData = uid && centerline && centerline.length >= 2;
  const maxIdx = centerline ? centerline.length - 1 : 0;

  return (
    <div className="panel panel-crosssect" style={{ height: '100%' }}>
      <span className="panel-label">Cross-section</span>

      {!hasData && (
        <div className="panel-placeholder">
          Run centerline detection to compute cross-sections
        </div>
      )}

      {hasData && loading && (
        <div className="panel-placeholder">
          <span className="spinner" />
        </div>
      )}

      {hasData && error && (
        <div className="panel-placeholder" style={{ color: '#c0392b' }}>
          {error}
        </div>
      )}

      {hasData && !loading && sliceData && (
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: 'calc(100% - 32px)',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      )}

      {/* Centreline navigation slider */}
      {hasData && (
        <div className="cs-slider">
          <input
            type="range"
            min={0}
            max={maxIdx}
            step={1}
            value={centerlineIdx}
            onChange={(e) => onCenterlineIdxChange(Number(e.target.value))}
            title={`Centreline point ${centerlineIdx + 1} / ${maxIdx + 1}`}
          />
        </div>
      )}
    </div>
  );
};

export default CrossSectPanel;
