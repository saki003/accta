/**
 * MPRPanel — Three.js MPR viewer for one orthographic plane.
 *
 * Renders a fullscreen quad with a custom GLSL shader that samples a
 * Data3DTexture at the current plane orientation.  Handles:
 *   - W/L drag (left button when WindowLevel tool active)
 *   - Pan      (left button when Pan tool active)
 *   - Zoom     (left button when Zoom tool active / scroll wheel always zooms)
 *   - Slice scroll (mouse wheel)
 *   - Click-to-navigate (sets crosshair world position in parent)
 *   - Crosshair SVG overlay (position driven by parent crosshairWorld)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MPR_VERT, MPR_FRAG } from '../lib/mprShader';
import type { VolumeData } from '../lib/niftiVolume';
import type { VesselAnchor, AnchorType } from '../api/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Axis = 'axial' | 'coronal' | 'sagittal';

export interface PlaneConfig {
  normal: THREE.Vector3;   // plane normal (unit)
  basisU: THREE.Vector3;   // right direction (unit)
  basisV: THREE.Vector3;   // up direction (unit)
}

const PLANE_CONFIGS: Record<Axis, PlaneConfig> = {
  axial:    { normal: new THREE.Vector3(0, 0, 1), basisU: new THREE.Vector3(1, 0, 0), basisV: new THREE.Vector3(0, -1, 0) },
  coronal:  { normal: new THREE.Vector3(0, 1, 0), basisU: new THREE.Vector3(1, 0, 0), basisV: new THREE.Vector3(0, 0, -1) },
  sagittal: { normal: new THREE.Vector3(1, 0, 0), basisU: new THREE.Vector3(0, 1, 0), basisV: new THREE.Vector3(0, 0, -1) },
};

const AXIS_COLOR: Record<Axis, string> = {
  axial:    '#F34A33',
  coronal:  '#6EB04B',
  sagittal: '#EDD54C',
};

// Color of the crosshair arms drawn ON this panel
// H-arm = the other horizontal-axis panel's color, V-arm = vertical-axis panel's color
const CROSSHAIR_ARM_COLOR: Record<Axis, { h: string; v: string }> = {
  axial:    { h: '#6EB04B', v: '#EDD54C' },
  coronal:  { h: '#F34A33', v: '#EDD54C' },
  sagittal: { h: '#F34A33', v: '#6EB04B' },
};

// Color per anchor type
const ANCHOR_COLOR: Record<AnchorType, string> = {
  ostium:   '#4ade80',
  waypoint: '#fbbf24',
  distal:   '#f87171',
};

interface Props {
  axis: Axis;
  volume: VolumeData | null;
  vesselness?: VolumeData | null;
  vesselnessOpacity?: number;
  vesselnessThreshold?: number;
  crosshairWorld: THREE.Vector3 | null;
  showCrosshair?: boolean;
  wl: number;
  ww: number;
  slabMm: number;
  activeTool: string;
  label: string;
  showWLWW?: boolean;
  onWLWWChange?: (wl: number, ww: number) => void;
  onNavigate?: (world: THREE.Vector3) => void;
  // centerline placement
  anchors?: VesselAnchor[];
  pathPoints?: [number, number, number][];
  placementMode?: AnchorType | null;
  onPlaceAnchor?: (world: THREE.Vector3) => void;
  editingActive?: boolean;
  editingAnchorWorld?: [number, number, number] | null;
}

const WL_PRESETS: { label: string; wl: number; ww: number }[] = [
  { label: 'Cardiac',      wl: 300,  ww: 800  },
  { label: 'Soft Tissue',  wl: 40,   ww: 400  },
  { label: 'Lung',         wl: -600, ww: 1500 },
  { label: 'Bone',         wl: 400,  ww: 1800 },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MPRPanel: React.FC<Props> = ({
  axis,
  volume,
  vesselness,
  vesselnessOpacity = 0.6,
  vesselnessThreshold = 0.0,
  crosshairWorld,
  showCrosshair = true,
  wl,
  ww,
  slabMm,
  activeTool,
  label,
  showWLWW = false,
  onWLWWChange,
  onNavigate,
  anchors,
  pathPoints,
  placementMode,
  onPlaceAnchor,
  editingActive = false,
  editingAnchorWorld,
}) => {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const svgRef         = useRef<SVGSVGElement>(null);
  const svgOverlayRef  = useRef<SVGSVGElement>(null);
  const wrapperRef     = useRef<HTMLDivElement>(null);

  const [huDisplay, setHuDisplay] = useState<{ hu: number | null; x: number; y: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  // Magnifying loupe for precise anchor placement: long-press while in
  // placement mode shows a zoomed inset; drag to fine-tune; release to drop.
  const [loupe, setLoupe] = useState<{ x: number; y: number } | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const LOUPE_SIZE = 200;          // overlay size in CSS pixels
  const LOUPE_ZOOM = 5;            // magnification factor
  const LOUPE_LONG_PRESS_MS = 250; // hold duration to engage
  const [showPresets, setShowPresets] = useState(false);

  // Three.js objects kept in refs so effects can access without deps churn
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const materialRef  = useRef<THREE.ShaderMaterial | null>(null);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const cameraRef    = useRef<THREE.Camera | null>(null);

  // Camera state in world-mm
  const centerRef  = useRef<THREE.Vector3>(new THREE.Vector3());
  const fovRef     = useRef(200); // mm half-width shown; changes with zoom

  // Mutable copies for closure access
  const wlRef = useRef(wl);
  const wwRef = useRef(ww);
  const slabRef = useRef(slabMm);
  useEffect(() => { wlRef.current = wl; }, [wl]);
  useEffect(() => { wwRef.current = ww; }, [ww]);
  useEffect(() => { slabRef.current = slabMm; }, [slabMm]);

  const crosshairRef = useRef<THREE.Vector3 | null>(null);
  useEffect(() => { crosshairRef.current = crosshairWorld; }, [crosshairWorld]);

  const showCrosshairRef = useRef(showCrosshair);
  useEffect(() => { showCrosshairRef.current = showCrosshair; }, [showCrosshair]);

  const volumeRef = useRef<VolumeData | null>(null);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  const vesselnessRef = useRef<VolumeData | null>(null);
  useEffect(() => { vesselnessRef.current = vesselness ?? null; }, [vesselness]);
  const vesselnessOpacityRef = useRef(vesselnessOpacity);
  useEffect(() => { vesselnessOpacityRef.current = vesselnessOpacity; }, [vesselnessOpacity]);
  const vesselnessThresholdRef = useRef(vesselnessThreshold);
  useEffect(() => { vesselnessThresholdRef.current = vesselnessThreshold; }, [vesselnessThreshold]);

  const toolRef = useRef(activeTool);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);

  const anchorsRef      = useRef<VesselAnchor[]>([]);
  const pathPointsRef   = useRef<[number, number, number][] | undefined>();
  const placementRef    = useRef<AnchorType | null>(null);
  const onPlaceRef      = useRef<((w: THREE.Vector3) => void) | undefined>();
  // Stable ref so render/drawCrosshair (declared before drawOverlay) can call it safely
  const drawOverlayRef  = useRef<() => void>(() => {});
  useEffect(() => { anchorsRef.current = anchors ?? []; }, [anchors]);
  useEffect(() => { pathPointsRef.current = pathPoints; }, [pathPoints]);
  useEffect(() => { placementRef.current = placementMode ?? null; }, [placementMode]);
  useEffect(() => { onPlaceRef.current = onPlaceAnchor; }, [onPlaceAnchor]);
  const editingActiveRef = useRef(false);
  useEffect(() => { editingActiveRef.current = editingActive; }, [editingActive]);
  const editingAnchorWorldRef = useRef<[number, number, number] | null>(null);
  useEffect(() => { editingAnchorWorldRef.current = editingAnchorWorld ?? null; }, [editingAnchorWorld]);

  const cfg = PLANE_CONFIGS[axis];

  // ---------------------------------------------------------------------------
  // Tool icon SVGs (small, shown bottom-right of cursor)
  // ---------------------------------------------------------------------------
  const TOOL_ICON: Record<string, React.ReactNode> = {
    WindowLevel: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6" fill="none" stroke="white" strokeWidth="1.2"/>
        <path d="M7 1 A6 6 0 0 1 7 13 Z" fill="white"/>
        <line x1="7" y1="1" x2="7" y2="13" stroke="white" strokeWidth="0.8"/>
      </svg>
    ),
    Pan: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="7" cy="7" r="2.5" fill="white"/>
      </svg>
    ),
    Zoom: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="white" strokeWidth="1.2"/>
        <line x1="8.5" y1="8.5" x2="13" y2="13" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="3.5" y1="5.5" x2="7.5" y2="5.5" stroke="white" strokeWidth="1" strokeLinecap="round"/>
        <line x1="5.5" y1="3.5" x2="5.5" y2="7.5" stroke="white" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    ),
    Scroll: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M7 2 L5 5 H9 Z" fill="white"/>
        <path d="M7 12 L5 9 H9 Z" fill="white"/>
        <line x1="7" y1="5" x2="7" y2="9" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
    Crosshairs: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <line x1="7" y1="1" x2="7" y2="5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="7" y1="9" x2="7" y2="13" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="1" y1="7" x2="5" y2="7" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="9" y1="7" x2="13" y2="7" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        <circle cx="7" cy="7" r="1.5" fill="white"/>
      </svg>
    ),
  };

  // ---------------------------------------------------------------------------
  // Helper: render one frame
  // ---------------------------------------------------------------------------
  const render = useCallback(() => {
    const renderer = rendererRef.current;
    const mat = materialRef.current;
    if (!renderer || !mat) return;

    const canvas = canvasRef.current!;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (W === 0 || H === 0) return;

    renderer.setSize(W, H, false);

    const aspect = W / H;
    const fovU = fovRef.current;
    const fovV = fovU / aspect;

    mat.uniforms.uPlaneCenter.value.copy(centerRef.current);
    mat.uniforms.uFovU.value = fovU;
    mat.uniforms.uFovV.value = fovV;
    mat.uniforms.uWL.value   = wlRef.current;
    mat.uniforms.uWW.value   = wwRef.current;
    mat.uniforms.uSlabMm.value = slabRef.current;

    const ves = vesselnessRef.current;
    mat.uniforms.uHasVesselness.value = ves !== null;
    if (ves) {
      mat.uniforms.uVesselness.value = ves.texture;
      mat.uniforms.uVesselnessWorldToTex.value = ves.worldToTex;
      mat.uniforms.uVesselnessMax.value = ves.huMax;
    }
    mat.uniforms.uVesselnessOpacity.value   = vesselnessOpacityRef.current;
    mat.uniforms.uVesselnessThreshold.value = vesselnessThresholdRef.current;

    if (sceneRef.current && cameraRef.current)
      renderer.render(sceneRef.current, cameraRef.current);
    drawOverlayRef.current();
  }, []);

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  /** World mm → canvas pixel [x, y] */
  const worldToCanvas = useCallback((world: THREE.Vector3): [number, number] | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const aspect = W / H;
    const fovU = fovRef.current;
    const fovV = fovU / aspect;
    const center = centerRef.current;
    const delta = world.clone().sub(center);
    const u = delta.dot(cfg.basisU);
    const v = delta.dot(cfg.basisV);
    const x = (u / fovU + 1) * 0.5 * W;
    const y = (1 - (v / fovV + 1) * 0.5) * H;
    return [x, y];
  }, [cfg]);

  /** Canvas pixel → world mm on the current plane */
  const canvasToWorld = useCallback((cx: number, cy: number): THREE.Vector3 => {
    const canvas = canvasRef.current!;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const aspect = W / H;
    const fovU = fovRef.current;
    const fovV = fovU / aspect;
    const u = (cx / W * 2 - 1) * fovU;
    const v = (1 - cy / H * 2) * fovV;
    return centerRef.current.clone()
      .addScaledVector(cfg.basisU, u)
      .addScaledVector(cfg.basisV, v);
  }, [cfg]);

  /** Sample HU value at a canvas-local coordinate from the loaded volume.
   *  Returns null if the point lies outside the volume bounds. */
  const sampleHUAtCanvas = useCallback((cx: number, cy: number): number | null => {
    const vol = volumeRef.current;
    if (!vol) return null;
    const world = canvasToWorld(cx, cy);
    const t = world.clone().applyMatrix4(vol.worldToTex);
    if (t.x < 0 || t.x > 1 || t.y < 0 || t.y > 1 || t.z < 0 || t.z > 1) return null;
    const [nz, ny, nx] = vol.shape;
    const ix = Math.round(t.x * (nx - 1));
    const iy = Math.round(t.y * (ny - 1));
    const iz = Math.round(t.z * (nz - 1));
    return vol.data[iz * ny * nx + iy * nx + ix] ?? null;
  }, [canvasToWorld]);

  // ---------------------------------------------------------------------------
  // Draw crosshair SVG
  // ---------------------------------------------------------------------------
  const drawCrosshair = useCallback(() => {
    const svg = svgRef.current;
    const canvas = canvasRef.current;
    if (!svg || !canvas) return;
    if (!showCrosshairRef.current) { svg.style.visibility = 'hidden'; return; }
    const cw = crosshairRef.current;
    if (!cw) { svg.style.visibility = 'hidden'; return; }

    const pos = worldToCanvas(cw);
    if (!pos) { svg.style.visibility = 'hidden'; return; }
    const [cx, cy] = pos;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;

    svg.style.visibility = 'visible';
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const GAP = 12;
    const ARM = 60; // px from center to end of each arm
    const colors = CROSSHAIR_ARM_COLOR[axis];

    svg.innerHTML = `
      <line x1="${cx}" y1="${Math.max(0, cy - ARM)}" x2="${cx}" y2="${cy - GAP}" stroke="${colors.v}" stroke-width="1"/>
      <line x1="${cx}" y1="${cy + GAP}" x2="${cx}" y2="${Math.min(H, cy + ARM)}" stroke="${colors.v}" stroke-width="1"/>
      <line x1="${Math.max(0, cx - ARM)}" y1="${cy}" x2="${cx - GAP}" y2="${cy}" stroke="${colors.h}" stroke-width="1"/>
      <line x1="${cx + GAP}" y1="${cy}" x2="${Math.min(W, cx + ARM)}" y2="${cy}" stroke="${colors.h}" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="2" fill="#ff3333"/>
    `;
    drawOverlayRef.current();
  }, [axis, worldToCanvas]);

  // ---------------------------------------------------------------------------
  // Anchor / path SVG overlay
  // ---------------------------------------------------------------------------
  const drawOverlay = useCallback(() => {
    const svg = svgOverlayRef.current;
    const canvas = canvasRef.current;
    if (!svg || !canvas) return;

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const ancs      = anchorsRef.current;
    const pathPts   = pathPointsRef.current;
    const normal    = cfg.normal;
    const planeD    = centerRef.current.dot(normal);
    const slabHalf  = Math.max(slabRef.current / 2, 3); // 3 mm min so single-slice shows

    let html = '';

    // Path polyline — project all points (full 2-D projection, no slab clipping)
    if (pathPts && pathPts.length >= 2) {
      const pts: string[] = [];
      for (const [wx, wy, wz] of pathPts) {
        const pos = worldToCanvas(new THREE.Vector3(wx, wy, wz));
        if (pos) pts.push(`${pos[0].toFixed(1)},${pos[1].toFixed(1)}`);
      }
      if (pts.length >= 2) {
        html += `<polyline points="${pts.join(' ')}" fill="none" stroke="#60a5fa" stroke-width="1.5" opacity="0.75"/>`;
      }
    }

    // Anchor dots
    const editW = editingAnchorWorldRef.current;
    for (const a of ancs) {
      const world = new THREE.Vector3(a.world[0], a.world[1], a.world[2]);
      const pos = worldToCanvas(world);
      if (!pos) continue;
      const [cx, cy] = pos;
      const dist     = Math.abs(world.dot(normal) - planeD);
      const inSlab   = dist <= slabHalf;
      const color    = ANCHOR_COLOR[a.type];
      const isEditing = editW !== null
        && Math.abs(a.world[0] - editW[0]) < 0.5
        && Math.abs(a.world[1] - editW[1]) < 0.5
        && Math.abs(a.world[2] - editW[2]) < 0.5;
      if (isEditing) {
        // Pulsing cyan halo + filled cyan dot — clearly distinct from other anchors
        html += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="14" fill="none" stroke="#00E5FF" stroke-width="1.5" opacity="0.6">
          <animate attributeName="r" values="10;18;10" dur="1.4s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1.4s" repeatCount="indefinite"/>
        </circle>`;
        html += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="#00E5FF" stroke="#0a3d4a" stroke-width="1.5"/>`;
      } else if (inSlab) {
        html += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}" fill-opacity="0.85" stroke="rgba(0,0,0,0.55)" stroke-width="1.2"/>`;
      } else {
        const op = Math.max(0.15, 1 - dist / 30).toFixed(2);
        html += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="none" stroke="${color}" stroke-width="1.5" opacity="${op}"/>`;
      }
    }

    svg.innerHTML = html;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, worldToCanvas]);

  // Keep the stable ref current so render/drawCrosshair can call the latest closure
  drawOverlayRef.current = drawOverlay;
  // Redraw overlay whenever anchors or path change
  useEffect(() => { drawOverlay(); }, [anchors, pathPoints, drawOverlay]);

  // ---------------------------------------------------------------------------
  // Three.js setup
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    sceneRef.current = scene;
    cameraRef.current = camera;

    const mat = new THREE.ShaderMaterial({
      vertexShader:   MPR_VERT,
      fragmentShader: MPR_FRAG,
      uniforms: {
        uVolume:      { value: null },
        uWorldToTex:  { value: new THREE.Matrix4() },
        uPlaneCenter: { value: new THREE.Vector3() },
        uBasisU:      { value: cfg.basisU.clone() },
        uBasisV:      { value: cfg.basisV.clone() },
        uPlaneNormal: { value: cfg.normal.clone() },
        uFovU:        { value: 200 },
        uFovV:        { value: 200 },
        uWL:          { value: wl },
        uWW:          { value: ww },
        uSlabMm:      { value: 0 },
        // vesselness overlay
        uVesselness:            { value: null },
        uVesselnessWorldToTex:  { value: new THREE.Matrix4() },
        uHasVesselness:         { value: false },
        uVesselnessOpacity:     { value: 0.6 },
        uVesselnessMax:         { value: 1.0 },
        uVesselnessThreshold:   { value: 0.0 },
      },
    });
    materialRef.current = mat;

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    scene.add(mesh);

    const ro = new ResizeObserver(() => { render(); drawCrosshair(); drawOverlay(); });
    ro.observe(canvas.parentElement!);

    return () => {
      ro.disconnect();
      renderer.dispose();
      rendererRef.current = null;
      materialRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Volume change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const mat = materialRef.current;
    if (!mat) return;
    if (!volume) { mat.uniforms.uVolume.value = null; return; }

    mat.uniforms.uVolume.value     = volume.texture;
    mat.uniforms.uWorldToTex.value = volume.worldToTex;

    // Set initial center to middle of volume in world space
    const [nz, ny, nx] = volume.shape;
    const [dz, dy, dx] = volume.spacing;
    const [ox, oy, oz] = volume.origin;
    const centerWorld = new THREE.Vector3(
      ox + (nx / 2) * dx,
      oy + (ny / 2) * dy,
      oz + (nz / 2) * dz,
    );
    centerRef.current.copy(centerWorld);

    // Set FOV to fit the volume
    const spanU = axis === 'axial'    ? nx * dx :
                  axis === 'coronal'  ? nx * dx : ny * dy;
    fovRef.current = spanU * 0.55;

    render();
    drawCrosshair();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  // ---------------------------------------------------------------------------
  // Crosshair world navigation — move slice plane to match
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!crosshairWorld || !volume) return;
    // Keep center's in-plane component, update along-normal component
    const normal = cfg.normal;
    const proj = crosshairWorld.dot(normal);
    const cur  = centerRef.current.dot(normal);
    if (Math.abs(proj - cur) > 0.01) {
      centerRef.current.addScaledVector(normal, proj - cur);
      render();
    }
    drawCrosshair();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crosshairWorld]);

  // ---------------------------------------------------------------------------
  // WL/WW / slab / vesselness changes
  // ---------------------------------------------------------------------------
  useEffect(() => { render(); }, [wl, ww, slabMm, render]);
  useEffect(() => { render(); }, [vesselness, vesselnessOpacity, vesselnessThreshold, render]);
  useEffect(() => { drawCrosshair(); }, [showCrosshair, drawCrosshair]);
  useEffect(() => { drawCrosshair(); }, [editingAnchorWorld, drawCrosshair]);

  // Loupe: paint the magnified inset whenever the loupe position changes.
  useEffect(() => {
    if (!loupe) return;
    const main = canvasRef.current;
    const overlay = loupeCanvasRef.current;
    if (!main || !overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const srcSize = LOUPE_SIZE / LOUPE_ZOOM;
    const sx = (loupe.x - srcSize / 2) * dpr;
    const sy = (loupe.y - srcSize / 2) * dpr;
    const sw = srcSize * dpr;
    const sh = srcSize * dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    try {
      ctx.drawImage(main, sx, sy, sw, sh, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    } catch { /* fall back to plain reticle if buffer copy fails */ }
    // Cyan crosshair + center dot
    ctx.strokeStyle = '#00E5FF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_SIZE / 2, 0); ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    ctx.moveTo(0, LOUPE_SIZE / 2); ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    ctx.stroke();
    ctx.fillStyle = '#00E5FF';
    ctx.beginPath();
    ctx.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, 4, 0, Math.PI * 2);
    ctx.fill();
    // HU readout at the bottom of the loupe
    const hu = sampleHUAtCanvas(loupe.x, loupe.y);
    const label = hu !== null ? `${Math.round(hu)} HU` : '--- HU';
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    const padX = 8;
    const tw = ctx.measureText(label).width + padX * 2;
    const th = 18;
    const tx = (LOUPE_SIZE - tw) / 2;
    const ty = LOUPE_SIZE - th - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = '#00E5FF';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tx + padX, ty + th / 2 + 1);
  }, [loupe, sampleHUAtCanvas]);

  // ---------------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let pressed = false;
    let lastX = 0, lastY = 0;
    let startX = 0, startY = 0;
    let dragged = false;

    const sampleHU = (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      const vol = volumeRef.current;
      if (!canvas || !vol) return null;
      const rect = canvas.getBoundingClientRect();
      const world = canvasToWorld(clientX - rect.left, clientY - rect.top);
      const texCoord = world.clone().applyMatrix4(vol.worldToTex);
      if (texCoord.x < 0 || texCoord.x > 1 || texCoord.y < 0 || texCoord.y > 1 || texCoord.z < 0 || texCoord.z > 1)
        return null;
      const [nz, ny, nx] = vol.shape;
      const ix = Math.round(texCoord.x * (nx - 1));
      const iy = Math.round(texCoord.y * (ny - 1));
      const iz = Math.round(texCoord.z * (nz - 1));
      return vol.data[iz * ny * nx + iy * nx + ix] ?? null;
    };

    const showHU = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const raw = sampleHU(clientX, clientY);
      setHuDisplay({
        hu: raw !== null ? Math.round(raw) : null,
        x: clientX - rect.left,
        y: clientY - rect.top,
      });
    };

    const navigate = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (canvas && onNavigate) {
        const rect = canvas.getBoundingClientRect();
        onNavigate(canvasToWorld(clientX - rect.left, clientY - rect.top));
      }
    };

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let loupeTimer: ReturnType<typeof setTimeout> | null = null;
    let loupeActive = false;

    const onDown = (e: PointerEvent) => {
      pressed = true;
      dragged = false;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;

      if (toolRef.current === 'Crosshairs') {
        showHU(e.clientX, e.clientY);
      } else {
        longPressTimer = setTimeout(() => {
          if (!dragged) showHU(e.clientX, e.clientY);
        }, 500);
      }

      // Loupe: long-press while in placement mode → magnified reticle.
      // Edit mode (move existing anchor) skips the long-press and engages
      // immediately so the user can see exactly where the anchor will land.
      if ((placementRef.current || editingActiveRef.current) && onPlaceRef.current) {
        const engageLoupe = () => {
          if (dragged || !pressed) return;
          loupeActive = true;
          const canvas = canvasRef.current;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            setLoupe({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          }
        };
        if (editingActiveRef.current) {
          engageLoupe();
        } else {
          loupeTimer = setTimeout(engageLoupe, LOUPE_LONG_PRESS_MS);
        }
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pressed) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      // Loupe is active: drag-to-fine-tune.  Skip all other tool handling.
      if (loupeActive) {
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          setLoupe({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
        return;
      }

      const totalDx = e.clientX - startX;
      const totalDy = e.clientY - startY;
      const tool = toolRef.current;

      if (tool === 'Crosshairs') {
        // Show HU at cursor continuously while button is pressed
        showHU(e.clientX, e.clientY);
        return;
      }

      // For all other tools: any movement cancels the long-press HU + loupe arming
      if (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4) {
        dragged = true;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (loupeTimer) { clearTimeout(loupeTimer); loupeTimer = null; }
        setHuDisplay(null);
      }

      if (tool === 'WindowLevel') {
        const newWW = Math.max(1, wwRef.current + dx * 4);
        const newWL = wlRef.current - dy * 2;
        onWLWWChange?.(newWL, newWW);

      } else if (tool === 'Pan') {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const W = canvas.clientWidth;
        const fovU = fovRef.current;
        const scale = (fovU * 2) / W;
        centerRef.current
          .addScaledVector(cfg.basisU, -dx * scale)
          .addScaledVector(cfg.basisV,  dy * scale);
        render();
        drawCrosshair();

      } else if (tool === 'Zoom') {
        fovRef.current = Math.max(10, fovRef.current * (1 + dy * 0.005));
        render();
        drawCrosshair();

      } else if (tool === 'Scroll') {
        const vol = volumeRef.current;
        if (!vol) return;
        const [dz, dyVol, dxVol] = vol.spacing;
        const voxelSize = axis === 'axial' ? dz : axis === 'coronal' ? dyVol : dxVol;
        centerRef.current.addScaledVector(cfg.normal, -dy * voxelSize * 0.5);
        render();

      }
    };

    const onUp = (_e: PointerEvent) => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (loupeTimer)     { clearTimeout(loupeTimer);     loupeTimer = null;     }
      setHuDisplay(null);
      const canvas = canvasRef.current;
      const placeAllowed = placementRef.current || editingActiveRef.current;
      if (loupeActive && canvas && placeAllowed && onPlaceRef.current) {
        // Loupe: drop at the final cursor position (where the user released).
        const rect = canvas.getBoundingClientRect();
        onPlaceRef.current(canvasToWorld(lastX - rect.left, lastY - rect.top));
      } else if (pressed && !dragged && placeAllowed && onPlaceRef.current && canvas) {
        // Plain click placement / edit-commit.
        const rect = canvas.getBoundingClientRect();
        onPlaceRef.current(canvasToWorld(startX - rect.left, startY - rect.top));
      }
      loupeActive = false;
      setLoupe(null);
      pressed = false;
    };

    let lastMouseY = 0;
    const onMouseMove = (e: MouseEvent) => {
      // Shift: move crosshair to cursor without clicking
      if (e.shiftKey) {
        navigate(e.clientX, e.clientY);
      }

      if (!e.metaKey) {
        lastMouseY = e.clientY;
        // Don't clear HU while button is pressed (Crosshairs drag)
        if (!e.shiftKey && !pressed) setHuDisplay(null);
        return;
      }
      // Cmd held: scroll slices and show HU
      const dy = e.clientY - lastMouseY;
      lastMouseY = e.clientY;
      if (dy !== 0) {
        const vol = volumeRef.current;
        if (vol) {
          const [dz, dyVol, dxVol] = vol.spacing;
          const voxelSize = axis === 'axial' ? dz : axis === 'coronal' ? dyVol : dxVol;
          centerRef.current.addScaledVector(cfg.normal, -dy * voxelSize * 0.5);
          render();
        }
      }
      showHU(e.clientX, e.clientY);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? 1 : -1;
      const vol = volumeRef.current;
      if (!vol) return;
      const [dz, dy, dx] = vol.spacing;
      const voxelSize = axis === 'axial' ? dz : axis === 'coronal' ? dy : dx;
      const delta = step * voxelSize;
      centerRef.current.addScaledVector(cfg.normal, delta);
      render();
    };

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove as EventListener);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove as EventListener);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('wheel', onWheel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasToWorld, drawCrosshair, render]);

  // ---------------------------------------------------------------------------
  // Redraw crosshair whenever parent pushes new world position
  // ---------------------------------------------------------------------------
  useEffect(() => { drawCrosshair(); }, [crosshairWorld, drawCrosshair]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const color = AXIS_COLOR[axis];

  return (
    <div
      ref={wrapperRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#000', cursor: placementMode ? 'crosshair' : undefined }}
      onMouseEnter={e => setCursorPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
      onMouseMove={e => setCursorPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })}
      onMouseLeave={() => setCursorPos(null)}
      onClick={e => { if (showPresets && !(e.target as HTMLElement).closest('.wlww-preset-menu')) setShowPresets(false); }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      <svg
        ref={svgRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', visibility: 'hidden' }}
      />
      <svg
        ref={svgOverlayRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
      />
      <div style={{
        position: 'absolute', top: 4, left: 6,
        color, fontSize: 11, fontWeight: 600,
        fontFamily: 'monospace', pointerEvents: 'none',
        textShadow: '0 0 3px #000',
      }}>
        {label}
      </div>
      {showWLWW && (
        <div style={{ position: 'absolute', bottom: 6, left: 6 }}>
          {showPresets && (
            <div className="wlww-preset-menu" style={{
              position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
              background: '#1e1e1e', border: '1px solid #555', borderRadius: 5,
              overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
              minWidth: 120,
            }}>
              {WL_PRESETS.map(p => (
                <div
                  key={p.label}
                  onClick={() => { onWLWWChange?.(p.wl, p.ww); setShowPresets(false); }}
                  style={{
                    padding: '5px 10px', fontSize: 11, color: '#ddd',
                    cursor: 'pointer', fontFamily: 'monospace',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#2e2e2e')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {p.label}
                  <span style={{ color: '#888', marginLeft: 6 }}>
                    {p.wl}/{p.ww}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div
            onClick={() => setShowPresets(v => !v)}
            style={{
              color: '#bbb', fontSize: 11,
              fontFamily: 'monospace',
              textShadow: '0 0 3px #000',
              cursor: 'pointer',
              userSelect: 'none',
              padding: '2px 4px',
              borderRadius: 3,
              background: showPresets ? 'rgba(255,255,255,0.08)' : 'transparent',
            }}
            title="Click to select a window preset"
          >
            WL {Math.round(wl)} / WW {Math.round(ww)}
          </div>
        </div>
      )}
      {cursorPos && TOOL_ICON[activeTool] && (
        <div style={{
          position: 'absolute',
          left: cursorPos.x + 12,
          top: cursorPos.y + 12,
          pointerEvents: 'none',
          opacity: 0.85,
          filter: 'drop-shadow(0 0 2px #000)',
        }}>
          {TOOL_ICON[activeTool]}
        </div>
      )}
      {huDisplay && (
        <div style={{
          position: 'absolute',
          left: huDisplay.x + 12,
          top: huDisplay.y - 8,
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          fontSize: 12,
          fontFamily: 'monospace',
          padding: '2px 6px',
          borderRadius: 3,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {huDisplay.hu !== null ? `${huDisplay.hu} HU` : '--- HU'}
        </div>
      )}
      {loupe && (() => {
        // Position the loupe near the cursor but keep it on-screen.
        const offset = 20;
        const canvas = canvasRef.current;
        const W = canvas?.clientWidth ?? 0;
        let left = loupe.x + offset;
        let top  = loupe.y - LOUPE_SIZE - offset;
        if (left + LOUPE_SIZE > W) left = loupe.x - LOUPE_SIZE - offset;
        if (top < 0)                top = loupe.y + offset;
        return (
          <canvas
            ref={loupeCanvasRef}
            width={LOUPE_SIZE}
            height={LOUPE_SIZE}
            style={{
              position: 'absolute', left, top,
              width: LOUPE_SIZE, height: LOUPE_SIZE,
              border: '1px solid #00E5FF',
              borderRadius: '50%',
              boxShadow: '0 0 12px rgba(0,229,255,0.4)',
              pointerEvents: 'none',
              background: '#000',
            }}
          />
        );
      })()}
    </div>
  );
};

export default MPRPanel;
