/**
 * SlicePanel — generic Cornerstone3D StackViewport for coronal / sagittal.
 *
 * Crosshair overlay:
 *  - Always visible when crosshairWorld is set (committed position from props)
 *  - In Crosshair tool mode: lines track the mouse cursor at 60 fps via
 *    imperative SVG DOM updates (no React re-renders on every mousemove)
 *  - Hover world position is broadcast via a custom window event so all other
 *    panels update their crosshairs simultaneously
 *  - Lines are color-coded by the plane they represent:
 *      horizontal = axial (#F34A33 red)    for coronal/sagittal
 *                 = coronal (#6EB04B green) for axial
 *      vertical   = sagittal (#EDD54C yellow) for axial/coronal
 *                 = coronal (#6EB04B green)    for sagittal
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  StackScrollTool,
  ToolGroupManager,
} = cornerstoneTools;

type Axis = 'axial' | 'coronal' | 'sagittal';

interface Props {
  panelId: string;
  axis: Axis;
  uid: string | null;
  sliceCount: number;
  studySpacing: [number, number, number];
  studyOrigin: [number, number, number];
  wl: number;
  ww: number;
  label: string;
  panelClass: string;
  activeTool?: string;
  onWLWWChange?: (wl: number, ww: number) => void;
  onSliceChange?: (idx: number) => void;
  crosshairWorld?: [number, number, number] | null;
  onCrosshairNavigate?: (worldPoint: [number, number, number]) => void;
}

const LABEL_COLOR: Record<Axis, string> = {
  axial: '#F34A33', coronal: '#6EB04B', sagittal: '#EDD54C',
};

function pixelSpacingForAxis(axis: Axis, s: [number, number, number]): [number, number] {
  if (axis === 'coronal')  return [s[0], s[2]]; // rows=Z cols=X
  if (axis === 'sagittal') return [s[0], s[1]]; // rows=Z cols=Y
  return [s[1], s[2]];                          // axial rows=Y cols=X
}

const SlicePanel: React.FC<Props> = ({
  panelId, axis, uid, sliceCount, studySpacing, studyOrigin,
  wl, ww, label, panelClass,
  activeTool, onWLWWChange, onSliceChange, crosshairWorld, onCrosshairNavigate,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const engineRef     = useRef<cornerstone.RenderingEngine | null>(null);
  const suppressVOI   = useRef(false);
  const crosshairRef  = useRef(crosshairWorld);
  const activeToolRef = useRef(activeTool);
  const [ready, setReady]             = useState(false);
  const [currentSlice, setCurrentSlice] = useState(0);

  // Imperative SVG refs — updated directly to avoid re-renders on every mousemove
  const svgRef  = useRef<SVGSVGElement>(null);
  const hLRef   = useRef<SVGLineElement>(null);
  const hRRef   = useRef<SVGLineElement>(null);
  const vTRef   = useRef<SVGLineElement>(null);
  const vBRef   = useRef<SVGLineElement>(null);
  const dotRef  = useRef<SVGCircleElement>(null);

  const engineId   = `${panelId}-engine`;
  const viewportId = `${panelId}-viewport`;
  const toolGroupId = `${panelId}-tools`;

  const { h: hColor, v: vColor } = CROSSHAIR_COLORS[axis];

  useEffect(() => { crosshairRef.current  = crosshairWorld; }, [crosshairWorld]);
  useEffect(() => { activeToolRef.current = activeTool;     }, [activeTool]);

  useEffect(() => { registerAcctaImageLoader(); }, []);

  // ── Imperative crosshair SVG helpers ─────────────────────────────────────
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
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
    try {
      const pos = vp.worldToCanvas(cp);
      positionCrosshair(pos[0], pos[1]);
    } catch { hideCrosshair(); }
  }, [hideCrosshair, positionCrosshair]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Engine + viewport setup ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const engine = new cornerstone.RenderingEngine(engineId);
    engineRef.current = engine;
    engine.enableElement({
      viewportId,
      type: cornerstone.Enums.ViewportType.STACK,
      element: containerRef.current,
      defaultOptions: { background: [0.07, 0.07, 0.07] as [number, number, number] },
    });
    let tg = ToolGroupManager.getToolGroup(toolGroupId);
    if (!tg) {
      tg = ToolGroupManager.createToolGroup(toolGroupId)!;
      tg.addTool(WindowLevelTool.toolName);
      tg.addTool(PanTool.toolName);
      tg.addTool(ZoomTool.toolName);
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
    tg.addViewport(viewportId, engineId);
    setReady(true);
    return () => {
      ToolGroupManager.destroyToolGroup(toolGroupId);
      engine.destroy();
      engineRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load image stack ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !uid || sliceCount === 0 || !engineRef.current) return;
    engineRef.current.resize(true);
    const imageIds = Array.from({ length: sliceCount }, (_, i) => `accta://${uid}/${axis}/${i}`);
    preCacheFullMetadata(uid, axis, sliceCount, studySpacing, studyOrigin);
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
    const mid = Math.floor(sliceCount / 2);
    vp.setStack(imageIds, mid)
      .then(() => {
        vp.resetCamera();
        const imgData = vp.getImageData();
        const el = containerRef.current;
        if (imgData && el && el.clientWidth > 0 && el.clientHeight > 0) {
          const [cols, rows] = imgData.dimensions as [number, number, number];
          const [rSpc, cSpc] = pixelSpacingForAxis(axis, studySpacing);
          const vpAspect = el.clientWidth / el.clientHeight;
          if ((cols * cSpc) / (rows * rSpc) < vpAspect) {
            vp.setCamera({ parallelScale: (cols * cSpc) / (2 * vpAspect) });
          }
        }
        vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
        vp.render();
        setCurrentSlice(mid);
        onSliceChange?.(mid);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, uid, sliceCount]);

  // ── W/L sync from parent ─────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
    suppressVOI.current = true;
    vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } });
    vp.render();
    suppressVOI.current = false;
  }, [ready, wl, ww]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── W/L broadcast ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !containerRef.current || !onWLWWChange) return;
    const el = containerRef.current;
    const handle = (evt: Event) => {
      if (suppressVOI.current) return;
      const { range } = (evt as CustomEvent).detail ?? {};
      if (!range) return;
      const newWw = range.upper - range.lower;
      onWLWWChange(range.lower + newWw / 2, newWw);
    };
    el.addEventListener(cornerstone.Enums.Events.VOI_MODIFIED, handle as EventListener);
    return () => el.removeEventListener(cornerstone.Enums.Events.VOI_MODIFIED, handle as EventListener);
  }, [ready, onWLWWChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tool switching ────────────────────────────────────────────────────────
  useEffect(() => {
    const tg = ToolGroupManager.getToolGroup(toolGroupId);
    if (!tg) return;
    [WindowLevelTool.toolName, PanTool.toolName, ZoomTool.toolName, StackScrollTool.toolName]
      .forEach(n => { try { tg.setToolPassive(n); } catch { /* ignore */ } });
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
        const name =
          activeTool === 'Pan'  ? PanTool.toolName  :
          activeTool === 'Zoom' ? ZoomTool.toolName : WindowLevelTool.toolName;
        tg.setToolActive(name, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
      }
    }
    if (containerRef.current) {
      containerRef.current.style.cursor =
        activeTool === 'Crosshair' ? 'none'      :  // custom cursor via SVG
        activeTool === 'Scroll'    ? 'ns-resize' :
        activeTool === 'Pan'       ? 'grab'       :
        activeTool === 'Zoom'      ? 'zoom-in'    : 'default';
    }
    // Revert crosshair to committed position when switching tools
    showCommittedCrosshair();
  }, [activeTool, showCommittedCrosshair]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── IMAGE_RENDERED: update slice counter + crosshair ────────────────────
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;
    const handle = () => {
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
      const idx = vp.getCurrentImageIdIndex();
      setCurrentSlice(idx);
      onSliceChange?.(idx);
      showCommittedCrosshair();
    };
    el.addEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handle as EventListener);
    return () => el.removeEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handle as EventListener);
  }, [ready, onSliceChange, showCommittedCrosshair]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Show committed crosshair when prop changes ───────────────────────────
  useEffect(() => {
    if (!ready) return;
    showCommittedCrosshair();
  }, [ready, crosshairWorld, showCommittedCrosshair]);

  // ── Listen for crosshair hover/leave events from OTHER panels ────────────
  useEffect(() => {
    if (!ready) return;

    const onHover = (e: Event) => {
      const { world, sourcePanelId } = (e as CustomEvent).detail ?? {};
      if (sourcePanelId === panelId || activeToolRef.current !== 'Crosshair') return;
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
      try {
        const pos = vp.worldToCanvas(world);
        positionCrosshair(pos[0], pos[1]);
      } catch { /* viewport not ready */ }
    };

    const onLeave = (e: Event) => {
      const { sourcePanelId } = (e as CustomEvent).detail ?? {};
      if (sourcePanelId === panelId || activeToolRef.current !== 'Crosshair') return;
      showCommittedCrosshair();
    };

    window.addEventListener(CROSSHAIR_HOVER_EVENT, onHover);
    window.addEventListener(CROSSHAIR_LEAVE_EVENT, onLeave);
    return () => {
      window.removeEventListener(CROSSHAIR_HOVER_EVENT, onHover);
      window.removeEventListener(CROSSHAIR_LEAVE_EVENT, onLeave);
    };
  }, [ready, positionCrosshair, showCommittedCrosshair]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Local pointer events: hover tracking + navigation ───────────────────
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;
    let pressed = false;

    const handleMove = (e: PointerEvent) => {
      if (!engineRef.current) return;
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (activeToolRef.current === 'Crosshair') {
        // Update this panel's crosshair to mouse position immediately
        positionCrosshair(cx, cy);
        // Get world position, broadcast to other panels, and navigate if pressed
        try {
          const w = vp.canvasToWorld([cx, cy]);
          const world: [number, number, number] = [w[0], w[1], w[2]];
          window.dispatchEvent(new CustomEvent(CROSSHAIR_HOVER_EVENT, {
            detail: { world, sourcePanelId: panelId },
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
            const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
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
        detail: { sourcePanelId: panelId },
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
    setCurrentSlice(idx);
    onSliceChange?.(idx);
    if (engineRef.current) {
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IStackViewport;
      vp.setImageIdIndex(idx).catch(() => {});
    }
  }, [onSliceChange]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`panel ${panelClass}`}
      style={{ height: '100%', position: 'relative' }}
    >
      <span className="panel-label" style={{ color: LABEL_COLOR[axis] }}>{label}</span>

      {!uid && (
        <div className="panel-placeholder" style={{ position: 'absolute', zIndex: 5 }}>
          No study loaded
        </div>
      )}

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
      {uid && sliceCount > 0 && (
        <span style={{
          position: 'absolute', bottom: 24, right: 6,
          fontSize: 11, color: '#aaa', zIndex: 10, pointerEvents: 'none',
        }}>
          {currentSlice + 1} / {sliceCount}
        </span>
      )}

      {/* Slice scrollbar */}
      {uid && sliceCount > 1 && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          zIndex: 10, padding: '0 6px 3px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.55))',
        }}>
          <input
            type="range"
            min={0}
            max={sliceCount - 1}
            value={currentSlice}
            onChange={handleSlider}
            style={{ width: '100%', height: '4px', cursor: 'pointer', accentColor: LABEL_COLOR[axis] }}
          />
        </div>
      )}
    </div>
  );
};

export default SlicePanel;
