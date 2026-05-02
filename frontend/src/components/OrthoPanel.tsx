/**
 * OrthoPanel — Vitrea/Syngo-style orthogonal MPR panel using VolumeViewport.
 *
 * Replaces both AxialPanel.tsx and SlicePanel.tsx.
 *
 * Features:
 * - Uses ORTHOGRAPHIC VolumeViewport so oblique planes are supported
 * - SVG crosshair overlay with:
 *     - Colored arms for H and V planes (per crosshairColors.ts)
 *     - Rotation handles (circles) at arm ends for interactive rotation
 *     - Slab thickness brackets (dashed lines offset by slab amount)
 * - Cross-panel hover sync via custom window events
 * - Camera sync from parent (planeCam prop) via effect
 * - Crosshair navigation via parent crosshairWorld prop
 * - Reports scroll/pan navigation back via onCrosshairNavigate
 * - Reports rotation deltas via onRotate
 * - Reports slab changes via onSlabChange
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { registerAcctaImageLoader } from '../lib/acctaImageLoader';
import {
  CROSSHAIR_COLORS,
  CROSSHAIR_GAP,
  CROSSHAIR_ARM,
} from '../lib/crosshairColors';
import { Vec3, dot, cross, scale, add, normalize } from '../lib/vecMath';

const {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  ToolGroupManager,
} = cornerstoneTools;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Axis = 'axial' | 'coronal' | 'sagittal';

export interface PlaneCam {
  normal: Vec3;
  viewUp: Vec3;
}

/**
 * HV_PLANE[sourceAxis][hv] = the axis whose plane is the H or V line in sourceAxis.
 *   axial H-line = coronal plane, axial V-line = sagittal plane
 *   coronal H-line = axial plane, coronal V-line = sagittal plane
 *   sagittal H-line = axial plane, sagittal V-line = coronal plane
 */
export const HV_PLANE: Record<Axis, { h: Axis; v: Axis }> = {
  axial:    { h: 'coronal',   v: 'sagittal' },
  coronal:  { h: 'axial',     v: 'sagittal' },
  sagittal: { h: 'axial',     v: 'coronal'  },
};

export const DEFAULT_CAMS: Record<Axis, PlaneCam> = {
  axial:    { normal: [0, 0, 1]  as Vec3, viewUp: [0, -1, 0] as Vec3 },
  coronal:  { normal: [0, 1, 0]  as Vec3, viewUp: [0, 0, -1] as Vec3 },
  sagittal: { normal: [1, 0, 0]  as Vec3, viewUp: [0, 0, -1] as Vec3 },
};

interface Props {
  panelId: string;
  axis: Axis;
  sharedEngine?: cornerstone.RenderingEngine;
  volumeId: string | null;
  studySpacing: Vec3;             // [dz, dy, dx]
  studyOrigin: Vec3;              // [oz, oy, ox]
  studyShape: [number, number, number]; // [nz, ny, nx]
  wl: number;
  ww: number;
  crosshairWorld: Vec3 | null;
  planeCam: PlaneCam;             // this panel's orientation
  hPlaneCam: PlaneCam;            // H-line plane's orientation
  vPlaneCam: PlaneCam;            // V-line plane's orientation
  hSlabMm: number;                // H-plane's slab thickness (mm)
  vSlabMm: number;                // V-plane's slab thickness (mm)
  ownSlabMm: number;              // this panel's own slab thickness (mm)
  activeTool: string;
  label: string;
  panelClass: string;
  onWLWWChange?: (wl: number, ww: number) => void;
  onCrosshairNavigate?: (world: Vec3) => void;
  onSlabChange?: (hv: 'h' | 'v', deltaMm: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LABEL_COLOR: Record<Axis, string> = {
  axial: '#F34A33',
  coronal: '#6EB04B',
  sagittal: '#EDD54C',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const OrthoPanel: React.FC<Props> = ({
  panelId,
  axis,
  sharedEngine,
  volumeId,
  studySpacing,
  studyOrigin,
  studyShape,
  wl,
  ww,
  crosshairWorld,
  planeCam,
  hPlaneCam,
  vPlaneCam,
  hSlabMm,
  vSlabMm,
  ownSlabMm,
  activeTool,
  label,
  panelClass,
  onWLWWChange,
  onCrosshairNavigate,
  onSlabChange,
}) => {
  const containerRef  = useRef<HTMLDivElement>(null);
  const engineRef     = useRef<cornerstone.RenderingEngine | null>(null);
  const suppressVOI   = useRef(false);
  const suppressCam   = useRef(false);
  const crosshairRef  = useRef(crosshairWorld);
  const activeToolRef = useRef(activeTool);
  const planeCamRef   = useRef(planeCam);
  const hPlaneCamRef  = useRef(hPlaneCam);
  const vPlaneCamRef  = useRef(vPlaneCam);
  const hSlabRef      = useRef(hSlabMm);
  const vSlabRef      = useRef(vSlabMm);
  const volumeIdRef   = useRef(volumeId);

  const [ready, setReady] = useState(false);
  const [sliceIndex, setSliceIndex] = useState(0);

  // Keep refs up-to-date with latest props
  useEffect(() => { crosshairRef.current  = crosshairWorld;  }, [crosshairWorld]);
  useEffect(() => { activeToolRef.current = activeTool;      }, [activeTool]);
  useEffect(() => { planeCamRef.current   = planeCam;        }, [planeCam]);
  useEffect(() => { hPlaneCamRef.current  = hPlaneCam;       }, [hPlaneCam]);
  useEffect(() => { vPlaneCamRef.current  = vPlaneCam;       }, [vPlaneCam]);
  useEffect(() => { hSlabRef.current      = hSlabMm;         }, [hSlabMm]);
  useEffect(() => { vSlabRef.current      = vSlabMm;         }, [vSlabMm]);
  useEffect(() => { volumeIdRef.current   = volumeId;        }, [volumeId]);

  // IDs derived from panelId
  const engineId    = `${panelId}-engine`;
  const viewportId  = `${panelId}-viewport`;
  const toolGroupId = `${panelId}-tools`;

  const { h: hColor, v: vColor } = CROSSHAIR_COLORS[axis];

  // ---------------------------------------------------------------------------
  // Imperative SVG refs
  // ---------------------------------------------------------------------------
  const svgRef        = useRef<SVGSVGElement>(null);
  const hLRef         = useRef<SVGLineElement>(null);
  const hRRef         = useRef<SVGLineElement>(null);
  const hSlab1Ref     = useRef<SVGLineElement>(null);
  const hSlab2Ref     = useRef<SVGLineElement>(null);

  const vTRef         = useRef<SVGLineElement>(null);
  const vBRef         = useRef<SVGLineElement>(null);
  const vSlab1Ref     = useRef<SVGLineElement>(null);
  const vSlab2Ref     = useRef<SVGLineElement>(null);

  const dotRef        = useRef<SVGCircleElement>(null);

  // ---------------------------------------------------------------------------
  // Register image loader once
  // ---------------------------------------------------------------------------
  useEffect(() => { registerAcctaImageLoader(); }, []);

  // ---------------------------------------------------------------------------
  // Engine + viewport setup
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    // Use the shared engine if provided; otherwise create a private one.
    const engine = sharedEngine ?? new cornerstone.RenderingEngine(engineId);
    engineRef.current = engine;
    const activeEngineId = engine.id;

    const orientationMap: Record<Axis, cornerstone.Enums.OrientationAxis> = {
      axial:    cornerstone.Enums.OrientationAxis.AXIAL,
      coronal:  cornerstone.Enums.OrientationAxis.CORONAL,
      sagittal: cornerstone.Enums.OrientationAxis.SAGITTAL,
    };

    engine.enableElement({
      viewportId,
      type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
      element: containerRef.current,
      defaultOptions: {
        background: [0.07, 0.07, 0.07] as [number, number, number],
        orientation: orientationMap[axis],
      },
    });

    // Create tool group
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
    tg.addViewport(viewportId, activeEngineId);

    setReady(true);

    return () => {
      ToolGroupManager.destroyToolGroup(toolGroupId);
      // Only destroy the engine if we created it (not a shared one).
      if (!sharedEngine) {
        engine.destroy();
        engineRef.current = null;
      } else {
        try { engine.disableElement(viewportId); } catch { /* ignore */ }
      }
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Volume loading effect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !volumeId || !engineRef.current) return;

    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;

    vp.setVolumes([{ volumeId }])
      .then(() => {
        // Resize after volume is bound so VTK renderers are initialised.
        engineRef.current?.resize(true);

        // Set camera orientation for this panel, then resetCamera to
        // recompute parallelScale for the new viewing direction.
        const cam = vp.getCamera();
        console.log(`[${panelId}] camera after setVolumes:`, JSON.stringify(cam));
        const fp = cam.focalPoint as Vec3;
        const pos = cam.position as Vec3;
        const d = dist3(pos, fp) || 500;
        const n = planeCamRef.current.normal;
        vp.setCamera({
          position: [fp[0] + n[0] * d, fp[1] + n[1] * d, fp[2] + n[2] * d] as Vec3,
          focalPoint: fp,
          viewUp: planeCamRef.current.viewUp,
        });
        vp.resetCamera();
        console.log(`[${panelId}] camera after setCamera+resetCamera:`, JSON.stringify(vp.getCamera()));

        // Navigate to crosshairWorld if available
        const cw = crosshairRef.current;
        if (cw) {
          const cam2 = vp.getCamera();
          const fp2 = cam2.focalPoint as Vec3;
          const pos2 = cam2.position as Vec3;
          const normal = planeCamRef.current.normal;
          const diff: Vec3 = [cw[0] - fp2[0], cw[1] - fp2[1], cw[2] - fp2[2]];
          const projDist = dot(diff, normal);
          const newFP: Vec3 = [fp2[0] + normal[0] * projDist, fp2[1] + normal[1] * projDist, fp2[2] + normal[2] * projDist];
          const newPos: Vec3 = [pos2[0] + normal[0] * projDist, pos2[1] + normal[1] * projDist, pos2[2] + normal[2] * projDist];
          suppressCam.current = true;
          vp.setCamera({ focalPoint: newFP, position: newPos });
          suppressCam.current = false;
        }

        // Apply W/L and slab
        vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } }, volumeId);
        if (ownSlabMm > 0) {
          vp.setProperties({ slabThickness: ownSlabMm }, volumeId);
        }

        vp.render();
        updateSliceIndex(vp);
        updateCrosshair();
      })
      .catch(console.error);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, volumeId]);

  // ---------------------------------------------------------------------------
  // Camera sync effect (planeCam changes due to rotation from parent)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !engineRef.current || !volumeId) return;
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    const cam = vp.getCamera();
    if (!cam.focalPoint || !cam.position) return;
    const fp = cam.focalPoint as Vec3;
    const pos = cam.position as Vec3;
    const d = dist3(pos, fp) || 500;
    const n = planeCam.normal;
    suppressCam.current = true;
    vp.setCamera({
      position: [fp[0] + n[0] * d, fp[1] + n[1] * d, fp[2] + n[2] * d] as Vec3,
      focalPoint: fp,
      viewUp: planeCam.viewUp,
    });
    suppressCam.current = false;
    vp.render();
    updateCrosshair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, planeCam, volumeId]);

  // ---------------------------------------------------------------------------
  // CrosshairWorld navigation effect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !engineRef.current || !crosshairWorld || !volumeId) return;
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    const cam = vp.getCamera();
    if (!cam.focalPoint || !cam.position) return;
    const fp = cam.focalPoint as Vec3;
    const pos = cam.position as Vec3;
    const normal = planeCamRef.current.normal;
    const cw = crosshairWorld;
    const diff: Vec3 = [cw[0] - fp[0], cw[1] - fp[1], cw[2] - fp[2]];
    const projDist = dot(diff, normal);
    const newFP: Vec3 = [fp[0] + normal[0] * projDist, fp[1] + normal[1] * projDist, fp[2] + normal[2] * projDist];
    const newPos: Vec3 = [pos[0] + normal[0] * projDist, pos[1] + normal[1] * projDist, pos[2] + normal[2] * projDist];
    suppressCam.current = true;
    vp.setCamera({ focalPoint: newFP, position: newPos });
    suppressCam.current = false;
    vp.render();
    updateSliceIndex(vp);
    updateCrosshair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, crosshairWorld, volumeId]);

  // ---------------------------------------------------------------------------
  // W/L sync from parent
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !engineRef.current || !volumeId) return;
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    suppressVOI.current = true;
    vp.setProperties({ voiRange: { lower: wl - ww / 2, upper: wl + ww / 2 } }, volumeId);
    vp.render();
    suppressVOI.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, wl, ww, volumeId]);

  // ---------------------------------------------------------------------------
  // Slab thickness sync
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !engineRef.current || !volumeId) return;
    const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    vp.setProperties({ slabThickness: Math.max(0, ownSlabMm) }, volumeId);
    vp.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ownSlabMm, volumeId]);

  // ---------------------------------------------------------------------------
  // W/L broadcast from this panel
  // ---------------------------------------------------------------------------
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, onWLWWChange]);

  // ---------------------------------------------------------------------------
  // CAMERA_MODIFIED listener — report scroll/pan navigation back to parent
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;

    const handle = () => {
      if (suppressCam.current || !engineRef.current) return;
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
      const cam = vp.getCamera();
      if (!cam.focalPoint) return;
      const newFP = cam.focalPoint as Vec3;
      updateSliceIndex(vp);

      // Compute new crosshairWorld: move existing CW along normal to match new focal point
      const cw = crosshairRef.current;
      if (cw && onCrosshairNavigate) {
        const normal = planeCamRef.current.normal;
        // Project newFP onto the plane defined by cw + normal
        // new CW = cw + dot(newFP - cw, normal) * normal
        const diff: Vec3 = [newFP[0] - cw[0], newFP[1] - cw[1], newFP[2] - cw[2]];
        const projDist = dot(diff, normal);
        const newCW: Vec3 = [
          cw[0] + normal[0] * projDist,
          cw[1] + normal[1] * projDist,
          cw[2] + normal[2] * projDist,
        ];
        onCrosshairNavigate(newCW);
      }

      updateCrosshair();
    };

    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, handle as EventListener);
    return () => el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, handle as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, onCrosshairNavigate]);

  // ---------------------------------------------------------------------------
  // Tool switching
  // ---------------------------------------------------------------------------
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
      tg.setToolActive(StackScrollTool.toolName, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
      });
      const name =
        activeTool === 'Pan'  ? PanTool.toolName  :
        activeTool === 'Zoom' ? ZoomTool.toolName  : WindowLevelTool.toolName;
      tg.setToolActive(name, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
      });
    }

    if (containerRef.current) {
      containerRef.current.style.cursor =
        activeTool === 'Scroll' ? 'ns-resize' :
        activeTool === 'Pan'    ? 'grab'      :
        activeTool === 'Zoom'   ? 'zoom-in'   : 'default';
    }

    showCommittedCrosshair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // ---------------------------------------------------------------------------
  // IMAGE_RENDERED — update crosshair after render
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;
    const handle = () => {
      showCommittedCrosshair();
    };
    el.addEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handle as EventListener);
    return () => el.removeEventListener(cornerstone.EVENTS.IMAGE_RENDERED, handle as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---------------------------------------------------------------------------
  // Crosshair SVG helpers (imperative)
  // ---------------------------------------------------------------------------

  /**
   * Compute canvas coords of a world point (returns [x, y] or null).
   */
  const worldToCanvas = useCallback((world: Vec3): [number, number] | null => {
    if (!engineRef.current) return null;
    try {
      const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
      const p = vp.worldToCanvas(world);
      return [p[0], p[1]];
    } catch {
      return null;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const normalize2D = (dx: number, dy: number): [number, number] => {
    const l = Math.sqrt(dx * dx + dy * dy);
    return l < 1e-9 ? [1, 0] : [dx / l, dy / l];
  };

  /**
   * Main crosshair update function — called imperatively.
   */
  const updateCrosshair = useCallback(() => {
    const cw = crosshairRef.current;
    if (!cw || !svgRef.current) { hideCrosshair(); return; }

    const center = worldToCanvas(cw);
    if (!center) { hideCrosshair(); return; }
    const [cx, cy] = center;

    const planeCam  = planeCamRef.current;
    const hPC       = hPlaneCamRef.current;
    const vPC       = vPlaneCamRef.current;
    const hSlab     = hSlabRef.current;
    const vSlab     = vSlabRef.current;

    // H line direction: intersection of this panel's plane with hPlaneCam's plane
    const hDir3D = normalize(cross(planeCam.normal, hPC.normal));
    const hOff: Vec3 = scale(hDir3D, 200);
    const p1H = worldToCanvas(add(cw, hOff));
    const p2H = worldToCanvas(add(cw, scale(hDir3D, -200)));
    const [hdx, hdy] = (p1H && p2H)
      ? normalize2D(p1H[0] - p2H[0], p1H[1] - p2H[1])
      : [1, 0];

    // V line direction
    const vDir3D = normalize(cross(planeCam.normal, vPC.normal));
    const vOff: Vec3 = scale(vDir3D, 200);
    const p1V = worldToCanvas(add(cw, vOff));
    const p2V = worldToCanvas(add(cw, scale(vDir3D, -200)));
    const [vdx, vdy] = (p1V && p2V)
      ? normalize2D(p1V[0] - p2V[0], p1V[1] - p2V[1])
      : [0, 1];

    const g = CROSSHAIR_GAP;
    const a = CROSSHAIR_ARM;

    // H arm lines
    hLRef.current?.setAttribute('x1', `${cx - (g + a) * hdx}`);
    hLRef.current?.setAttribute('y1', `${cy - (g + a) * hdy}`);
    hLRef.current?.setAttribute('x2', `${cx - g * hdx}`);
    hLRef.current?.setAttribute('y2', `${cy - g * hdy}`);

    hRRef.current?.setAttribute('x1', `${cx + g * hdx}`);
    hRRef.current?.setAttribute('y1', `${cy + g * hdy}`);
    hRRef.current?.setAttribute('x2', `${cx + (g + a) * hdx}`);
    hRRef.current?.setAttribute('y2', `${cy + (g + a) * hdy}`);

    // V arm lines
    vTRef.current?.setAttribute('x1', `${cx - (g + a) * vdx}`);
    vTRef.current?.setAttribute('y1', `${cy - (g + a) * vdy}`);
    vTRef.current?.setAttribute('x2', `${cx - g * vdx}`);
    vTRef.current?.setAttribute('y2', `${cy - g * vdy}`);

    vBRef.current?.setAttribute('x1', `${cx + g * vdx}`);
    vBRef.current?.setAttribute('y1', `${cy + g * vdy}`);
    vBRef.current?.setAttribute('x2', `${cx + (g + a) * vdx}`);
    vBRef.current?.setAttribute('y2', `${cy + (g + a) * vdy}`);

    // Rotation handles at arm ends

    // H slab brackets
    if (hSlab > 0) {
      // Compute canvas offset for half the slab thickness in hPlaneCam.normal direction
      const testPt = worldToCanvas(add(cw, scale(hPC.normal, hSlab / 2)));
      if (testPt) {
        const sox = testPt[0] - cx;
        const soy = testPt[1] - cy;
        // Line 1: offset +
        hSlab1Ref.current?.setAttribute('x1', `${cx - (g + a) * hdx + sox}`);
        hSlab1Ref.current?.setAttribute('y1', `${cy - (g + a) * hdy + soy}`);
        hSlab1Ref.current?.setAttribute('x2', `${cx + (g + a) * hdx + sox}`);
        hSlab1Ref.current?.setAttribute('y2', `${cy + (g + a) * hdy + soy}`);
        // Line 2: offset -
        hSlab2Ref.current?.setAttribute('x1', `${cx - (g + a) * hdx - sox}`);
        hSlab2Ref.current?.setAttribute('y1', `${cy - (g + a) * hdy - soy}`);
        hSlab2Ref.current?.setAttribute('x2', `${cx + (g + a) * hdx - sox}`);
        hSlab2Ref.current?.setAttribute('y2', `${cy + (g + a) * hdy - soy}`);
        hSlab1Ref.current?.setAttribute('visibility', 'visible');
        hSlab2Ref.current?.setAttribute('visibility', 'visible');
      }
    } else {
      hSlab1Ref.current?.setAttribute('visibility', 'hidden');
      hSlab2Ref.current?.setAttribute('visibility', 'hidden');
    }

    // V slab brackets
    if (vSlab > 0) {
      const testPt = worldToCanvas(add(cw, scale(vPC.normal, vSlab / 2)));
      if (testPt) {
        const sox = testPt[0] - cx;
        const soy = testPt[1] - cy;
        vSlab1Ref.current?.setAttribute('x1', `${cx - (g + a) * vdx + sox}`);
        vSlab1Ref.current?.setAttribute('y1', `${cy - (g + a) * vdy + soy}`);
        vSlab1Ref.current?.setAttribute('x2', `${cx + (g + a) * vdx + sox}`);
        vSlab1Ref.current?.setAttribute('y2', `${cy + (g + a) * vdy + soy}`);
        vSlab2Ref.current?.setAttribute('x1', `${cx - (g + a) * vdx - sox}`);
        vSlab2Ref.current?.setAttribute('y1', `${cy - (g + a) * vdy - soy}`);
        vSlab2Ref.current?.setAttribute('x2', `${cx + (g + a) * vdx - sox}`);
        vSlab2Ref.current?.setAttribute('y2', `${cy + (g + a) * vdy - soy}`);
        vSlab1Ref.current?.setAttribute('visibility', 'visible');
        vSlab2Ref.current?.setAttribute('visibility', 'visible');
      }
    } else {
      vSlab1Ref.current?.setAttribute('visibility', 'hidden');
      vSlab2Ref.current?.setAttribute('visibility', 'hidden');
    }

    // Center dot
    dotRef.current?.setAttribute('cx', `${cx}`);
    dotRef.current?.setAttribute('cy', `${cy}`);

    svgRef.current.style.visibility = 'visible';
  }, [worldToCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

  const hideCrosshair = useCallback(() => {
    if (svgRef.current) svgRef.current.style.visibility = 'hidden';
  }, []);

  const showCommittedCrosshair = useCallback(() => {
    const cp = crosshairRef.current;
    if (!cp || !engineRef.current) { hideCrosshair(); return; }
    updateCrosshair();
  }, [hideCrosshair, updateCrosshair]);

  // ---------------------------------------------------------------------------
  // Slice index helper
  // ---------------------------------------------------------------------------
  const updateSliceIndex = useCallback((vp: cornerstone.Types.IVolumeViewport) => {
    const cam = vp.getCamera();
    if (!cam.focalPoint) return;
    const fp = cam.focalPoint as Vec3;
    const [dz, dy, dx] = studySpacing;
    const [oz, oy, ox] = studyOrigin;
    const [nz, ny, nx] = studyShape;
    let idx = 0;
    if (axis === 'axial') {
      idx = Math.max(0, Math.min(nz - 1, Math.round((fp[2] - oz) / dz)));
    } else if (axis === 'coronal') {
      idx = Math.max(0, Math.min(ny - 1, Math.round((fp[1] - oy) / dy)));
    } else {
      idx = Math.max(0, Math.min(nx - 1, Math.round((fp[0] - ox) / dx)));
    }
    setSliceIndex(idx);
  }, [axis, studySpacing, studyOrigin, studyShape]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Cross-panel hover events
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Local pointer events: hover tracking + crosshair navigation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const el = containerRef.current;
    let pressed = false;
    let downX = 0;
    let downY = 0;

    const handleMove = (_e: PointerEvent) => { /* reserved for future hover handling */ };

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
          if (engineRef.current) {
            try {
              const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
              const rect = el.getBoundingClientRect();
              const w = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]);
              onCrosshairNavigate([w[0], w[1], w[2]]);
            } catch { /* ignore */ }
          }
        }
      }
      pressed = false;
    };

    const handleLeave = () => { showCommittedCrosshair(); };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, showCommittedCrosshair, onCrosshairNavigate]);

  // ---------------------------------------------------------------------------
  // Slab bracket drag handlers
  // ---------------------------------------------------------------------------
  const makeSlabDragHandler = useCallback((hv: 'h' | 'v') => {
    return (e: React.PointerEvent<SVGLineElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();

      const pc = hv === 'h' ? hPlaneCamRef.current : vPlaneCamRef.current;
      const cw = crosshairRef.current;
      if (!cw || !engineRef.current) return;

      // Compute pxPerMm: distance from worldToCanvas(cw) to worldToCanvas(cw + 1mm * hPlaneCam.normal)
      let pxPerMm = 1;
      try {
        const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
        const p0 = vp.worldToCanvas(cw);
        const p1mm = vp.worldToCanvas(add(cw, pc.normal));
        const dx = p1mm[0] - p0[0];
        const dy = p1mm[1] - p0[1];
        pxPerMm = Math.sqrt(dx * dx + dy * dy) || 1;
      } catch { /* ignore */ }

      // Compute perpendicular to arm direction in canvas space
      // Arm direction = intersection of this plane with the slab plane
      const armDir3D = normalize(cross(planeCamRef.current.normal, pc.normal));
      let [hdx, hdy] = [1, 0];
      try {
        const vp = engineRef.current.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
        const p1 = vp.worldToCanvas(add(cw, scale(armDir3D, 200)));
        const p2 = vp.worldToCanvas(add(cw, scale(armDir3D, -200)));
        const raw = normalize2D(p1[0] - p2[0], p1[1] - p2[1]);
        [hdx, hdy] = raw;
      } catch { /* ignore */ }

      // Perpendicular to arm: (-hdy, hdx)
      const perpX = -hdy;
      const perpY = hdx;

      const onMove = (me: PointerEvent) => {
        const movement = me.movementX * perpX + me.movementY * perpY;
        const deltaMm = movement / pxPerMm;
        onSlabChange?.(hv, deltaMm);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSlabChange]);


  // ---------------------------------------------------------------------------
  // Crosshair update when slab values change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    updateCrosshair();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hSlabMm, vSlabMm, hPlaneCam, vPlaneCam]);

  // ---------------------------------------------------------------------------
  // Compute total slice count for counter display
  // ---------------------------------------------------------------------------
  const sliceCount = axis === 'axial' ? studyShape[0] : axis === 'coronal' ? studyShape[1] : studyShape[2];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div
      className={`panel ${panelClass}`}
      style={{ height: '100%', position: 'relative' }}
    >
      <span className="panel-label" style={{ color: LABEL_COLOR[axis] }}>{label}</span>

      {!volumeId && (
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
        {/* H arm lines */}
        <line ref={hLRef} stroke={hColor} strokeWidth="1.5" opacity="0.9" />
        <line ref={hRRef} stroke={hColor} strokeWidth="1.5" opacity="0.9" />

        {/* H slab brackets */}
        <line ref={hSlab1Ref} stroke={hColor} strokeWidth="1" opacity="0.5" strokeDasharray="4 3" visibility="hidden"
          style={{ pointerEvents: 'stroke', cursor: 'ew-resize' }}
          onPointerDown={makeSlabDragHandler('h')}
        />
        <line ref={hSlab2Ref} stroke={hColor} strokeWidth="1" opacity="0.5" strokeDasharray="4 3" visibility="hidden"
          style={{ pointerEvents: 'stroke', cursor: 'ew-resize' }}
          onPointerDown={makeSlabDragHandler('h')}
        />

        {/* V arm lines */}
        <line ref={vTRef} stroke={vColor} strokeWidth="1.5" opacity="0.9" />
        <line ref={vBRef} stroke={vColor} strokeWidth="1.5" opacity="0.9" />

        {/* V slab brackets */}
        <line ref={vSlab1Ref} stroke={vColor} strokeWidth="1" opacity="0.5" strokeDasharray="4 3" visibility="hidden"
          style={{ pointerEvents: 'stroke', cursor: 'ns-resize' }}
          onPointerDown={makeSlabDragHandler('v')}
        />
        <line ref={vSlab2Ref} stroke={vColor} strokeWidth="1" opacity="0.5" strokeDasharray="4 3" visibility="hidden"
          style={{ pointerEvents: 'stroke', cursor: 'ns-resize' }}
          onPointerDown={makeSlabDragHandler('v')}
        />

        {/* Center dot */}
        <circle ref={dotRef} r="3" fill="white" stroke="rgba(0,0,0,0.4)" strokeWidth="0.5" opacity="0.95" />
      </svg>

      {/* Slice counter */}
      {volumeId && sliceCount > 0 && (
        <span style={{
          position: 'absolute', bottom: 6, right: 6,
          fontSize: 11, color: '#aaa', zIndex: 10, pointerEvents: 'none',
        }}>
          {sliceIndex + 1} / {sliceCount}
        </span>
      )}
    </div>
  );
};

export default OrthoPanel;
