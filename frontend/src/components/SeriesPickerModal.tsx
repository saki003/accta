/**
 * SeriesPickerModal — shown after the user selects a folder via "Add Folder…".
 *
 * Displays all DICOM series found in the folder with contrast / phase info
 * so the user can pick exactly which series to load.
 */

import React, { useState } from 'react';
import type { ScannedSeries } from '../lib/dicomScanner';

interface Props {
  series: ScannedSeries[];
  scanning: boolean;
  onSelect: (series: ScannedSeries) => void;
  onClose: () => void;
}

const CONTRAST_BADGE: Record<ScannedSeries['contrast'], { label: string; color: string }> = {
  'contrast':     { label: 'CONTRAST',     color: '#4A90D9' },
  'non-contrast': { label: 'NON-CONTRAST', color: '#888'    },
  'unknown':      { label: '?',            color: '#666'    },
};

function thicknessLabel(t: number | null) { return t != null ? `${t.toFixed(1)} mm` : '—'; }
function kvpLabel(k: number | null)       { return k != null ? `${k} kVp` : '—'; }

// Dim scout, timing bolus, dose reports
const LOW_VALUE = ['scout', 'timing', 'bolus', 'dose', 'report', 'localizer'];
function isLowValue(s: ScannedSeries) {
  return LOW_VALUE.some((kw) => s.description.toLowerCase().includes(kw)) || s.slice_count < 5;
}

const SeriesPickerModal: React.FC<Props> = ({ series, scanning, onSelect, onClose }) => {
  const [selected, setSelected] = useState<ScannedSeries | null>(null);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="browse-modal" style={{ maxWidth: 760 }}>

        {/* Header */}
        <div className="browse-header">
          <span className="browse-title">Select Series to Load</span>
          <button className="browse-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: '10px 14px', flex: 1, overflow: 'auto', minHeight: 0 }}>
          {scanning && (
            <div className="browse-loading">Scanning DICOM files…</div>
          )}

          {!scanning && series.length === 0 && (
            <div className="browse-empty">No DICOM series found in selected folder.</div>
          )}

          {series.length > 0 && (
            <table className="series-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th>Phase</th>
                  <th>Contrast</th>
                  <th>Slices</th>
                  <th>Thickness</th>
                  <th>kVp</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {series.map((s) => {
                  const badge = CONTRAST_BADGE[s.contrast];
                  return (
                    <tr
                      key={s.series_uid}
                      className={[
                        'series-row',
                        isLowValue(s) ? 'series-dim' : '',
                        selected?.series_uid === s.series_uid ? 'selected' : '',
                      ].join(' ')}
                      onClick={() => setSelected(s)}
                    >
                      <td className="mono">{s.series_number}</td>
                      <td>{s.description}</td>
                      <td style={{ fontSize: 10, color: '#aaa' }}>{s.phase}</td>
                      <td>
                        <span style={{
                          fontSize: 9,
                          fontWeight: 700,
                          color: badge.color,
                          letterSpacing: '0.05em',
                        }}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="mono">{s.slice_count}</td>
                      <td className="mono">{thicknessLabel(s.slice_thickness_mm)}</td>
                      <td className="mono">{kvpLabel(s.kvp)}</td>
                      <td className="mono">{s.rows > 0 ? `${s.rows}×${s.cols}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="browse-footer">
          {selected && (
            <span className="browse-selection">
              Selected: <strong>{selected.description}</strong>
              {' '}({selected.slice_count} slices)
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!selected || scanning}
            onClick={() => selected && onSelect(selected)}
          >
            Load Series
          </button>
        </div>
      </div>
    </div>
  );
};

export default SeriesPickerModal;
