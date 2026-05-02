/**
 * Viewer — root layout component with switchable panel arrangements.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RenderingEngine, volumeLoader } from '@cornerstonejs/core';
import { runAortaCenterline } from '../api/client';
import type { AlgorithmResult } from '../api/types';
import { preCacheFullMetadata, buildAxialImageIds } from '../lib/acctaImageLoader';

import Toolbar from './Toolbar';
import MPRPanel from './MPRPanel';
import CurvedMPRPanel from './CurvedMPRPanel';
import CrossSectPanel from './CrossSectPanel';
import VolumePanel from './VolumePanel';
import MultiObliquePanel from './MultiObliquePanel';

import { loadNiftiVolume, type VolumeData } from '../lib/niftiVolume';

// ---------------------------------------------------------------------------
// Layout system
// ---------------------------------------------------------------------------

export type LayoutId = 'conventional' | 'fourUp' | 'axialMIP' | 'axialOnly' | 'orthoMIP' | 'oblique';

interface LayoutDef {
  label: string;
  columns: string;
  rows: string;
  areas: string;
  visible: ReadonlySet<'axial' | 'curved' | 'crosssect' | 'mip' | 'coronal' | 'sagittal'>;
}

const LAYOUTS: Record<LayoutId, LayoutDef> = {
  conventional: {
    label: 'Conventional',
    columns: '1fr 1fr 1fr',
    rows: '1fr 1fr',
    areas: '"axial curved crosssect" "axial mip mip"',
    visible: new Set(['axial', 'curved', 'crosssect', 'mip'] as const),
  },
  fourUp: {
    label: '4-Up',
    columns: '1fr 1fr',
    rows: '1fr 1fr',
    areas: '"axial coronal" "sagittal mip"',
    visible: new Set(['axial', 'coronal', 'sagittal', 'mip'] as const),
  },
  axialMIP: {
    label: 'Axial + 3D',
    columns: '1fr 1fr',
    rows: '1fr',
    areas: '"axial mip"',
    visible: new Set(['axial', 'mip'] as const),
  },
  axialOnly: {
    label: 'Axial Only',
    columns: '1fr',
    rows: '1fr',
    areas: '"axial"',
    visible: new Set(['axial'] as const),
  },
  orthoMIP: {
    label: 'Ortho + 3D',
    columns: '2fr 1fr',
    rows: '1fr 1fr 1fr',
    areas: '"axial coronal" "axial sagittal" "axial mip"',
    visible: new Set(['axial', 'coronal', 'sagittal', 'mip'] as const),
  },
  oblique: {
    label: 'Oblique',
    columns: '1fr',
    rows: '1fr',
    areas: '"axial"',
    visible: new Set([] as never[]),
  },
};

function slotStyle(
  area: 'axial' | 'curved' | 'crosssect' | 'mip' | 'coronal' | 'sagittal',
  visible: ReadonlySet<string>,
): React.CSSProperties {
  return {
    gridArea: area,
    display: visible.has(area) ? 'flex' : 'none',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
    minHeight: 0,
  };
}

type Tool = 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Angle' | 'Scroll' | 'Crosshairs';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ViewerProps {
  currentStudy: import('../api/types').StudyMeta | null;
  vesselness: VolumeData | null;
  vesselnessOpacity: number;
  vesselnessThreshold: number;
  preprocessedVolume: VolumeData | null;
  preprocessedUid: string | null;
  showPreprocessed: boolean;
  onBack?: () => void;
  patientLabel?: string;
  patientSub?: string;
  // centerline
  allAnchors?: import('../api/types').VesselAnchor[];
  activePathPoints?: [number, number, number][];
  placementMode?: import('../api/types').AnchorType | null;
  onPlaceAnchor?: (world: THREE.Vector3) => void;
  /** When non-null, all MPR panels lock onto this world point (sync-scrub). */
  crosshairOverride?: THREE.Vector3 | null;
  /** When true, MPR press opens the loupe immediately (no long-press) and
   *  release routes through onPlaceAnchor — used for "move anchor" edit mode. */
  editingActive?: boolean;
  /** World position of the anchor being edited; MPR highlights it cyan. */
  editingAnchorWorld?: [number, number, number] | null;
}

const Viewer: React.FC<ViewerProps> = ({
  currentStudy,
  vesselness,
  vesselnessOpacity,
  vesselnessThreshold,
  preprocessedVolume,
  preprocessedUid,
  showPreprocessed,
  onBack,
  patientLabel,
  patientSub,
  allAnchors,
  activePathPoints,
  placementMode,
  onPlaceAnchor,
  crosshairOverride,
  editingActive,
  editingAnchorWorld,
}) => {
  const activeVolume = showPreprocessed && preprocessedVolume ? preprocessedVolume : null;

  const [wl, setWl] = useState(300);
  const [ww, setWw] = useState(800);
  const [activeTool, setActiveTool] = useState<Tool>('WindowLevel');
  const [slabMm] = useState(0);

  const [volume, setVolume] = useState<VolumeData | null>(null);
  const [crosshairWorld, setCrosshairWorld] = useState<THREE.Vector3 | null>(null);
  // If Session has locked the MPRs onto a centerline point, that overrides
  // the user-clicked crosshair so all three panels stay synchronized.
  const effectiveCrosshair = crosshairOverride ?? crosshairWorld;
  const [showCrosshair, setShowCrosshair] = useState(true);

  // 'H' toggles the crosshair overlay across all MPR panels.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'h' || e.key === 'H') {
        setShowCrosshair(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const [cornerVolumeId, setCornerVolumeId] = useState<string | null>(null);

  const [orthoEngine] = useState<RenderingEngine>(() => new RenderingEngine('ortho-shared-engine'));
  useEffect(() => { return () => { orthoEngine.destroy(); }; }, []); // eslint-disable-line

  const [centerline, setCenterline] = useState<[number, number, number][] | null>(null);
  const [centerlineIdx, setCenterlineIdx] = useState(0);
  const [runningCenterline, setRunningCenterline] = useState(false);
  const lastAutoRunUid = useRef<string | null>(null);

  const [layoutId, setLayoutId] = useState<LayoutId>('orthoMIP');
  const [focusedSlot, setFocusedSlot] = useState<string | null>(null);

  // Reset focus when layout changes
  useEffect(() => { setFocusedSlot(null); }, [layoutId]);

  // For orthoMIP: reorder grid so the focused slot spans the left column
  const layout = (() => {
    const base = LAYOUTS[layoutId];
    if (layoutId !== 'orthoMIP' || !focusedSlot) return base;
    const all = ['axial', 'coronal', 'sagittal', 'mip'] as const;
    const rest = all.filter(s => s !== focusedSlot);
    return {
      ...base,
      areas: rest.map(s => `"${focusedSlot} ${s}"`).join(' '),
    };
  })();

  const handleSlotDoubleClick = useCallback((slot: string) => {
    if (layoutId !== 'orthoMIP') return;
    setFocusedSlot(prev => prev === slot ? null : slot);
  }, [layoutId]);

  const handleWLWWChange = useCallback((newWl: number, newWw: number) => {
    setWl(newWl);
    setWw(newWw);
  }, []);

  const handleNavigate = useCallback((world: THREE.Vector3) => {
    setCrosshairWorld(world.clone());
  }, []);

  // ---------------------------------------------------------------------------
  // NIfTI volume loading
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!currentStudy) {
      setVolume(null);
      setCrosshairWorld(null);
      return;
    }

    let cancelled = false;
    setVolume(null);
    setCornerVolumeId(null);

    loadNiftiVolume(currentStudy.uid)
      .then(vol => {
        if (cancelled) { vol.texture.dispose(); return; }
        setVolume(vol);

        const [nz, ny, nx] = vol.shape;
        const [dz, dy, dx] = vol.spacing;
        const [ox, oy, oz] = vol.origin;
        setCrosshairWorld(new THREE.Vector3(
          ox + (nx / 2) * dx,
          oy + (ny / 2) * dy,
          oz + (nz / 2) * dz,
        ));

        const uid = currentStudy!.uid;
        const vId = `accta-vol:${uid}`;
        const imageIds = buildAxialImageIds(uid, nz);
        preCacheFullMetadata(uid, 'axial', nz, [dz, dy, dx], [oz, oy, ox], [nz, ny, nx]);
        volumeLoader.createAndCacheVolume(vId, { imageIds })
          .then(v => { if (!cancelled) { (v as { load: () => void }).load(); setCornerVolumeId(vId); } })
          .catch(console.error);
      })
      .catch(console.error);

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStudy?.uid]);

  // ---------------------------------------------------------------------------
  // Centerline
  // ---------------------------------------------------------------------------
  const handleRunCenterline = useCallback(async () => {
    if (!currentStudy) return;
    setRunningCenterline(true);
    try {
      const result: AlgorithmResult = await runAortaCenterline(currentStudy.uid);
      if (result.status === 'ok') {
        const points = result.result.points as [number, number, number][] | undefined;
        if (points && points.length >= 2) { setCenterline(points); setCenterlineIdx(0); }
      } else {
        console.error('Centerline failed:', (result.result as { error?: string }).error ?? result.result);
      }
    } catch (err) { console.error('Centerline error:', err); }
    finally { setRunningCenterline(false); }
  }, [currentStudy]);

  useEffect(() => {
    if (!currentStudy || currentStudy.uid === lastAutoRunUid.current) return;
    lastAutoRunUid.current = currentStudy.uid;
    setCenterline(null);
    void handleRunCenterline();
  }, [currentStudy, handleRunCenterline]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <Toolbar
        activeTool={activeTool}
        onWLWWChange={handleWLWWChange}
        onToolChange={setActiveTool}
        layoutId={layoutId}
        onLayoutChange={setLayoutId}
        onBack={onBack}
        patientLabel={patientLabel}
        patientSub={patientSub}
      />

      {layoutId === 'oblique' ? (
        <MultiObliquePanel
          sharedEngine={orthoEngine}
          volumeId={cornerVolumeId}
          wl={wl} ww={ww}
          activeTool={activeTool}
          onWLWWChange={handleWLWWChange}
        />
      ) : (
        <div
          className="viewer-grid"
          style={{
            gridTemplateColumns: layout.columns,
            gridTemplateRows: layout.rows,
            gridTemplateAreas: layout.areas,
            flex: 1,
          }}
        >
          <div style={slotStyle('axial', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('axial')}>
            <MPRPanel axis="axial" volume={activeVolume ?? volume} vesselness={vesselness} vesselnessOpacity={vesselnessOpacity} vesselnessThreshold={vesselnessThreshold}
              crosshairWorld={effectiveCrosshair} showCrosshair={showCrosshair} wl={wl} ww={ww} slabMm={slabMm}
              activeTool={activeTool} label="Axial" showWLWW
              onWLWWChange={handleWLWWChange} onNavigate={handleNavigate}
              anchors={allAnchors} pathPoints={activePathPoints}
              placementMode={placementMode} onPlaceAnchor={onPlaceAnchor} editingActive={editingActive} editingAnchorWorld={editingAnchorWorld} />
          </div>
          <div style={slotStyle('coronal', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('coronal')}>
            <MPRPanel axis="coronal" volume={activeVolume ?? volume} vesselness={vesselness} vesselnessOpacity={vesselnessOpacity} vesselnessThreshold={vesselnessThreshold}
              crosshairWorld={effectiveCrosshair} showCrosshair={showCrosshair} wl={wl} ww={ww} slabMm={slabMm}
              activeTool={activeTool} label="Coronal"
              onWLWWChange={handleWLWWChange} onNavigate={handleNavigate}
              anchors={allAnchors} pathPoints={activePathPoints}
              placementMode={placementMode} onPlaceAnchor={onPlaceAnchor} editingActive={editingActive} editingAnchorWorld={editingAnchorWorld} />
          </div>
          <div style={slotStyle('sagittal', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('sagittal')}>
            <MPRPanel axis="sagittal" volume={activeVolume ?? volume} vesselness={vesselness} vesselnessOpacity={vesselnessOpacity} vesselnessThreshold={vesselnessThreshold}
              crosshairWorld={effectiveCrosshair} showCrosshair={showCrosshair} wl={wl} ww={ww} slabMm={slabMm}
              activeTool={activeTool} label="Sagittal"
              onWLWWChange={handleWLWWChange} onNavigate={handleNavigate}
              anchors={allAnchors} pathPoints={activePathPoints}
              placementMode={placementMode} onPlaceAnchor={onPlaceAnchor} editingActive={editingActive} editingAnchorWorld={editingAnchorWorld} />
          </div>
          <div style={slotStyle('curved', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('curved')}>
            <CurvedMPRPanel uid={currentStudy?.uid ?? null} centerline={centerline} wl={wl} ww={ww}
              onRunCenterline={() => void handleRunCenterline()} runningCenterline={runningCenterline} />
          </div>
          <div style={slotStyle('crosssect', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('crosssect')}>
            <CrossSectPanel uid={currentStudy?.uid ?? null} centerline={centerline}
              centerlineIdx={centerlineIdx} wl={wl} ww={ww} onCenterlineIdxChange={setCenterlineIdx} />
          </div>
          <div style={slotStyle('mip', layout.visible)} onDoubleClick={() => handleSlotDoubleClick('mip')}>
            <VolumePanel
              study={currentStudy ?? null}
              overrideUid={showPreprocessed && preprocessedUid ? preprocessedUid : null}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default Viewer;
