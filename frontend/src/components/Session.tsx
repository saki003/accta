import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { StudyMeta } from '../api/types';
import axios from 'axios';
import {
  runPreprocess, runVesselness, getPipelineStatus, getPreprocessProgress,
  getStudy, getSession, saveSession, cancelStep,
  DEFAULT_PREPROCESS_PARAMS, DEFAULT_VESSELNESS_PARAMS,
  validatePoint, extractPath,
} from '../api/client';
import type { SessionState } from '../api/client';
import type { PreprocessParams, VesselnessParams, PreprocessProgress } from '../api/client';
import type { AlgorithmResult } from '../api/types';
import { VESSEL_IDS } from '../api/types';
import type { VesselId, VesselAnchor, VesselPath, AnchorType } from '../api/types';
import { loadNiftiVolume, type VolumeData } from '../lib/niftiVolume';
import Viewer from './Viewer';
import MiniGame from './MiniGame';

export type StepId = 'viewer' | 'preprocess' | 'vesselness' | 'centerline' | 'edit' | 'model' | 'report';

export interface QualityResult {
  sharpness: number;
  z_consistency: number;
  blood_pool_snr: number;
  flag: 'pass' | 'warn' | 'fail';
  issues: string[];
}

function parseStudyName(name: string): { patient: string; description: string; date: string } {
  const [namePart = '', desc = ''] = name.split(' — ');
  const parts = namePart.split('_');
  const last  = parts[0] ?? '';
  const first = parts[1] ?? '';
  const raw   = parts[2] ?? '';
  const patient = [last, first].filter(Boolean).join(', ') || namePart;
  const date = raw.length === 8
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  return { patient, description: desc, date };
}

// ---------------------------------------------------------------------------
// Accordion section components
// ---------------------------------------------------------------------------

const SectionLabel: React.FC<{
  index: number;
  label: string;
  open: boolean;
  available: boolean;
  done: boolean;
  onClick: () => void;
}> = ({ index, label, open, available, done, onClick }) => (
  <button
    onClick={onClick}
    disabled={!available}
    style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
      padding: '9px 14px',
      background: open ? '#1a1a1a' : 'transparent',
      border: 'none', borderBottom: '1px solid #1e1e1e',
      cursor: available ? 'pointer' : 'default',
      textAlign: 'left',
    }}
    onMouseEnter={e => { if (available && !open) e.currentTarget.style.background = '#181818'; }}
    onMouseLeave={e => { if (available && !open) e.currentTarget.style.background = 'transparent'; }}
  >
    <span style={{
      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 9, fontWeight: 700,
      background: open ? '#2563eb' : done ? '#14532d' : available ? '#222' : '#161616',
      color: open ? '#fff' : done ? '#4ade80' : available ? '#666' : '#2a2a2a',
      border: done && !open ? '1px solid #166534' : 'none',
    }}>
      {done && !open ? '✓' : index}
    </span>
    <span style={{
      fontSize: 11, fontWeight: open ? 600 : 400,
      color: open ? '#ddd' : available ? '#555' : '#2a2a2a',
      letterSpacing: '0.04em',
      flex: 1,
    }}>
      {label}
    </span>
    {available && (
      <span style={{ fontSize: 9, color: '#333' }}>{open ? '▲' : '▼'}</span>
    )}
  </button>
);

// ---------------------------------------------------------------------------
// Quality badge
// ---------------------------------------------------------------------------

const FLAG_COLOR = { pass: '#4ade80', warn: '#f5a623', fail: '#ef4444' } as const;
const FLAG_BG    = { pass: '#14532d', warn: '#451a03', fail: '#450a0a' } as const;

const QualityBadge: React.FC<{ q: QualityResult }> = ({ q }) => (
  <div style={{
    background: FLAG_BG[q.flag], border: `1px solid ${FLAG_COLOR[q.flag]}33`,
    borderRadius: 5, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: FLAG_COLOR[q.flag], flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: FLAG_COLOR[q.flag], textTransform: 'capitalize' }}>
        {q.flag === 'pass' ? 'Good quality' : q.flag === 'warn' ? 'Quality warning' : 'Quality issues'}
      </span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 0', fontSize: 10 }}>
      {([
        ['Sharpness',  (q.sharpness * 100).toFixed(0) + '%'],
        ['Z-consist.', (q.z_consistency * 100).toFixed(0) + '%'],
        ['Pool SNR',   q.blood_pool_snr.toFixed(1)],
      ] as [string, string][]).map(([label, val]) => (
        <React.Fragment key={label}>
          <span style={{ color: '#555' }}>{label}</span>
          <span style={{ color: '#777', fontFamily: 'monospace', textAlign: 'right', paddingRight: 4 }}>{val}</span>
        </React.Fragment>
      ))}
    </div>
    {q.issues.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {q.issues.map(issue => (
          <span key={issue} style={{ fontSize: 10, color: FLAG_COLOR[q.flag], opacity: 0.85 }}>· {issue}</span>
        ))}
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Vesselness section body
// ---------------------------------------------------------------------------

const PERCENTILE_LABELS: [string, string][] = [
  ['p990', '99.0%'],
  ['p993', '99.3%'],
  ['p995', '99.5%'],
  ['p998', '99.8%'],
];

/** Heuristic: pick a τ regularization strength from preprocess quality.
 *  Low SNR / blurry studies need stronger regularization to clean up the
 *  noise floor; clean studies want light regularization to preserve dim
 *  distal vessel response. */
function suggestedTau(quality: QualityResult | null): { tau: number; reason: string } | null {
  if (!quality) return null;
  const snr = quality.blood_pool_snr;
  const sharp = quality.sharpness;
  if (snr < 5 || sharp < 0.30) return { tau: 0.7, reason: `low ${snr < 5 ? 'SNR' : 'sharpness'}` };
  if (snr < 10 || sharp < 0.50) return { tau: 0.5, reason: 'moderate quality' };
  return { tau: 0.3, reason: 'clean study' };
}

const VesselnessBody: React.FC<{
  vesselness: VolumeData | null;
  vesselnessOpacity: number;
  vesselnessThreshold: number;
  vesselnessPercentiles: Record<string, number> | null;
  vesselnessParams: VesselnessParams;
  quality: QualityResult | null;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  onOpacityChange: (v: number) => void;
  onThresholdChange: (v: number) => void;
  onParamsChange: (p: VesselnessParams) => void;
  onResetParams: () => void;
}> = ({ vesselness, vesselnessOpacity, vesselnessThreshold, vesselnessPercentiles, vesselnessParams, quality, running, onRun, onStop, onOpacityChange, onThresholdChange, onParamsChange, onResetParams }) => (
  <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        onClick={onRun}
        disabled={running}
        style={{
          flex: 1,
          background: '#2563eb', border: 'none', borderRadius: 5,
          color: '#fff', padding: '7px 0', cursor: running ? 'default' : 'pointer',
          fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          opacity: running ? 0.6 : 1,
        }}
      >
        {running
          ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Running…</>
          : vesselness ? 'Rerun Vesselness' : 'Run Vesselness'}
      </button>
      {running && (
        <button
          onClick={onStop}
          title="Stop the running vesselness job. Cancellation takes effect at the next checkpoint (typically within one Frangi sigma scale, ~30-60 s)."
          style={{
            background: '#7f1d1d', border: '1px solid #991b1b', borderRadius: 5,
            color: '#fecaca', padding: '7px 14px', fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          ■ Stop
        </button>
      )}
    </div>

    {vesselness && (
      <>
        <div>
          <div style={{ fontSize: 10, color: '#555', marginBottom: 5 }}>
            Overlay — {Math.round(vesselnessOpacity * 100)}%
          </div>
          <input type="range" min={0} max={1} step={0.05}
            value={vesselnessOpacity}
            onChange={e => onOpacityChange(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#f5a623' }}
          />
        </div>

        <div>
          <div style={{ fontSize: 10, color: '#555', marginBottom: 6 }}>Threshold</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {([['0', 'All']] as [string, string][]).concat(PERCENTILE_LABELS).map(([key, label]) => {
              const val = key === '0' ? 0 : (vesselnessPercentiles?.[key] ?? null);
              const active = key === '0'
                ? vesselnessThreshold === 0
                : val !== null && Math.abs(vesselnessThreshold - val) < 1e-6;
              return (
                <button
                  key={key}
                  disabled={val === null && key !== '0'}
                  onClick={() => onThresholdChange(val ?? 0)}
                  style={{
                    fontSize: 9, padding: '3px 6px', borderRadius: 3,
                    background: active ? '#f5a623' : '#1a1a1a',
                    color: active ? '#000' : val === null ? '#333' : '#666',
                    border: `1px solid ${active ? '#f5a623' : '#2a2a2a'}`,
                    cursor: val === null && key !== '0' ? 'default' : 'pointer',
                  }}
                >
                  {label}
                  {val !== null && key !== '0' && (
                    <span style={{ display: 'block', fontSize: 8, color: active ? '#000' : '#444' }}>
                      {val.toFixed(3)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </>
    )}

    <div style={{ height: 1, background: '#1e1e1e' }} />

    <div style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>
      Parameters
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px', fontSize: 11 }}>
      {(
        [
          ['σ min',  'sigma_min',   0.1, 5,    0.1 ],
          ['σ max',  'sigma_max',   0.5, 10,   0.5 ],
          ['σ steps','sigma_steps', 2,   12,   1   ],
          ['α',      'alpha',       0.1, 2,    0.05],
          ['β',      'beta',        0.1, 2,    0.05],
          ['c',      'c',           50,  2000, 50  ],
          ['τ',      'tau',         0.0, 1.0,  0.05],
        ] as [string, keyof VesselnessParams, number, number, number][]
      ).map(([label, key, min, max, step]) => (
        <React.Fragment key={key}>
          <span style={{ color: '#555', alignSelf: 'center' }}>{label}</span>
          <input
            type="number" min={min} max={max} step={step}
            value={vesselnessParams[key]}
            onChange={e => onParamsChange({
              ...vesselnessParams,
              [key]: key === 'sigma_steps' ? parseInt(e.target.value) : parseFloat(e.target.value),
            })}
            style={{
              width: '100%', background: '#1a1a1a', color: '#ccc',
              border: '1px solid #2a2a2a', borderRadius: 3, padding: '2px 4px', fontSize: 11,
            }}
          />
        </React.Fragment>
      ))}
    </div>

    {/* Suggested τ hint based on preprocess quality metrics */}
    {(() => {
      const sug = suggestedTau(quality);
      if (!sug) return null;
      const matches = Math.abs(vesselnessParams.tau - sug.tau) < 0.01;
      return (
        <div style={{
          fontSize: 10, padding: '5px 7px', borderRadius: 3,
          background: matches ? '#0e2a35' : '#1a1a1a',
          border: `1px solid ${matches ? '#06b6d4' : '#2a2a2a'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        }}>
          <span style={{ color: matches ? '#67e8f9' : '#888' }}>
            Suggested τ: <b style={{ color: matches ? '#67e8f9' : '#aaa' }}>{sug.tau}</b>
            <span style={{ color: '#666', marginLeft: 4 }}>({sug.reason})</span>
          </span>
          {!matches && (
            <button
              onClick={() => onParamsChange({ ...vesselnessParams, tau: sug.tau })}
              style={{
                fontSize: 9, padding: '2px 8px',
                background: '#1e3a5f', border: '1px solid #2563eb',
                borderRadius: 3, color: '#93c5fd', cursor: 'pointer',
              }}
            >
              Apply
            </button>
          )}
        </div>
      );
    })()}

    <button
      onClick={onResetParams}
      style={{
        fontSize: 10, color: '#444', background: 'transparent',
        border: '1px solid #222', borderRadius: 3, padding: '3px 0',
      }}
    >
      Reset defaults
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Preprocess section body
// ---------------------------------------------------------------------------

const StepIndicator: React.FC<{ name: string; progress: PreprocessProgress }> = ({ name, progress }) => {
  const done = progress.completed.includes(name);
  const active = progress.current === name;
  if (!done && !active) return null;
  return done
    ? <span style={{ fontSize: 9, color: '#4ade80' }}>✓</span>
    : <span className="spinner" style={{ width: 8, height: 8, flexShrink: 0 }} />;
};

const PreprocessBody: React.FC<{
  params: PreprocessParams;
  onChange: (p: PreprocessParams) => void;
  onReset: () => void;
  running: boolean;
  done: boolean;
  onRun: () => void;
  onStop: () => void;
  showPreprocessed: boolean;
  onTogglePreprocessed: (v: boolean) => void;
  quality: QualityResult | null;
  steps: PreprocessProgress;
}> = ({ params, onChange, onReset, running, done, onRun, onStop, showPreprocessed, onTogglePreprocessed, quality, steps }) => {
  type NumericPreprocessKey = {
    [K in keyof PreprocessParams]: PreprocessParams[K] extends number ? K : never
  }[keyof PreprocessParams];
  const slider = (
    label: string,
    key: NumericPreprocessKey,
    min: number, max: number, step: number,
    hint: string,
  ) => (
    <div key={key}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555', marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: '#777', fontFamily: 'monospace' }}>{params[key]}</span>
      </div>
      <input type="range" min={min} max={max} step={step}
        value={params[key]}
        onChange={e => onChange({ ...params, [key]: parseFloat(e.target.value) })}
        title={hint}
        style={{ width: '100%', accentColor: '#2563eb' }}
      />
    </div>
  );

  const RANGE_MIN = -680;
  const RANGE_MAX = 1320;

  const loFrac = (params.hu_floor - RANGE_MIN) / (RANGE_MAX - RANGE_MIN);
  const hiFrac = (params.hu_ceil  - RANGE_MIN) / (RANGE_MAX - RANGE_MIN);
  const trackFill = `linear-gradient(to right, #222 ${loFrac * 100}%, #2563eb ${loFrac * 100}%, #2563eb ${hiFrac * 100}%, #222 ${hiFrac * 100}%)`;

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>HU Clip</div>
        <StepIndicator name="clip" progress={steps} />
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555', marginBottom: 4 }}>
          <span style={{ color: '#777', fontFamily: 'monospace' }}>{params.hu_floor} HU</span>
          <span style={{ color: '#555' }}>clip</span>
          <span style={{ color: '#777', fontFamily: 'monospace' }}>{params.hu_ceil} HU</span>
        </div>
        <div className="hu-range" style={{ position: 'relative', height: 18 }}>
          {/* Shared track */}
          <div style={{
            position: 'absolute', top: '50%', left: 0, right: 0,
            height: 4, marginTop: -2, borderRadius: 2,
            background: trackFill, pointerEvents: 'none',
          }} />
          {/* Floor handle */}
          <input type="range" min={RANGE_MIN} max={RANGE_MAX} step={10}
            value={params.hu_floor}
            onChange={e => {
              const v = parseFloat(e.target.value);
              onChange({ ...params, hu_floor: Math.min(v, params.hu_ceil - 10) });
            }}
            style={{ position: 'absolute', width: '100%', appearance: 'none', background: 'transparent', pointerEvents: 'auto' }}
          />
          {/* Ceil handle */}
          <input type="range" min={RANGE_MIN} max={RANGE_MAX} step={10}
            value={params.hu_ceil}
            onChange={e => {
              const v = parseFloat(e.target.value);
              onChange({ ...params, hu_ceil: Math.max(v, params.hu_floor + 10) });
            }}
            style={{ position: 'absolute', width: '100%', appearance: 'none', background: 'transparent', pointerEvents: 'auto' }}
          />
        </div>
      </div>

      <div style={{ height: 1, background: '#1e1e1e' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={params.enable_denoise}
            onChange={e => onChange({ ...params, enable_denoise: e.target.checked })}
            style={{ accentColor: '#2563eb' }}
          />
          <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Denoise</span>
        </label>
        <StepIndicator name="denoise" progress={steps} />
      </div>
      <div style={{ opacity: params.enable_denoise ? 1 : 0.4, pointerEvents: params.enable_denoise ? 'auto' : 'none' }}>
        {slider('Conductance', 'denoise_conductance', 0.5, 5, 0.5, 'Edge sensitivity — lower keeps sharper edges')}
        {slider('Iterations',  'denoise_iterations',  0,   20, 1,   'Diffusion passes — 0 disables denoising')}
      </div>

      <div style={{ height: 1, background: '#1e1e1e' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={params.enable_masks}
            onChange={e => onChange({ ...params, enable_masks: e.target.checked })}
            style={{ accentColor: '#2563eb' }}
          />
          <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Masks</span>
        </label>
        <StepIndicator name="mask" progress={steps} />
      </div>
      <div style={{ opacity: params.enable_masks ? 1 : 0.4, pointerEvents: params.enable_masks ? 'auto' : 'none' }}>
        {slider('Blood pool >', 'blood_pool_threshold', 100, 500, 10, 'Exclude voxels above this HU')}
        {slider('Lung / air <', 'lung_threshold', -1000, -200, 25, 'Exclude voxels below this HU')}
      </div>

      <div style={{ height: 1, background: '#1e1e1e' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: params.enable_masks ? 1 : 0.4 }}>
          <input
            type="checkbox"
            checked={params.enable_roi}
            disabled={!params.enable_masks}
            onChange={e => onChange({ ...params, enable_roi: e.target.checked })}
            style={{ accentColor: '#2563eb' }}
          />
          <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>ROI</span>
        </label>
        <StepIndicator name="roi" progress={steps} />
      </div>
      <div style={{ opacity: params.enable_roi && params.enable_masks ? 1 : 0.4, pointerEvents: params.enable_roi && params.enable_masks ? 'auto' : 'none' }}>
        {slider('Margin mm', 'roi_margin_mm', 2, 40, 1, 'Dilation margin around blood pool')}
      </div>

      <div style={{ height: 1, background: '#1e1e1e' }} />

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onRun}
          disabled={running}
          style={{
            flex: 1,
            background: done ? '#14532d' : '#2563eb', border: 'none', borderRadius: 5,
            color: done ? '#4ade80' : '#fff', padding: '7px 0',
            cursor: running ? 'default' : 'pointer', fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            opacity: running ? 0.6 : 1,
          }}
        >
          {running
            ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Running…</>
            : done ? '✓ Rerun Preprocessing' : 'Run Preprocessing'}
        </button>
        {running && (
          <button
            onClick={onStop}
            title="Stop the running preprocess job. Cancellation takes effect at the next stage boundary (a few seconds)."
            style={{
              background: '#7f1d1d', border: '1px solid #991b1b', borderRadius: 5,
              color: '#fecaca', padding: '7px 14px', fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ■ Stop
          </button>
        )}
      </div>

      {quality && <QualityBadge q={quality} />}

      {done && (
        <button
          onClick={() => onTogglePreprocessed(!showPreprocessed)}
          style={{
            background: showPreprocessed ? '#1e3a5f' : 'transparent',
            border: `1px solid ${showPreprocessed ? '#2563eb' : '#2a2a2a'}`,
            borderRadius: 4, color: showPreprocessed ? '#93c5fd' : '#555',
            fontSize: 11, padding: '5px 0', cursor: 'pointer',
          }}
        >
          {showPreprocessed ? '● Showing processed' : '○ Show processed'}
        </button>
      )}

      <button
        onClick={onReset}
        style={{ fontSize: 10, color: '#444', background: 'transparent', border: '1px solid #222', borderRadius: 3, padding: '3px 0' }}
      >
        Reset defaults
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Centerline section body
// ---------------------------------------------------------------------------

const ANCHOR_LABEL: Record<AnchorType, string> = { ostium: 'Ostium', waypoint: 'Waypoint', distal: 'Distal' };
const ANCHOR_COLOR: Record<AnchorType, string> = { ostium: '#4ade80', waypoint: '#fbbf24', distal: '#f87171' };

const RelativeTime: React.FC<{ ts: number }> = ({ ts }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  let label: string;
  if (sec < 5)        label = 'just now';
  else if (sec < 60)  label = `${sec}s ago`;
  else if (sec < 3600) label = `${Math.floor(sec / 60)}m ago`;
  else                 label = `${Math.floor(sec / 3600)}h ago`;
  // Highlight cyan for first 3 seconds so a fresh re-extract is obvious
  const fresh = sec < 3;
  return (
    <span
      title={`Extracted at ${new Date(ts).toLocaleTimeString()}`}
      style={{
        fontSize: 9, fontFamily: 'monospace',
        color: fresh ? '#00E5FF' : '#555',
        fontWeight: fresh ? 700 : 400,
      }}
    >
      {label}
    </span>
  );
};

const CenterlineBody: React.FC<{
  activeVessel: VesselId | null;
  vesselPaths: Map<VesselId, VesselPath>;
  placementMode: AnchorType | null;
  extracting: boolean;
  currentVesselnessSig: string;
  centerlineLocked: boolean;
  centerlineLockIdx: number;
  editingAnchorIdx: number | null;
  onSetCenterlineLocked: (v: boolean) => void;
  onSetCenterlineLockIdx: (i: number) => void;
  onSetEditingAnchorIdx: (i: number | null) => void;
  onSelectVessel: (v: VesselId) => void;
  onSetPlacementMode: (m: AnchorType | null) => void;
  onExtractPath: () => void;
  onClearVessel: () => void;
  onDeleteAnchor: (idx: number) => void;
}> = ({ activeVessel, vesselPaths, placementMode, extracting, currentVesselnessSig, centerlineLocked, centerlineLockIdx, editingAnchorIdx, onSetCenterlineLocked, onSetCenterlineLockIdx, onSetEditingAnchorIdx, onSelectVessel, onSetPlacementMode, onExtractPath, onClearVessel, onDeleteAnchor }) => {
  const path    = activeVessel ? vesselPaths.get(activeVessel) : undefined;
  const anchors = path?.anchors ?? [];
  const isStale = path?.status === 'extracted'
    && path.vesselnessSig !== undefined
    && path.vesselnessSig !== currentVesselnessSig;
  const hasOstium = anchors.some(a => a.type === 'ostium');
  const hasDistal = anchors.some(a => a.type === 'distal');
  const hasInvalidAnchor = anchors.some(a => !a.valid);

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Vessel selector */}
      <div style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>
        Vessel
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 3 }}>
        {VESSEL_IDS.map(v => {
          const vp = vesselPaths.get(v);
          const done = vp?.status === 'extracted' || vp?.status === 'locked';
          const placing = vp && vp.anchors.length > 0 && vp.status === 'placing';
          const stale = vp?.status === 'extracted'
            && vp.vesselnessSig !== undefined
            && vp.vesselnessSig !== currentVesselnessSig;
          return (
            <button
              key={v}
              onClick={() => onSelectVessel(v)}
              title={stale ? `${v}: vesselness changed since extraction` : v}
              style={{
                fontSize: 10, fontWeight: 600, padding: '4px 0', borderRadius: 3,
                background: activeVessel === v ? '#2563eb' : done ? '#14532d' : '#1a1a1a',
                color: activeVessel === v ? '#fff' : done ? '#4ade80' : placing ? '#f5a623' : '#555',
                border: `1px solid ${activeVessel === v ? '#3b82f6' : done ? '#166534' : '#2a2a2a'}`,
                cursor: 'pointer', position: 'relative',
              }}
            >
              {done ? '✓' : placing ? '·' : ''}{v}
              {stale && (
                <span
                  style={{
                    position: 'absolute', top: 2, right: 3,
                    width: 5, height: 5, borderRadius: '50%', background: '#fbbf24',
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {activeVessel && (
        <>
          <div style={{ height: 1, background: '#1e1e1e' }} />

          {/* Placement type buttons */}
          <div style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Place
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['ostium', 'waypoint', 'distal'] as AnchorType[]).map(t => (
              <button
                key={t}
                onClick={() => onSetPlacementMode(placementMode === t ? null : t)}
                style={{
                  fontSize: 10, padding: '4px 7px', borderRadius: 3, cursor: 'pointer',
                  background: placementMode === t ? ANCHOR_COLOR[t] + '33' : '#1a1a1a',
                  color: placementMode === t ? ANCHOR_COLOR[t] : '#555',
                  border: `1px solid ${placementMode === t ? ANCHOR_COLOR[t] : '#2a2a2a'}`,
                  fontWeight: placementMode === t ? 600 : 400,
                }}
              >
                ● {ANCHOR_LABEL[t]}
              </button>
            ))}
          </div>

          {placementMode && (
            <div style={{ fontSize: 10, color: '#2563eb', padding: '4px 6px', background: '#1e2a3a', borderRadius: 3 }}>
              Click in any MPR panel to place {ANCHOR_LABEL[placementMode].toLowerCase()}
            </div>
          )}

          {/* Anchor list */}
          {anchors.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Anchors
              </div>
              {anchors.map((a, i) => {
                const huSuspect = a.hu !== undefined && (a.hu < 40 || a.hu > 700);
                const editing = editingAnchorIdx === i;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, fontSize: 10,
                      background: editing ? '#0e2a35' : 'transparent',
                      border: editing ? '1px solid #06b6d4' : '1px solid transparent',
                      borderRadius: 3, padding: editing ? '2px 4px' : '0',
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: ANCHOR_COLOR[a.type], flexShrink: 0 }} />
                    <span style={{ color: editing ? '#67e8f9' : a.valid ? '#555' : '#666', flex: 1 }}>
                      {ANCHOR_LABEL[a.type]}
                      {!a.valid && <span style={{ color: '#ef4444', marginLeft: 4 }}>✕</span>}
                      {editing && <span style={{ color: '#67e8f9', marginLeft: 4 }}>· editing</span>}
                    </span>
                    {a.hu !== undefined && (
                      <span
                        title={huSuspect
                          ? 'HU outside expected blood range (40-700) — may indicate the click missed the lumen'
                          : 'Sampled HU at this anchor (used to adapt cost image locally)'}
                        style={{
                          fontFamily: 'monospace', fontSize: 9,
                          color: huSuspect ? '#fbbf24' : '#666',
                        }}
                      >
                        {Math.round(a.hu)} HU
                      </span>
                    )}
                    <button
                      onClick={() => onSetEditingAnchorIdx(editing ? null : i)}
                      title={editing ? 'Cancel edit' : 'Edit position — click in any MPR (loupe auto-shows)'}
                      style={{
                        fontSize: 10, padding: '0 4px', cursor: 'pointer',
                        background: editing ? '#06b6d4' : 'transparent',
                        border: 'none', color: editing ? '#fff' : '#666',
                      }}
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => onDeleteAnchor(i)}
                      style={{ fontSize: 9, color: '#444', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {/* Path info */}
          {path?.pathPoints && (
            <div style={{ fontSize: 10, color: '#60a5fa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Path: {path.pathPoints.length} pts</span>
              {path.extractedAt && (
                <RelativeTime ts={path.extractedAt} />
              )}
            </div>
          )}

          {/* Centerline lock — sync all MPRs to a point on the path */}
          {path?.pathPoints && path.pathPoints.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: centerlineLocked ? '#67e8f9' : '#888' }}>
                <input
                  type="checkbox"
                  checked={centerlineLocked}
                  onChange={e => onSetCenterlineLocked(e.target.checked)}
                  style={{ accentColor: '#06b6d4' }}
                />
                Sync MPRs to centerline
              </label>
              {centerlineLocked && (
                <>
                  <input
                    type="range"
                    min={0}
                    max={path.pathPoints.length - 1}
                    value={centerlineLockIdx}
                    onChange={e => onSetCenterlineLockIdx(parseInt(e.target.value, 10))}
                    style={{ width: '100%', accentColor: '#06b6d4' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#666', fontFamily: 'monospace' }}>
                    <span>pt {centerlineLockIdx + 1}/{path.pathPoints.length}</span>
                    <span>← / → to scrub · ⇧ for ×10</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Stale-vesselness warning */}
          {isStale && (
            <div
              title="Vesselness parameters have changed since this path was extracted. Re-extract for an up-to-date result."
              style={{
                fontSize: 10, color: '#fbbf24', padding: '4px 6px',
                background: '#3a2a14', borderRadius: 3, border: '1px solid #78350f',
              }}
            >
              ⚠ Vesselness changed since extraction — re-extract for current params
            </div>
          )}

          <div style={{ height: 1, background: '#1e1e1e' }} />

          {/* Invalid anchor notice — informational only.
              Common causes: anchor placed before preprocess masks loaded into RAM,
              or anchor at the very edge of the dilated cardiac ROI envelope.
              Extract still works; just flagged for the user's awareness. */}
          {hasInvalidAnchor && (
            <div
              title="An anchor was flagged outside the cardiac ROI. The path will still extract — Dijkstra routes from the nearest valid voxel. If the path looks wrong, replace the flagged anchor or bump the ROI Margin in Preprocess."
              style={{ fontSize: 10, color: '#fbbf24', padding: '4px 6px', background: '#3a2a14', borderRadius: 3 }}
            >
              ⚠ One anchor is flagged outside the ROI — extraction will still try; path may be lower quality.
            </div>
          )}

          {/* Extract button */}
          <button
            onClick={onExtractPath}
            disabled={!hasOstium || !hasDistal || extracting}
            style={{
              background: hasOstium && hasDistal ? '#2563eb' : '#1a1a1a',
              border: 'none', borderRadius: 5,
              color: hasOstium && hasDistal ? '#fff' : '#333',
              padding: '7px 0', fontSize: 12, fontWeight: 600,
              cursor: hasOstium && hasDistal && !extracting ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              opacity: extracting ? 0.6 : 1,
            }}
          >
            {extracting
              ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Extracting…</>
              : 'Extract Path'}
          </button>

          <button
            onClick={onClearVessel}
            style={{ fontSize: 10, color: '#444', background: 'transparent', border: '1px solid #222', borderRadius: 3, padding: '3px 0', cursor: 'pointer' }}
          >
            Clear {activeVessel}
          </button>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Props {
  study: StudyMeta;
  onBack: () => void;
}

const Session: React.FC<Props> = ({ study, onBack }) => {
  const { patient, description, date } = parseStudyName(study.name || study.uid);

  const [openStep, setOpenStep] = useState<StepId | null>('viewer');

  const [preprocessParams, setPreprocessParams] = useState<PreprocessParams>(DEFAULT_PREPROCESS_PARAMS);
  const [preprocessDone, setPreprocessDone] = useState(false);
  const [preprocessedVolume, setPreprocessedVolume] = useState<VolumeData | null>(null);
  const [preprocessedUid, setPreprocessedUid] = useState<string | null>(null);
  const [showPreprocessed, setShowPreprocessed] = useState(false);
  const [runningPreprocess, setRunningPreprocess] = useState(false);
  const [showMiniGame, setShowMiniGame] = useState(false);

  // Cmd+. (or Ctrl+. on Win/Linux) toggles the mini-game
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setShowMiniGame(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const [preprocessSteps, setPreprocessSteps] = useState<PreprocessProgress>({ current: null, completed: [] });
  const [quality, setQuality] = useState<QualityResult | null>(null);

  // On mount: validate the study still exists on the backend.  If the backend
  // was restarted (or the study was removed) the frontend may be holding a
  // stale UID — bounce back to the worklist instead of failing silently on
  // every subsequent algorithm call.
  useEffect(() => {
    getStudy(study.uid).catch(err => {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        console.warn(`Study ${study.uid} no longer in backend store — returning to worklist`);
        onBack();
      }
    });
  }, [study.uid, onBack]);

  // On mount: check cache and restore any previously completed steps
  useEffect(() => {
    getPipelineStatus(study.uid).then(async status => {
      if (status.preprocess.done) {
        const mergedParams = { ...DEFAULT_PREPROCESS_PARAMS, ...status.preprocess.params } as PreprocessParams;
        setPreprocessParams(mergedParams);
        // Backend has the result on disk — mark done immediately so the button
        // reads "Rerun" without waiting for the NIfTI fetch (which may be slow
        // or transiently fail right after a backend restart).
        setPreprocessDone(true);
        setPreprocessSteps({ current: null, completed: ['clip', 'denoise', 'mask', 'roi'] });
        if (status.preprocess.quality && (status.preprocess.quality as { flag?: string }).flag) {
          setQuality(status.preprocess.quality as unknown as QualityResult);
        }
        const preUid = `preprocess_${study.uid}`;
        try {
          const vol = await loadNiftiVolume(preUid);
          setPreprocessedVolume(vol);
          setPreprocessedUid(preUid);
        } catch { /* volume not yet in store — overlay simply won't render until rerun */ }
      }

      if (status.vesselness.done) {
        const mergedVes = { ...DEFAULT_VESSELNESS_PARAMS, ...status.vesselness.params } as VesselnessParams;
        setVesselnessParams(mergedVes);
        if (status.vesselness.percentiles && Object.keys(status.vesselness.percentiles).length > 0) {
          setVesselnessPercentiles(status.vesselness.percentiles);
        }
        const vesUid = `vesselness_${study.uid}`;
        try {
          const vol = await loadNiftiVolume(vesUid);
          setVesselness(vol);
        } catch { /* not yet in server store */ }
      }
    }).catch(() => { /* no cache yet, silent */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.uid]);

  // Poll preprocess step progress while running
  useEffect(() => {
    if (!runningPreprocess) return;
    const iv = setInterval(async () => {
      try {
        const p = await getPreprocessProgress(study.uid);
        setPreprocessSteps(p);
      } catch { /* ignore */ }
    }, 500);
    return () => clearInterval(iv);
  }, [runningPreprocess, study.uid]);

  const handleRunPreprocess = useCallback(async () => {
    setRunningPreprocess(true);
    setPreprocessSteps({ current: null, completed: [] });
    setShowPreprocessed(false);
    setQuality(null);
    try {
      const result: AlgorithmResult = await runPreprocess(study.uid, preprocessParams);
      if (result.status === 'ok') {
        const r = result.result as { preprocess_uid?: string; quality?: QualityResult };
        if (r.preprocess_uid) {
          setPreprocessedUid(r.preprocess_uid);
          setPreprocessDone(true);
          // Mark all stages complete — avoids the spinner staying on "roi"
          // if the polling interval ended mid-stage.
          setPreprocessSteps({ current: null, completed: ['clip', 'denoise', 'mask', 'roi'] });
          try {
            const vol = await loadNiftiVolume(r.preprocess_uid);
            setPreprocessedVolume(vol);
          } catch (volErr) {
            console.warn('Preprocess volume load failed:', volErr);
          }
        }
        if (r.quality) setQuality(r.quality);
      } else if (result.status === 'cancelled') {
        console.log('Preprocess cancelled by user');
      } else {
        console.error('Preprocess failed:', result.result);
      }
    } catch (err) {
      console.error('Preprocess error:', err);
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        console.warn('Study missing on backend — returning to worklist');
        onBack();
      }
    }
    finally { setRunningPreprocess(false); }
  }, [study.uid, preprocessParams, onBack]);

  // Vesselness state lives here so controls (accordion) and overlay (Viewer) share it
  const [vesselness, setVesselness] = useState<VolumeData | null>(null);
  const [vesselnessOpacity, setVesselnessOpacity] = useState(0.6);
  const [vesselnessThreshold, setVesselnessThreshold] = useState(0.0);
  const [vesselnessPercentiles, setVesselnessPercentiles] = useState<Record<string, number> | null>(null);
  const [vesselnessParams, setVesselnessParams] = useState<VesselnessParams>(DEFAULT_VESSELNESS_PARAMS);
  const [runningVesselness, setRunningVesselness] = useState(false);

  const handleRunVesselness = useCallback(async () => {
    setRunningVesselness(true);
    try {
      const result: AlgorithmResult = await runVesselness(study.uid, vesselnessParams);
      if (result.status === 'ok') {
        const r = result.result as { vesselness_uid?: string; percentiles?: Record<string, number> };
        if (r.percentiles) setVesselnessPercentiles(r.percentiles);
        if (r.vesselness_uid) {
          try {
            const vol = await loadNiftiVolume(r.vesselness_uid);
            setVesselness(vol);
          } catch (volErr) {
            console.warn('Vesselness volume load failed:', volErr);
          }
        }
      } else if (result.status === 'cancelled') {
        console.log('Vesselness cancelled by user');
      } else {
        console.error('Vesselness failed:', result.result);
      }
    } catch (err) {
      console.error('Vesselness error:', err);
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        console.warn('Study missing on backend — returning to worklist');
        onBack();
      }
    }
    finally { setRunningVesselness(false); }
  }, [study.uid, vesselnessParams, onBack]);

  // ---------------------------------------------------------------------------
  // Centerline state — persisted to backend `session.json` per study
  // ---------------------------------------------------------------------------
  const [vesselPaths, setVesselPaths] = useState<Map<VesselId, VesselPath>>(new Map());
  const [activeVessel, setActiveVessel] = useState<VesselId | null>(null);
  const [placementMode, setPlacementMode] = useState<AnchorType | null>(null);
  const [extractingPath, setExtractingPath] = useState(false);
  // Centerline scrub-lock: when enabled, all 3 MPR panels follow the active
  // vessel's path point at `centerlineLockIdx`.
  const [centerlineLocked, setCenterlineLocked] = useState(false);
  const [centerlineLockIdx, setCenterlineLockIdx] = useState(0);
  // Anchor editing: when set, the next MPR click moves anchor[idx] to that
  // world point instead of placing a new one.  Loupe auto-engages on press.
  const [editingAnchorIdx, setEditingAnchorIdx] = useState<number | null>(null);

  // Restore persisted session (anchors, paths) on mount.  We block saves until
  // restore completes so a transient empty Map doesn't overwrite saved data.
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    sessionRestoredRef.current = false;
    getSession(study.uid).then(state => {
      if (state.vessels) {
        const restored = new Map<VesselId, VesselPath>();
        for (const [vid, v] of Object.entries(state.vessels)) {
          if (!v) continue;
          restored.set(vid as VesselId, {
            vessel: vid as VesselId,
            anchors: v.anchors,
            pathPoints: v.pathPoints,
            status: v.status,
            vesselnessSig: v.vesselnessSig,
            extractedAt: v.extractedAt,
          });
        }
        if (restored.size > 0) {
          setVesselPaths(restored);
          // Auto-select the first vessel that has an extracted path so the
          // user sees the centerline drawn on the MPRs without having to
          // click into the panel and pick a vessel manually.
          for (const [vid, vp] of restored) {
            if (vp.pathPoints && vp.pathPoints.length > 0) {
              setActiveVessel(vid);
              break;
            }
          }
        }
      }
    }).catch(err => {
      console.warn('Session restore failed:', err);
    }).finally(() => {
      sessionRestoredRef.current = true;
    });
  }, [study.uid]);

  // Debounced auto-save: persist whenever vesselPaths changes (post-restore).
  useEffect(() => {
    if (!sessionRestoredRef.current) return;
    const handle = setTimeout(() => {
      const vessels: NonNullable<SessionState['vessels']> = {};
      vesselPaths.forEach((vp, vid) => {
        vessels[vid] = {
          anchors: vp.anchors, pathPoints: vp.pathPoints, status: vp.status,
          vesselnessSig: vp.vesselnessSig, extractedAt: vp.extractedAt,
        };
      });
      saveSession(study.uid, { vessels }).catch(err => {
        console.warn('Session save failed:', err);
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [study.uid, vesselPaths]);

  const handleSelectVessel = useCallback((v: VesselId) => {
    setActiveVessel(v);
    // Auto-advance placement: select ostium first, then distal once ostium exists.
    // Vessels that already have both anchors get no auto-mode (user is just inspecting).
    setVesselPaths(prev => {
      const existing = prev.get(v);
      const anchors = existing?.anchors ?? [];
      const hasOstium = anchors.some(a => a.type === 'ostium');
      const hasDistal = anchors.some(a => a.type === 'distal');
      if (!hasOstium)        setPlacementMode('ostium');
      else if (!hasDistal)   setPlacementMode('distal');
      else                   setPlacementMode(null);
      if (existing) return prev;
      const next = new Map(prev);
      next.set(v, { vessel: v, anchors: [], status: 'placing' });
      return next;
    });
  }, []);

  const handlePlaceAnchor = useCallback((world: THREE.Vector3) => {
    if (!activeVessel) return;

    // Edit-mode branch: move the anchor at editingAnchorIdx to this world point.
    if (editingAnchorIdx !== null) {
      const idx = editingAnchorIdx;
      setVesselPaths(prev => {
        const next = new Map(prev);
        const existing = next.get(activeVessel);
        if (!existing || idx < 0 || idx >= existing.anchors.length) return prev;
        const anchors = [...existing.anchors];
        anchors[idx] = { ...anchors[idx], world: [world.x, world.y, world.z], valid: true };
        next.set(activeVessel, { ...existing, anchors });
        return next;
      });
      setEditingAnchorIdx(null);
      // Re-validate so the HU readout + valid flag refresh
      validatePoint(study.uid, [world.x, world.y, world.z])
        .then(res => {
          setVesselPaths(prev => {
            const next = new Map(prev);
            const vp = next.get(activeVessel);
            if (!vp || idx < 0 || idx >= vp.anchors.length) return prev;
            const anchors = [...vp.anchors];
            anchors[idx] = { ...anchors[idx], valid: res.valid, hu: res.hu };
            next.set(activeVessel, { ...vp, anchors });
            return next;
          });
        })
        .catch(() => {});
      return;
    }

    if (!placementMode) return;
    const anchor: VesselAnchor = {
      type: placementMode,
      world: [world.x, world.y, world.z],
      locked: false,
      // Optimistic default: assume valid.  validate-point flips this to false
      // only if the backend explicitly reports the anchor outside the ROI.
      // (Avoids stuck-invalid state when validate-point 404s transiently.)
      valid: true,
    };
    setVesselPaths(prev => {
      const next = new Map(prev);
      const existing = next.get(activeVessel);
      const anchors = existing ? [...existing.anchors] : [];
      if (placementMode === 'ostium' || placementMode === 'distal') {
        const idx = anchors.findIndex(a => a.type === placementMode);
        if (idx >= 0) anchors[idx] = anchor;
        else anchors.push(anchor);
      } else {
        anchors.push(anchor);
      }
      // Sort: ostium → waypoints → distal
      const ORDER: Record<AnchorType, number> = { ostium: 0, waypoint: 1, distal: 2 };
      anchors.sort((a, b) => ORDER[a.type] - ORDER[b.type]);
      next.set(activeVessel, { vessel: activeVessel, anchors, pathPoints: existing?.pathPoints, status: 'placing' });
      return next;
    });
    // Auto-advance: ostium → distal (if not yet placed) → done.
    // Waypoint mode stays active so the user can keep adding waypoints.
    if (placementMode === 'ostium') {
      const existing = vesselPaths.get(activeVessel);
      const hasDistal = existing?.anchors.some(a => a.type === 'distal') ?? false;
      setPlacementMode(hasDistal ? null : 'distal');
    } else if (placementMode === 'distal') {
      setPlacementMode(null);
    }

    // Async validation
    validatePoint(study.uid, [world.x, world.y, world.z])
      .then(res => {
        setVesselPaths(prev => {
          const next = new Map(prev);
          const vp = next.get(activeVessel);
          if (!vp) return prev;
          const anchors = vp.anchors.map(a =>
            a.type === anchor.type && a.world[0] === anchor.world[0] && a.world[1] === anchor.world[1]
              ? { ...a, valid: res.valid, hu: res.hu }
              : a,
          );
          next.set(activeVessel, { ...vp, anchors });
          return next;
        });
      })
      .catch(() => { /* validation failure is non-critical */ });
  }, [activeVessel, placementMode, study.uid, editingAnchorIdx]);

  // Stable signature of the current vesselness configuration, used to flag
  // previously-extracted paths as stale when params change.
  const currentVesselnessSig = useMemo(
    () => JSON.stringify(Object.entries(vesselnessParams).sort()),
    [vesselnessParams],
  );

  const handleExtractPath = useCallback(async () => {
    if (!activeVessel) return;
    const vp = vesselPaths.get(activeVessel);
    if (!vp) return;
    setExtractingPath(true);
    try {
      const res = await extractPath(study.uid, activeVessel, vp.anchors);
      setVesselPaths(prev => {
        const next = new Map(prev);
        const existing = next.get(activeVessel);
        if (existing) {
          next.set(activeVessel, {
            ...existing,
            pathPoints: res.path,
            status: 'extracted',
            vesselnessSig: currentVesselnessSig,
            extractedAt: Date.now(),
          });
        }
        return next;
      });
    } catch (err) { console.error('Path extraction failed:', err); }
    finally { setExtractingPath(false); }
  }, [activeVessel, vesselPaths, study.uid, currentVesselnessSig]);

  const handleClearVessel = useCallback(() => {
    if (!activeVessel) return;
    setVesselPaths(prev => {
      const next = new Map(prev);
      next.set(activeVessel, { vessel: activeVessel, anchors: [], status: 'placing' });
      return next;
    });
    setPlacementMode(null);
  }, [activeVessel]);

  const handleDeleteAnchor = useCallback((idx: number) => {
    if (!activeVessel) return;
    setVesselPaths(prev => {
      const next = new Map(prev);
      const vp = next.get(activeVessel);
      if (!vp) return prev;
      const anchors = vp.anchors.filter((_, i) => i !== idx);
      next.set(activeVessel, { ...vp, anchors, pathPoints: undefined, status: 'placing' });
      return next;
    });
  }, [activeVessel]);

  // Derived: flat list of all anchors for display across panels
  // Crosshair override: edit-mode (jump to the anchor being edited) takes
  // priority over centerline scrub-lock, which itself overrides the user-
  // clicked crosshair.
  const centerlineLockOverride = useMemo(() => {
    // Edit mode: lock all MPRs onto the anchor being moved
    if (editingAnchorIdx !== null && activeVessel) {
      const vp = vesselPaths.get(activeVessel);
      const a = vp?.anchors[editingAnchorIdx];
      if (a) return new THREE.Vector3(a.world[0], a.world[1], a.world[2]);
    }
    if (!centerlineLocked || !activeVessel) return null;
    const path = vesselPaths.get(activeVessel)?.pathPoints;
    if (!path || path.length === 0) return null;
    const i = Math.max(0, Math.min(path.length - 1, centerlineLockIdx));
    const [x, y, z] = path[i];
    return new THREE.Vector3(x, y, z);
  }, [centerlineLocked, centerlineLockIdx, activeVessel, vesselPaths, editingAnchorIdx]);

  // World position of the anchor being edited — passed separately so MPRs
  // can highlight that specific anchor with a cyan ring.
  const editingAnchorWorld = useMemo<[number, number, number] | null>(() => {
    if (editingAnchorIdx === null || !activeVessel) return null;
    const vp = vesselPaths.get(activeVessel);
    const a = vp?.anchors[editingAnchorIdx];
    return a ? [a.world[0], a.world[1], a.world[2]] : null;
  }, [editingAnchorIdx, activeVessel, vesselPaths]);

  // Reset/clamp the scrub index when the active vessel or lock state changes
  useEffect(() => {
    setCenterlineLockIdx(0);
  }, [activeVessel, centerlineLocked]);

  // ←/→ scrub the centerline while locked.  Shift = ×10 step.
  useEffect(() => {
    if (!centerlineLocked || !activeVessel) return;
    const path = vesselPaths.get(activeVessel)?.pathPoints;
    if (!path || path.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCenterlineLockIdx(i => Math.min(path.length - 1, i + step));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCenterlineLockIdx(i => Math.max(0, i - step));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [centerlineLocked, activeVessel, vesselPaths]);

  const allAnchors = useMemo(() => {
    const out: VesselAnchor[] = [];
    vesselPaths.forEach(vp => out.push(...vp.anchors));
    return out;
  }, [vesselPaths]);

  const activePathPoints = activeVessel ? vesselPaths.get(activeVessel)?.pathPoints : undefined;

  const toggle = (id: StepId, available: boolean) => {
    if (!available) return;
    setOpenStep(prev => prev === id ? null : id);
  };

  const STEPS: { id: StepId; label: string; available: boolean }[] = [
    { id: 'viewer',     label: 'Viewer',      available: true              },
    { id: 'preprocess', label: 'Preprocess',  available: true              },
    { id: 'vesselness', label: 'Vesselness',  available: preprocessDone    },
    { id: 'centerline', label: 'Centerline',  available: vesselness !== null },
    { id: 'edit',       label: 'Edit',        available: false },
    { id: 'model',      label: '3D Model',    available: false },
    { id: 'report',     label: 'Report',      available: false },
  ];

  const openIndex = STEPS.findIndex(s => s.id === openStep);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

        {/* Viewer — always mounted */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Viewer
            currentStudy={study}
            vesselness={vesselness}
            vesselnessOpacity={vesselnessOpacity}
            vesselnessThreshold={vesselnessThreshold}
            preprocessedVolume={preprocessedVolume}
            preprocessedUid={preprocessedUid}
            onBack={onBack}
            patientLabel={patient}
            patientSub={[description, date].filter(Boolean).join(' · ')}
            showPreprocessed={openStep !== 'centerline' && showPreprocessed}
            allAnchors={allAnchors}
            activePathPoints={activePathPoints}
            placementMode={placementMode}
            onPlaceAnchor={handlePlaceAnchor}
            crosshairOverride={centerlineLockOverride}
            editingActive={editingAnchorIdx !== null}
            editingAnchorWorld={editingAnchorWorld}
          />
        </div>

      {/* Accordion panel */}
        <div style={{
          width: 200, flexShrink: 0,
          background: '#111', borderLeft: '1px solid #1e1e1e',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
        }}>
          {STEPS.map((s, i) => {
            const open = openStep === s.id;
            const done = s.available && openIndex > i;
            return (
              <React.Fragment key={s.id}>
                <SectionLabel
                  index={i + 1}
                  label={s.label}
                  open={open}
                  available={s.available}
                  done={done}
                  onClick={() => toggle(s.id, s.available)}
                />
                {open && (
                  <div style={{ borderBottom: '1px solid #1e1e1e' }}>
                    {s.id === 'preprocess' ? (
                      <PreprocessBody
                        params={preprocessParams}
                        onChange={p => { setPreprocessParams(p); setPreprocessDone(false); setShowPreprocessed(false); setQuality(null); }}
                        onReset={() => { setPreprocessParams(DEFAULT_PREPROCESS_PARAMS); setPreprocessDone(false); setShowPreprocessed(false); setQuality(null); }}
                        running={runningPreprocess}
                        done={preprocessDone}
                        onRun={() => void handleRunPreprocess()}
                        onStop={() => void cancelStep(study.uid, 'preprocess')}
                        showPreprocessed={showPreprocessed}
                        onTogglePreprocessed={setShowPreprocessed}
                        quality={quality}
                        steps={preprocessSteps}
                      />
                    ) : s.id === 'vesselness' ? (
                      <VesselnessBody
                        vesselness={vesselness}
                        vesselnessOpacity={vesselnessOpacity}
                        vesselnessThreshold={vesselnessThreshold}
                        vesselnessPercentiles={vesselnessPercentiles}
                        vesselnessParams={vesselnessParams}
                        quality={quality}
                        running={runningVesselness}
                        onRun={() => void handleRunVesselness()}
                        onStop={() => void cancelStep(study.uid, 'vesselness')}
                        onOpacityChange={setVesselnessOpacity}
                        onThresholdChange={setVesselnessThreshold}
                        onParamsChange={setVesselnessParams}
                        onResetParams={() => setVesselnessParams(DEFAULT_VESSELNESS_PARAMS)}
                      />
                    ) : s.id === 'centerline' ? (
                      <CenterlineBody
                        activeVessel={activeVessel}
                        vesselPaths={vesselPaths}
                        placementMode={placementMode}
                        extracting={extractingPath}
                        currentVesselnessSig={currentVesselnessSig}
                        centerlineLocked={centerlineLocked}
                        centerlineLockIdx={centerlineLockIdx}
                        editingAnchorIdx={editingAnchorIdx}
                        onSetCenterlineLocked={setCenterlineLocked}
                        onSetCenterlineLockIdx={setCenterlineLockIdx}
                        onSetEditingAnchorIdx={setEditingAnchorIdx}
                        onSelectVessel={handleSelectVessel}
                        onSetPlacementMode={setPlacementMode}
                        onExtractPath={() => void handleExtractPath()}
                        onClearVessel={handleClearVessel}
                        onDeleteAnchor={handleDeleteAnchor}
                      />
                    ) : s.id === 'viewer' ? (
                      <div style={{ padding: '10px 14px', fontSize: 11, color: '#444' }}>
                        Use the toolbar to switch layouts and tools.
                      </div>
                    ) : (
                      <div style={{ padding: '10px 14px', fontSize: 11, color: '#333' }}>
                        Coming soon
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {showMiniGame && <MiniGame onClose={() => setShowMiniGame(false)} />}

    </div>
  );
};

export default Session;
