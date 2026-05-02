import React from 'react';
import type { LayoutId } from './Viewer';

const WL_PRESETS: Record<string, { wl: number; ww: number }> = {
  Cardiac:      { wl: 300,  ww: 800  },
  'Soft Tissue':{ wl: 40,   ww: 400  },
  Lung:         { wl: -600, ww: 1500 },
  Bone:         { wl: 400,  ww: 1800 },
};

const LAYOUT_OPTIONS: { id: LayoutId; label: string; title: string }[] = [
  { id: 'conventional', label: 'Conv',   title: 'Axial + Curved MPR + Cross-section + 3D' },
  { id: 'fourUp',       label: '4-Up',   title: '2×2 grid' },
  { id: 'axialMIP',     label: 'A+3D',   title: 'Axial + 3D side by side' },
  { id: 'axialOnly',    label: 'Axial',  title: 'Full-screen axial' },
  { id: 'orthoMIP',     label: 'Ortho',  title: 'Axial + Coronal + Sagittal + 3D' },
  { id: 'oblique',      label: 'Obl',    title: 'Multi-oblique' },
];

type Tool = 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Angle' | 'Scroll' | 'Crosshairs';

const TOOLS: [Tool, string, string][] = [
  ['WindowLevel', 'W/L',  'Window / Level'],
  ['Pan',         'Pan',  'Pan'],
  ['Zoom',        'Zoom', 'Zoom'],
  ['Scroll',      'Scrl', 'Scroll slices'],
  ['Crosshairs',  'HU',   'HU probe'],
  ['Length',      '↔',   'Measure length'],
  ['Angle',       '∠',   'Measure angle'],
];

interface Props {
  activeTool: Tool;
  onWLWWChange: (wl: number, ww: number) => void;
  onToolChange: (tool: Tool) => void;
  layoutId: LayoutId;
  onLayoutChange: (id: LayoutId) => void;
  onBack?: () => void;
  patientLabel?: string;
  patientSub?: string;
}

const Toolbar: React.FC<Props> = ({ activeTool, onWLWWChange, onToolChange, layoutId, onLayoutChange, onBack, patientLabel, patientSub }) => (
  <div className="toolbar">
    {/* Back + patient */}
    {onBack && (
      <>
        <button
          onClick={onBack}
          title="Back to worklist"
          style={{ background: 'transparent', border: 'none', color: '#555', padding: '2px 6px 2px 2px' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
          onMouseLeave={e => (e.currentTarget.style.color = '#555')}
        >
          ←
        </button>
        {patientLabel && (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', marginRight: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#ccc', lineHeight: 1.2 }}>{patientLabel}</span>
            {patientSub && <span style={{ fontSize: 9, color: '#444', lineHeight: 1.2 }}>{patientSub}</span>}
          </div>
        )}
        <div className="toolbar-sep" />
      </>
    )}

    {/* Layout */}
    {LAYOUT_OPTIONS.map(({ id, label, title }) => (
      <button
        key={id}
        className={layoutId === id ? 'active' : ''}
        onClick={() => onLayoutChange(id)}
        title={title}
      >
        {label}
      </button>
    ))}

    <div className="toolbar-sep" />

    {/* Tools */}
    {TOOLS.map(([t, label, title]) => (
      <button
        key={t}
        className={activeTool === t ? 'active' : ''}
        onClick={() => onToolChange(t)}
        title={title}
      >
        {label}
      </button>
    ))}

    <div className="toolbar-sep" />

    {/* W/L presets */}
    <select
      value=""
      onChange={e => { const p = WL_PRESETS[e.target.value]; if (p) onWLWWChange(p.wl, p.ww); }}
      title="Window/Level preset"
    >
      <option value="" disabled>Preset</option>
      {Object.keys(WL_PRESETS).map(name => (
        <option key={name} value={name}>{name}</option>
      ))}
    </select>
  </div>
);

export default Toolbar;
