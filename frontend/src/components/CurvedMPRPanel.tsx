/**
 * CurvedMPRPanel — displays the straightened curved MPR of a vessel.
 *
 * Behaviour
 * ---------
 * - If no centreline is available: shows a placeholder message.
 * - If a centreline is present: calls POST /mpr/curved and renders the
 *   returned SliceResponse on a <canvas> element with the current W/L applied.
 *
 * The image is re-fetched whenever uid, centerline, wl, or ww change.
 */

import React, { useEffect, useRef, useState } from 'react';
import { getCurvedMPR } from '../api/client';
import type { CurvedMPRRequest, SliceResponse } from '../api/types';

interface Props {
  uid: string | null;
  centerline: [number, number, number][] | null;
  wl: number;
  ww: number;
  onRunCenterline?: () => void;
  runningCenterline?: boolean;
}

// ---------------------------------------------------------------------------
// Decode base-64 float32 buffer and render with W/L onto a canvas
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CurvedMPRPanel: React.FC<Props> = ({ uid, centerline, wl, ww, onRunCenterline, runningCenterline }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sliceData, setSliceData] = useState<SliceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the MPR whenever inputs change
  useEffect(() => {
    if (!uid || !centerline || centerline.length < 2) {
      setSliceData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const req: CurvedMPRRequest = {
      uid,
      centerline,
      width_mm: 20.0,
      n_cross: 64,
    };

    getCurvedMPR(req)
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
  }, [uid, centerline]);

  // Re-render when W/L or slice data changes
  useEffect(() => {
    if (canvasRef.current && sliceData) {
      renderToCanvas(canvasRef.current, sliceData, wl, ww);
    }
  }, [sliceData, wl, ww]);

  const hasData = uid && centerline && centerline.length >= 2;

  return (
    <div className="panel panel-curved" style={{ height: '100%' }}>
      <span className="panel-label">Curved MPR</span>

      {!hasData && (
        <div className="panel-placeholder">
          {uid && onRunCenterline ? (
            <>
              <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                No centerline — detect the aorta to compute Curved MPR
              </div>
              <button
                onClick={onRunCenterline}
                disabled={runningCenterline}
                style={{ fontSize: 12 }}
              >
                {runningCenterline ? 'Detecting…' : 'Detect Centerline'}
              </button>
            </>
          ) : (
            'Load a study, then detect centerline to compute Curved MPR'
          )}
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
            height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      )}
    </div>
  );
};

export default CurvedMPRPanel;
