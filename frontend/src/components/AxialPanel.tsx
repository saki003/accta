/**
 * AxialPanel — axial CCTA stack rendered with Cornerstone3D StackViewport.
 *
 * Crosshair overlay mirrors SlicePanel: imperative SVG DOM updates for 60 fps
 * hover tracking, cross-panel propagation via custom window events, and
 * color-coding (horizontal = coronal green, vertical = sagittal yellow).
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { registerAcctaImageLoader, preCacheFullMetadata } from '../lib/acctaImageLoader';
import {
  CROSSHAIR_COLORS,
  CROSSHAIR_GAP,
  CROSSHAIR_ARM,
  CROSSHAIR_HOVER_EVENT,
  CROSSHAIR_LEAVE_EVENT,
} from '../lib/crosshairColors';

const {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  LengthTool,
  AngleTool,
  StackScrollTool,
  ToolGroupManager,
} = cornerstoneTools;

const TOOL_GROUP_ID = 'axial-tool-group';
const PANEL_ID      = 'axial';
const VIEWPORT_ID   = 'axial-viewport';
const ENGINE_ID     = 'axial-rendering-engine';

const TOOL_MAP: Record<string, string> = {
  WindowLevel: WindowLevelTool.toolName,
  Pan:         PanTool.toolName,
  Zoom:        ZoomTool.toolName,
  Length:      LengthTool.toolName,
  Angle:       AngleTool.toolName,
};

const { h: hColor, v: vColor } = CROSSHAIR_COLORS.axial;

interface Props {
  uid: string | null;
  depth: number;
  /** Full study spacing [dz, dy, dx] in mm */
  studySpacing: [number, number, number];
  /** Full study origin [oz, oy, ox] in mm */
  studyOrigin: [number, number, number];
  wl: number;
  ww: number;
  currentSlice: number;
  activeTool: string;
  onSliceChange: (index: number) => void;
  onWLWWChange?: (wl: number, ww: number) => void;
  /** 3D world point defining the crosshair intersection (patient mm). */
  crosshairWorld?: [number, number, number] | null;
  /** Called when user clicks/drags in Crosshair mode. */
  onCrosshairNavigate?: (worldPoint: [number, number, number]) => void;
}

function ensureToolGroup(viewportId: string, renderingEngineId: string) {
  let tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
  if (!tg) {
    tg = ToolGroupManager.createToolGroup(TOOL_GROUP_ID)!;
    tg.addTool(WindowLevelTool.toolName);
    tg.addTool(PanTool.toolName);
    tg.addTool(ZoomTool.toolName);
    tg.addTool(LengthTool.toolName);
    tg.addTool(AngleTool.toolName);
    tg.addTool(StackScrollTool.toolName);

    tg.setToolActive(WindowLevelTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    tg.setToolActive(PanTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
    });
    tg.setToolActive(ZoomTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
    });
    tg.setToolActive(StackScrollTool.toolName);
  }
  tg.addViewport(viewportId, renderingEngineId);
  return tg;
}

const AxialPanel: React.FC<Props> = ({
  uid,
  depth,
  studySpacing,
  studyOrigin,
  wl,
  ww,
  currentSlice,
  activeTool,
  onSliceChange,
  onWLWWChange,
  crosshairWorld,
  onCrosshairNavigate,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const engineRef     = useRef<cornerstone.RenderingEngine | null>(null);
  const suppressVOI   = useRef(false);
  const crosshairRef  = useRef(crosshairWorld);
  const activeToolRef = useRef(activeTool);
  const [ready, setReady] = useState(false);

  // Imperative SVG refs
  const svgRef = useRef<SVGSVGElement>(null);
  const hLRef  = useRef<SVGLineElement>(null);
  const hRRef  = useRef<SVGLineElement>(null);
  const vTRef  = useRef<SVGLineElement>(null);
  const vBRef  = useRef<SVGLineElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);

  useEffect(() => { crosshairRef.current  = crosshairWorld; }, [crosshairWorld]);
  useEffect(() => { activeToolRef.current = activeTool;     }, [activeTool]);

  useEffect(() => { registerAcctaImageLoader(); }, []);

  // ── Imperative SVG crosshair helpers ─────────────────────────────────────
  const positionCrosshair = useCallback((cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.style.visibility = 'visible';
    const g = CROSSHAIR_GAP;
    const a = CROSSHAIR_ARM;
    hLRef.current?.setAttribute('x1', `${cx - g - a}`); hLRef.current?.setAttribute('y1', `${cy}`);
    hLRef.current?.setAttribute('x2', `${cx - g}`);      hLRef.current?.setAttribute('y2', `${cy}`);
    hRRef.current?.setAttribute('x1', `${cx + g}`);      hRRef.current?.setAttribute('y1', `${cy}`);
    hRRef.current?.setAttribute('x2', `${cx + g + a}`);  hRRef.current?.setAttribute('y2', `${cy}`);
    vTRef.current?.setAttribute('x1', `${cx}`);          vTRef.current?.setAttribute('y1', `${cy - g - a}`);
    vTRef.current?.setAttribute('x2', `${cx}`);          vTRef.current?.setAttribute('y2', `${cy - g}`);
    vBRef.current?.setAttribute('x1', `${cx}`);          vBRef.current?.setAttribute('y1', `${cy + g}`);
    vBRef.current?.setAttribute('x2', `${cx}`);          vBRef.current?.setAttribute('y2', `${cy + g + a}`);
    dotRef.current?.setAttribute('cx', `${cx}`);
    dotRef.current?.setAttribute('cy', `${cy}`);
  }, []);

  const hideCrosshair = useCallback(() => {
    if (svgRef.current) svgRef.current.style.visibility = 'hidden';
  }, []);

  const showCommittedCrosshair = useCallback(() => {
    const cp = crosshairRef.current;
    if (!cp || !engineRef.current) { hideCrosshair(); return; }
    const vp = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
    try {
      const pos = vp.worldToCanvas(cp);
      positionCrosshair(pos[0], pos[1]);
    } catch { hideCrosshair(); }
  }, [hideCrosshair, positionCrosshair]);

  // ── Create engine + viewport ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const engine = new cornerstone.RenderingEngine(ENGINE_ID);
    engineRef.current = engine;

    engine.enableElement({
      viewportId: VIEWPORT_ID,
      type: cornerstone.Enums.ViewportType.STACK,
      element: containerRef.current,
      defaultOptions: {
        background: [0.07, 0.07, 0.07] as [number, number, number],
      },
    });

    ensureToolGroup(VIEWPORT_ID, ENGINE_ID);
    setReady(true);

    return () => {
      ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      engine.destroy();
      engineRef.current = null;
      setReady(false);
    };
  }, []);

  // ── Load image stack ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !uid || depth === 0 || !engineRef.current) return;

    engineRef.current.resize(true);

    const imageIds = Array.from(
      { length: depth },
      (_, i) => `accta://${uid}/axial/${i}`,
    );

    preCacheFullMetadata(uid, 'axial', depth, studySpacing, studyOrigin);

    const viewport = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;

    viewport
      .setStack(imageIds, Math.floor(depth / 2))
      .then(() => {
        viewport.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
        viewport.render();
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, uid, depth]);

  // ── Sync W/L from parent ─────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const viewport = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
    suppressVOI.current = true;
    viewport.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
    viewport.render();
    suppressVOI.current = false;
  }, [ready, wl, ww]);

  // ── Broadcast W/L changes from this panel ───────────────────────────────
  useEffect(() => {
    if (!ready || !containerRef.current || !onWLWWChange) return;
    const el = containerRef.current;

    const handleVOI = (evt: Event) => {
      if (suppressVOI.current) return;
      const { range } = (evt as CustomEvent).detail ?? {};
      if (!range) return;
      const newWw = range.upper - range.lower;
      onWLWWChange(range.lower + newWw / 2, newWw);
    };

    el.addEventListener(cornerstone.Enums.Events.VOI_MODIFIED, handleVOI as EventListener);
    return () => el.removeEventListener(cornerstone.Enums.Events.VOI_MODIFIED, handleVOI as EventListener);
  }, [ready, onWLWWChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigate to requested slice ──────────────────────────────────────────
  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const viewport = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
    if (viewport.getCurrentImageIdIndex() !== currentSlice) {
      viewport.setImageIdIndex(currentSlice).catch(console.error);
    }
  }, [ready, currentSlice]);

  // ── Switch active tool ───────────────────────────────────────────────────
  useEffect(() => {
    const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!tg) return;

    Object.values(TOOL_MAP).forEach((name) => {
      try { tg.setToolPassive(name); } catch { /* ignore */ }
    });
    try { tg.setToolPassive(StackScrollTool.toolName); } catch { /* ignore */ }

    if (activeTool === 'Scroll') {
      tg.setToolActive(StackScrollTool.toolName, {
        bindings: [
          { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary },
          { mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel },
        ],
      });
    } else {
      tg.setToolActive(StackScrollTool.toolName);
      if (activeTool !== 'Crosshair') {
        const toolName = TOOL_MAP[activeTool] ?? WindowLevelTool.toolName;
        tg.setToolActive(toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
      }
    }

    if (containerRef.current) {
      containerRef.current.style.cursor =
        activeTool === 'Crosshair' ? 'none'      :
        activeTool === 'Scroll'    ? 'ns-resize' :
        activeTool === 'Pan'       ? 'grab'       :
        activeTool === 'Zoom'      ? 'zoom-in'    : 'default';
    }

    showCommittedCrosshair();
  }, [activeTool, showCommittedCrosshair]);

  // ── IMAGE_RENDERED: report slice + update crosshair ──────────────────────
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;

    const handleRendered = () => {
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
      onSliceChange(vp.getCurrentImageIdIndex());
      showCommittedCrosshair();
    };

    el.addEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handleRendered as EventListener);
    return () => el.removeEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handleRendered as EventListener);
  }, [ready, onSliceChange, showCommittedCrosshair]);

  // ── Show committed crosshair when world point changes ───────────────────
  useEffect(() => {
    if (!ready) return;
    showCommittedCrosshair();
  }, [ready, crosshairWorld, showCommittedCrosshair]);

  // ── Listen for crosshair hover/leave events from OTHER panels ────────────
  useEffect(() => {
    if (!ready) return;

    const onHover = (e: Event) => {
      const { world, sourcePanelId } = (e as CustomEvent).detail ?? {};
      if (sourcePanelId === PANEL_ID || activeToolRef.current !== 'Crosshair') return;
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
      try {
        const pos = vp.worldToCanvas(world);
        positionCrosshair(pos[0], pos[1]);
      } catch { /* viewport not ready */ }
    };

    const onLeave = (e: Event) => {
      const { sourcePanelId } = (e as CustomEvent).detail ?? {};
      if (sourcePanelId === PANEL_ID || activeToolRef.current !== 'Crosshair') return;
      showCommittedCrosshair();
    };

    window.addEventListener(CROSSHAIR_HOVER_EVENT, onHover);
    window.addEventListener(CROSSHAIR_LEAVE_EVENT, onLeave);
    return () => {
      window.removeEventListener(CROSSHAIR_HOVER_EVENT, onHover);
      window.removeEventListener(CROSSHAIR_LEAVE_EVENT, onLeave);
    };
  }, [ready, positionCrosshair, showCommittedCrosshair]);

  // ── Local pointer events: hover tracking + navigation ───────────────────
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;
    let pressed = false;

    const handleMove = (e: PointerEvent) => {
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (activeToolRef.current === 'Crosshair') {
        positionCrosshair(cx, cy);
        try {
          const w = vp.canvasToWorld([cx, cy]);
          const world: [number, number, number] = [w[0], w[1], w[2]];
          window.dispatchEvent(new CustomEvent(CROSSHAIR_HOVER_EVENT, {
            detail: { world, sourcePanelId: PANEL_ID },
          }));
          if (pressed && onCrosshairNavigate) onCrosshairNavigate(world);
        } catch { /* viewport not ready */ }
      }
    };

    let downX = 0;
    let downY = 0;

    const handleDown = (e: PointerEvent) => {
      pressed = true;
      downX = e.clientX;
      downY = e.clientY;
      handleMove(e);
    };

    const handleUp = (e: PointerEvent) => {
      if (pressed && activeToolRef.current === 'Scroll' && onCrosshairNavigate) {
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        if (dx * dx + dy * dy < 25) {
          // Treat as click: navigate all planes to this point
          if (engineRef.current) {
            const vp = engineRef.current.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
            const rect = el.getBoundingClientRect();
            try {
              const w = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]);
              onCrosshairNavigate([w[0], w[1], w[2]]);
            } catch { /* viewport not ready */ }
          }
        }
      }
      pressed = false;
    };

    const handleLeave = () => {
      if (activeToolRef.current !== 'Crosshair') return;
      showCommittedCrosshair();
      window.dispatchEvent(new CustomEvent(CROSSHAIR_LEAVE_EVENT, {
        detail: { sourcePanelId: PANEL_ID },
      }));
    };

    el.addEventListener('pointermove',  handleMove);
    el.addEventListener('pointerdown',  handleDown);
    el.addEventListener('pointerleave', handleLeave);
    window.addEventListener('pointerup', handleUp as EventListener);
    return () => {
      el.removeEventListener('pointermove',  handleMove);
      el.removeEventListener('pointerdown',  handleDown);
      el.removeEventListener('pointerleave', handleLeave);
      window.removeEventListener('pointerup', handleUp as EventListener);
    };
  }, [ready, positionCrosshair, showCommittedCrosshair, onCrosshairNavigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slider handler ───────────────────────────────────────────────────────
  const handleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = Number(e.target.value);
    onSliceChange(idx);
  }, [onSliceChange]);

  return (
    <div className="panel panel-axial" style={{ height: '100%', position: 'relative' }}>
      <span className="panel-label">Axial CCTA</span>

      {!uid && (
        <div className="panel-placeholder" style={{ position: 'absolute', zIndex: 5 }}>
          No study loaded
        </div>
      )}

      {/* Always mounted at full size so WebGL context has real dimensions */}
      <div ref={containerRef} className="cs-viewport" />

      {/* Crosshair SVG — always in DOM, updated imperatively */}
      <svg
        ref={svgRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none', zIndex: 8,
          visibility: 'hidden',
        }}
      >
        <line ref={hLRef} stroke={hColor} strokeWidth="1.5" opacity="0.9" />
        <line ref={hRRef} stroke={hColor} strokeWidth="1.5" opacity="0.9" />
        <line ref={vTRef} stroke={vColor} strokeWidth="1.5" opacity="0.9" />
        <line ref={vBRef} stroke={vColor} strokeWidth="1.5" opacity="0.9" />
        <circle ref={dotRef} r="3" fill="white" stroke="rgba(0,0,0,0.4)" strokeWidth="0.5" opacity="0.95" />
      </svg>

      {/* Slice counter */}
      {uid && depth > 0 && (
        <span style={{
          position: 'absolute', bottom: 24, right: 6,
          fontSize: 11, color: '#aaa', zIndex: 10,
          pointerEvents: 'none',
        }}>
          {currentSlice + 1} / {depth}
        </span>
      )}

      {/* Slice scrollbar */}
      {uid && depth > 1 && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          zIndex: 10, padding: '0 6px 3px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.55))',
        }}>
          <input
            type="range"
            min={0}
            max={depth - 1}
            value={currentSlice}
            onChange={handleSlider}
            style={{ width: '100%', height: '4px', cursor: 'pointer', accentColor: '#F34A33' }}
          />
        </div>
      )}
    </div>
  );
};

export default AxialPanel;
