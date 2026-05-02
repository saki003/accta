/**
 * MultiObliquePanel — three-viewport oblique MPR panel.
 *
 * All three viewports share one tool group so Cornerstone3D's CrosshairsTool
 * can draw reference lines and expose rotation handles for oblique tilting.
 *
 * Viewport IDs use the prefix "ob-" to avoid collisions with the OrthoPanel
 * viewports ("axial", "coronal", "sagittal") that may exist in the same engine.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import type { Vec3 } from '../lib/vecMath';

const {
  CrosshairsTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  ToolGroupManager,
} = cornerstoneTools;

// ---------------------------------------------------------------------------
// Panel definitions
// ---------------------------------------------------------------------------

const PANELS = [
  {
    id: 'ob-axial',
    label: 'Axial',
    color: '#F34A33',
    normal: [0, 0, -1] as Vec3,
    viewUp: [0, 1, 0] as Vec3,
  },
  {
    id: 'ob-coronal',
    label: 'Coronal',
    color: '#6EB04B',
    normal: [0, 1, 0] as Vec3,
    viewUp: [0, 0, -1] as Vec3,
  },
  {
    id: 'ob-sagittal',
    label: 'Sagittal',
    color: '#EDD54C',
    normal: [-1, 0, 0] as Vec3,
    viewUp: [0, 0, -1] as Vec3,
  },
] as const;

const TOOL_GROUP_ID = 'oblique-shared-tg';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  sharedEngine: cornerstone.RenderingEngine;
  volumeId: string | null;
  wl: number;
  ww: number;
  activeTool: string;
  onWLWWChange?: (wl: number, ww: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MultiObliquePanel: React.FC<Props> = ({
  sharedEngine,
  volumeId,
  wl,
  ww,
  activeTool,
  onWLWWChange,
}) => {
  const elRefs = useRef<(HTMLDivElement | null)[]>([null, null, null]);
  const [ready, setReady] = useState(false);
  const [slabMm, setSlabMm] = useState(0);
  const syncingRef = useRef(false);  // prevents re-entrant sync loops

  // ---------------------------------------------------------------------------
  // Mount: enable viewports + create shared tool group
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const els = elRefs.current;
    if (!els[0] || !els[1] || !els[2]) return;

    PANELS.forEach((p, i) => {
      sharedEngine.enableElement({
        viewportId: p.id,
        type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
        element: els[i] as HTMLDivElement,
        defaultOptions: {
          orientation: {
            viewPlaneNormal: p.normal,
            viewUp: p.viewUp,
          },
          background: [0, 0, 0] as cornerstone.Types.Point3,
        },
      });
    });

    const tg = ToolGroupManager.createToolGroup(TOOL_GROUP_ID)!;
    PANELS.forEach(p => tg.addViewport(p.id, sharedEngine.id));

    tg.addTool(CrosshairsTool.toolName, {
      configuration: {
        getReferenceLineColor: (vpId: string) =>
          PANELS.find(p => p.id === vpId)?.color ?? '#ffffff',
        getReferenceLineControllable: () => true,
        getReferenceLineDraggableRotatable: () => true,
        getReferenceLineSlabThicknessControlsOn: () => true,
      },
    });
    tg.addTool(WindowLevelTool.toolName);
    tg.addTool(PanTool.toolName);
    tg.addTool(ZoomTool.toolName);
    tg.addTool(StackScrollTool.toolName);

    tg.setToolActive(CrosshairsTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    tg.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
    });

    setReady(true);

    return () => {
      ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      PANELS.forEach(p => {
        try { sharedEngine.disableElement(p.id); } catch { /* ignore */ }
      });
      setReady(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Volume load / change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !volumeId) return;
    PANELS.forEach(p => {
      try {
        const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
        void vp.setVolumes([{ volumeId }]).then(() => {
          vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
          vp.render();
        });
      } catch { /* viewport not yet ready */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, volumeId]);

  // ---------------------------------------------------------------------------
  // WL/WW sync
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !volumeId) return;
    PANELS.forEach(p => {
      try {
        const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
        vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
        vp.render();
      } catch { /* ignore */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, wl, ww]);

  // ---------------------------------------------------------------------------
  // Slab thickness (MIP)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !volumeId) return;
    PANELS.forEach(p => {
      try {
        const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
        vp.setProperties({ slabThickness: slabMm <= 0 ? 0.1 : slabMm });
        vp.render();
      } catch { /* ignore */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, slabMm, volumeId]);

  // ---------------------------------------------------------------------------
  // Tool switching
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!tg) return;

    [CrosshairsTool.toolName, WindowLevelTool.toolName, PanTool.toolName, ZoomTool.toolName]
      .forEach(n => { try { tg.setToolPassive(n); } catch { /* ignore */ } });

    const primary =
      activeTool === 'WindowLevel' ? WindowLevelTool.toolName :
      activeTool === 'Pan'         ? PanTool.toolName         :
      activeTool === 'Zoom'        ? ZoomTool.toolName        :
      CrosshairsTool.toolName;

    tg.setToolActive(primary, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    tg.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
    });
  }, [ready, activeTool]);

  // ---------------------------------------------------------------------------
  // Helpers: apply VOI / slab to all viewports
  // ---------------------------------------------------------------------------
  const applyVoiToAll = useCallback((lower: number, upper: number, sourceId: string) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    PANELS.forEach(p => {
      if (p.id === sourceId) return;
      try {
        const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
        vp.setProperties({ voiRange: { lower, upper } });
        vp.render();
      } catch { /* ignore */ }
    });
    syncingRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySlabToAll = useCallback((mm: number, sourceId: string) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const clamped = Math.max(0.1, mm);
    setSlabMm(Math.round(mm));
    PANELS.forEach(p => {
      if (p.id === sourceId) return;
      try {
        const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
        vp.setProperties({ slabThickness: clamped });
        vp.render();
      } catch { /* ignore */ }
    });
    syncingRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // VOI_MODIFIED + IMAGE_RENDERED listeners — sync W/L and slab across panels
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const els = elRefs.current;

    const handlers: Array<{ el: HTMLDivElement; evtName: string; fn: EventListener }> = [];

    PANELS.forEach((p, i) => {
      const el = els[i];
      if (!el) return;

      // W/L sync
      const onVoi = (evt: Event) => {
        const detail = (evt as CustomEvent).detail as { volumeId?: string; range?: { lower: number; upper: number } } | undefined;
        if (!detail?.range) return;
        const { lower, upper } = detail.range;
        applyVoiToAll(lower, upper, p.id);
        const ww = upper - lower;
        const wl = lower + ww / 2;
        onWLWWChange?.(wl, ww);
      };

      // Slab sync: CrosshairsTool modifies slabThickness then fires CAMERA_MODIFIED.
      // We read the new value and push it to the other two panels.
      // Using CAMERA_MODIFIED (not IMAGE_RENDERED) so we don't react to our own
      // render() calls, which would create a feedback loop.
      const onCamera = () => {
        try {
          const vp = sharedEngine.getViewport(p.id) as cornerstone.Types.IVolumeViewport;
          const mm = vp.getSlabThickness();
          if (mm > 0.1) applySlabToAll(mm, p.id);
        } catch { /* ignore */ }
      };

      el.addEventListener(cornerstone.EVENTS.VOI_MODIFIED, onVoi as EventListener);
      el.addEventListener(cornerstone.EVENTS.CAMERA_MODIFIED, onCamera as EventListener);
      handlers.push(
        { el, evtName: cornerstone.EVENTS.VOI_MODIFIED, fn: onVoi as EventListener },
        { el, evtName: cornerstone.EVENTS.CAMERA_MODIFIED, fn: onCamera as EventListener },
      );
    });

    return () => {
      handlers.forEach(({ el, evtName, fn }) => el.removeEventListener(evtName, fn));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, applyVoiToAll, applySlabToAll]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#111' }}>

      {/* MIP control bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 10px',
        background: '#1a1a1a',
        borderBottom: '1px solid #333',
        flexShrink: 0,
        fontSize: 11,
        fontFamily: 'monospace',
        color: '#aaa',
      }}>
        <span>MIP slab</span>
        <input
          type="range"
          min={0}
          max={150}
          step={1}
          value={slabMm}
          onChange={e => setSlabMm(Number(e.target.value))}
          style={{ width: 160, accentColor: '#4a9eff' }}
        />
        <span style={{ minWidth: 48, color: '#ccc' }}>{slabMm} mm</span>
        <button
          onClick={() => setSlabMm(0)}
          style={{ fontSize: 10, padding: '1px 6px', cursor: 'pointer' }}
          title="Reset slab to 0"
        >
          Reset
        </button>
      </div>

    <div style={{
      display: 'flex',
      flex: 1,
      gap: 2,
      background: '#111',
      overflow: 'hidden',
    }}>
      {PANELS.map((p, i) => (
        <div key={p.id} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div
            ref={el => { elRefs.current[i] = el; }}
            style={{ width: '100%', height: '100%' }}
          />
          <div style={{
            position: 'absolute',
            top: 4,
            left: 6,
            color: p.color,
            fontSize: 11,
            fontWeight: 600,
            pointerEvents: 'none',
            fontFamily: 'monospace',
            textShadow: '0 0 3px #000',
          }}>
            {p.label}
          </div>
        </div>
      ))}
    </div>
    </div>
  );
};

export default MultiObliquePanel;
