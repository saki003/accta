/**
 * MiniGame — heart-disease-themed infinite runner.
 *
 *   - Heart sprite jumps over ground obstacles (plaque, thrombus) and ducks
 *     under flying ones (pulmonary embolus, virus).
 *   - Space / ArrowUp / Click  → jump (double-jump available mid-air).
 *   - ArrowDown / S held       → duck (lowers hitbox, lets you slip under fliers).
 *   - Speed and obstacle variety ramp up with level (every 1000 score).
 *   - High score persists in localStorage.
 */

import React, { useEffect, useRef, useState } from 'react';

const HIGHSCORE_KEY = 'accta-minigame-highscore';
const W = 720;
const H = 200;
const GROUND_Y = 160;

// Snappy jump physics — short hang time, quick fall
const GRAVITY = 1.05;
const JUMP_V = -15;
const DOUBLE_JUMP_V = -13;

const HEART_W = 26;
const HEART_H = 26;
const HEART_X = 70;            // fixed x; world scrolls
const DUCK_H = 14;              // squashed height while ducking

type Difficulty = 'easy' | 'medium' | 'hard';
interface DifficultyConfig {
  startSpeed: number;
  perLevel: number;     // speed gain per level
  maxSpeed: number;
  minGap: number;       // base spawn-gap floor at level 1
  levelEvery: number;   // distance per level
}
const DIFFICULTY: Record<Difficulty, DifficultyConfig> = {
  easy:   { startSpeed: 5, perLevel: 0.6, maxSpeed: 11, minGap: 380, levelEvery: 12000 },
  medium: { startSpeed: 6.5, perLevel: 0.8, maxSpeed: 14, minGap: 300, levelEvery: 10000 },
  hard:   { startSpeed: 8,   perLevel: 1.0, maxSpeed: 16, minGap: 220, levelEvery: 8000  },
};

type Kind = 'plaque' | 'thrombus' | 'embolus' | 'virus';
interface Obstacle {
  kind: Kind;
  x: number;
  y: number;       // top-left y
  w: number;       // base width
  h: number;       // base height
  phase: number;   // for animation
  pulses: boolean; // when true, w/h scale with sin(phase) at higher levels
}

// Visual scenes the world cycles through.  Each level switches the scene so
// the backdrop, palette, and ambient pattern keep things fresh.
interface Scene {
  bg: string;
  ground: string;
  accent: string;     // for ground decorations / parallax pattern
  pattern: 'plain' | 'ekg' | 'pulse-bars' | 'vessels' | 'particles';
  label: string;
}
const SCENES: Scene[] = [
  { bg: '#0d0d0d', ground: '#2a2a2a', accent: '#1a1a1a', pattern: 'plain',       label: 'CT Suite' },
  { bg: '#0a1410', ground: '#1c4231', accent: '#10261b', pattern: 'ekg',         label: 'ECG Lab' },
  { bg: '#101015', ground: '#27272a', accent: '#1a1a25', pattern: 'pulse-bars',  label: 'Cath Lab' },
  { bg: '#150d0d', ground: '#3a1f1f', accent: '#221414', pattern: 'particles',   label: 'ICU' },
  { bg: '#0e1218', ground: '#1e2a35', accent: '#162028', pattern: 'vessels',     label: 'Angio Suite' },
];

const OBSTACLE_COLOR: Record<Kind, string> = {
  plaque:   '#fbbf24',    // amber — calcium
  thrombus: '#ef4444',    // red   — clot
  embolus:  '#f87171',    // pink  — flying clot
  virus:    '#a855f7',    // purple — myocarditis
};

const OBSTACLE_LABEL: Record<Kind, string> = {
  plaque:   'plaque',
  thrombus: 'thrombus',
  embolus:  'embolus',
  virus:    'virus',
};

interface Props { onClose: () => void; }

const MiniGame: React.FC<Props> = ({ onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState({ score: 0, level: 1, gameOver: false });
  const [highScore, setHighScore] = useState(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(HIGHSCORE_KEY) : null;
    return raw ? parseInt(raw, 10) || 0 : 0;
  });
  const [difficulty, setDifficulty] = useState<Difficulty>('hard');
  const [started, setStarted] = useState(false);
  const difficultyRef = useRef<Difficulty>('hard');
  const startedRef = useRef(false);
  useEffect(() => { difficultyRef.current = difficulty; }, [difficulty]);
  useEffect(() => { startedRef.current = started; }, [started]);

  // Mutable game state lives in refs (no re-renders per frame)
  const heartXRef    = useRef(HEART_X);
  const heartYRef    = useRef(GROUND_Y - HEART_H);
  const heartVRef    = useRef(0);
  const duckingRef   = useRef(false);
  const jumpsLeftRef = useRef(2);
  const onGroundRef  = useRef(true);
  const speedRef     = useRef(8);
  const distanceRef  = useRef(0);
  const obstaclesRef = useRef<Obstacle[]>([]);
  const lastSpawnRef = useRef(0);
  const gameOverRef  = useRef(false);
  const levelRef     = useRef(1);
  const lastLevelMsgRef = useRef({ level: 0, until: 0 });

  // ── Fly cheat: typing "fly" grants 10 s of free movement, no collisions ──
  const FLY_DURATION_MS = 10_000;
  const FLY_SPEED = 5;
  const flyUntilRef = useRef(0);
  const typedBufRef = useRef('');
  const keyHeldRef  = useRef({ up: false, down: false, left: false, right: false });

  const reset = () => {
    const cfg = DIFFICULTY[difficultyRef.current];
    heartXRef.current = HEART_X;
    heartYRef.current = GROUND_Y - HEART_H;
    heartVRef.current = 0;
    duckingRef.current = false;
    jumpsLeftRef.current = 2;
    onGroundRef.current = true;
    speedRef.current = cfg.startSpeed;
    distanceRef.current = 0;
    obstaclesRef.current = [];
    lastSpawnRef.current = 0;
    gameOverRef.current = false;
    levelRef.current = 1;
    lastLevelMsgRef.current = { level: 0, until: 0 };
    flyUntilRef.current = 0;
    typedBufRef.current = '';
    keyHeldRef.current = { up: false, down: false, left: false, right: false };
    setHud({ score: 0, level: 1, gameOver: false });
  };

  const tryJump = () => {
    if (!startedRef.current) {
      // Pre-start screen — Space begins the run with the selected difficulty.
      reset();
      setStarted(true);
      return;
    }
    if (gameOverRef.current) {
      // Game-over screen — Space restarts with current difficulty.
      reset();
      return;
    }
    if (duckingRef.current) return;       // can't jump while ducking
    if (jumpsLeftRef.current <= 0) return;
    heartVRef.current = onGroundRef.current ? JUMP_V : DOUBLE_JUMP_V;
    onGroundRef.current = false;
    jumpsLeftRef.current -= 1;
  };

  const spawnObstacle = () => {
    const lvl = levelRef.current;
    // Pool of obstacle types unlocking with level
    const pool: Kind[] = ['plaque'];
    if (lvl >= 2) pool.push('plaque', 'thrombus');     // bias toward common
    if (lvl >= 3) pool.push('embolus');
    if (lvl >= 4) pool.push('virus');
    const kind = pool[Math.floor(Math.random() * pool.length)];

    // Pulsing plaques unlock at level 3+: they grow/shrink as they approach,
    // forcing the player to time the jump for when the plaque is at its smallest.
    const canPulse = lvl >= 3 && Math.random() < 0.45;

    if (kind === 'plaque') {
      const w = 14 + Math.floor(Math.random() * 14);
      const h = 18 + Math.floor(Math.random() * 18);
      obstaclesRef.current.push({
        kind, x: W, y: GROUND_Y - h, w, h,
        phase: Math.random() * Math.PI * 2, pulses: canPulse,
      });
    } else if (kind === 'thrombus') {
      const r = 18 + Math.floor(Math.random() * 8);
      obstaclesRef.current.push({
        kind, x: W, y: GROUND_Y - r * 2, w: r * 2, h: r * 2,
        phase: Math.random() * Math.PI * 2, pulses: false,
      });
    } else if (kind === 'embolus') {
      // Flies at upper-jump height — must duck
      const yTop = GROUND_Y - 70 - Math.floor(Math.random() * 10);
      obstaclesRef.current.push({
        kind, x: W, y: yTop, w: 24, h: 16,
        phase: Math.random() * Math.PI * 2, pulses: false,
      });
    } else if (kind === 'virus') {
      const yTop = GROUND_Y - 32;
      obstaclesRef.current.push({
        kind, x: W, y: yTop, w: 22, h: 22,
        phase: Math.random() * Math.PI * 2, pulses: false,
      });
    }
  };

  // Resolve an obstacle's *current* w/h and y, factoring in pulse animation.
  const liveSize = (o: Obstacle): { x: number; y: number; w: number; h: number } => {
    if (!o.pulses) return { x: o.x, y: o.y, w: o.w, h: o.h };
    const s = 1 + 0.35 * Math.sin(o.phase);     // 0.65× to 1.35×
    const w = o.w * s;
    const h = o.h * s;
    // Anchor to ground for plaques (only pulsing kind currently)
    return { x: o.x + (o.w - w) / 2, y: GROUND_Y - h, w, h };
  };

  // Keyboard
  useEffect(() => {
    const isFlying = () => performance.now() < flyUntilRef.current;
    const down = (e: KeyboardEvent) => {
      // 1/2/3 select difficulty — only when not actively playing
      if ((e.key === '1' || e.key === '2' || e.key === '3')
          && (!startedRef.current || gameOverRef.current)) {
        e.preventDefault();
        const next: Difficulty = e.key === '1' ? 'easy' : e.key === '2' ? 'medium' : 'hard';
        setDifficulty(next);
        return;
      }

      // Typed-buffer cheat detection: type "fly" mid-game for 10 s of free flight
      if (e.key.length === 1 && /^[a-z]$/i.test(e.key)) {
        typedBufRef.current = (typedBufRef.current + e.key.toLowerCase()).slice(-4);
        if (typedBufRef.current.endsWith('fly')
            && startedRef.current && !gameOverRef.current
            && !isFlying()) {
          flyUntilRef.current = performance.now() + FLY_DURATION_MS;
          typedBufRef.current = '';
          duckingRef.current = false;
          return;
        }
      }

      if (e.key === ' ') { e.preventDefault(); tryJump(); }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        keyHeldRef.current.up = true;
        if (!isFlying()) tryJump();
      }
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        keyHeldRef.current.down = true;
        if (!isFlying() && !gameOverRef.current && startedRef.current) duckingRef.current = true;
      }
      else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        keyHeldRef.current.left = true;
      }
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        keyHeldRef.current.right = true;
      }
      else if (e.key === 'Escape') { onClose(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp')                                     keyHeldRef.current.up    = false;
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { keyHeldRef.current.down = false; duckingRef.current = false; }
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyHeldRef.current.left  = false;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyHeldRef.current.right = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [onClose]);

  // Game loop
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) { raf = requestAnimationFrame(tick); return; }

      if (startedRef.current && !gameOverRef.current) {
        const flying = performance.now() < flyUntilRef.current;
        // ── Physics ──────────────────────────────────────────────────
        if (flying) {
          // Free movement, no gravity, no collision
          duckingRef.current = false;
          if (keyHeldRef.current.up)    heartYRef.current -= FLY_SPEED;
          if (keyHeldRef.current.down)  heartYRef.current += FLY_SPEED;
          if (keyHeldRef.current.left)  heartXRef.current -= FLY_SPEED;
          if (keyHeldRef.current.right) heartXRef.current += FLY_SPEED;
          // Clamp inside canvas
          heartXRef.current = Math.max(0, Math.min(W - HEART_W, heartXRef.current));
          heartYRef.current = Math.max(0, Math.min(GROUND_Y - HEART_H, heartYRef.current));
          heartVRef.current = 0;
          onGroundRef.current = false;
        } else {
          heartVRef.current += GRAVITY;
          heartYRef.current += heartVRef.current;
          // Drift heart x back toward HEART_X if user flew off-axis
          if (heartXRef.current !== HEART_X) {
            heartXRef.current += (HEART_X - heartXRef.current) * 0.08;
            if (Math.abs(heartXRef.current - HEART_X) < 0.5) heartXRef.current = HEART_X;
          }
          const heartH = duckingRef.current && onGroundRef.current ? DUCK_H : HEART_H;
          const groundTop = GROUND_Y - heartH;
          if (heartYRef.current >= groundTop) {
            heartYRef.current = groundTop;
            if (!onGroundRef.current) {
              onGroundRef.current = true;
              jumpsLeftRef.current = 2;
              heartVRef.current = 0;
            }
          }
        }

        // ── World scroll ─────────────────────────────────────────────
        distanceRef.current += speedRef.current;
        const cfg = DIFFICULTY[difficultyRef.current];
        const newLevel = 1 + Math.floor(distanceRef.current / cfg.levelEvery);
        if (newLevel !== levelRef.current) {
          lastLevelMsgRef.current = { level: newLevel, until: performance.now() + 1500 };
        }
        levelRef.current = newLevel;
        speedRef.current = Math.min(cfg.maxSpeed, cfg.startSpeed + (newLevel - 1) * cfg.perLevel);

        // ── Spawning ─────────────────────────────────────────────────
        const minGap = Math.max(cfg.minGap * 0.6, cfg.minGap - newLevel * 12);
        const jitter = Math.random() * 200;
        if (distanceRef.current - lastSpawnRef.current > minGap + jitter) {
          spawnObstacle();
          lastSpawnRef.current = distanceRef.current;
        }

        // ── Move + cull obstacles ────────────────────────────────────
        obstaclesRef.current = obstaclesRef.current
          .map(o => ({ ...o, x: o.x - speedRef.current, phase: o.phase + 0.15 }))
          .filter(o => o.x + o.w > 0);

        // ── Collision (AABB) ─────────────────────────────────────────
        const heartActualH = duckingRef.current && onGroundRef.current ? DUCK_H : HEART_H;
        const heartActualY = duckingRef.current && onGroundRef.current
          ? GROUND_Y - DUCK_H
          : heartYRef.current;
        const heartActualX = heartXRef.current;
        // Skip collision while flying (cheat mode)
        if (!flying) for (const o of obstaclesRef.current) {
          const ls = liveSize(o);
          if (
            heartActualX + HEART_W > ls.x && heartActualX < ls.x + ls.w &&
            heartActualY + heartActualH > ls.y && heartActualY < ls.y + ls.h
          ) {
            gameOverRef.current = true;
            const dist = Math.floor(distanceRef.current / 10);
            if (dist > highScore) {
              localStorage.setItem(HIGHSCORE_KEY, String(dist));
              setHighScore(dist);
            }
            setHud({ score: dist, level: levelRef.current, gameOver: true });
            break;
          }
        }
        if (!gameOverRef.current) {
          setHud({ score: Math.floor(distanceRef.current / 10), level: levelRef.current, gameOver: false });
        }
      }

      // ── Draw ─────────────────────────────────────────────────────
      const scene = SCENES[(levelRef.current - 1) % SCENES.length];
      ctx.fillStyle = scene.bg;
      ctx.fillRect(0, 0, W, H);

      // Scene-specific ambient pattern (cheap, decorative only)
      const t = distanceRef.current * 0.5;
      ctx.fillStyle = scene.accent;
      ctx.strokeStyle = scene.accent;
      if (scene.pattern === 'ekg') {
        // running heartbeat trace along top
        ctx.beginPath();
        const baseY = 40;
        for (let x = 0; x < W; x += 4) {
          const phase = ((x + t) % 200) / 200;
          let y = baseY;
          if (phase > 0.4 && phase < 0.45)      y = baseY - 18 * (phase - 0.4) / 0.05;
          else if (phase >= 0.45 && phase < 0.5) y = baseY + 22 * (phase - 0.45) / 0.05 - 18;
          else if (phase >= 0.5 && phase < 0.55) y = baseY - 18 * (1 - (phase - 0.5) / 0.05) + 4;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (scene.pattern === 'pulse-bars') {
        // vertical scrolling bars
        for (let x = -((t * 0.6) % 60); x < W; x += 60) {
          const h = 6 + 18 * (0.5 + 0.5 * Math.sin(x * 0.05));
          ctx.fillRect(x, 30, 2, h);
        }
      } else if (scene.pattern === 'particles') {
        // floating dust
        for (let i = 0; i < 25; i++) {
          const px = (i * 73 + t * 0.7) % (W + 30) - 15;
          const py = 20 + ((i * 41) % 100) + Math.sin(t * 0.02 + i) * 6;
          ctx.fillRect(px, py, 2, 2);
        }
      } else if (scene.pattern === 'vessels') {
        // wandering vessel-like curves moving with parallax
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          const yBase = 50 + i * 25;
          for (let x = 0; x < W; x += 6) {
            const y = yBase + Math.sin((x + t * 0.4 + i * 100) * 0.02) * 12;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      // Ground
      ctx.strokeStyle = scene.ground;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      ctx.lineTo(W, GROUND_Y);
      ctx.stroke();

      // Obstacles
      for (const o of obstaclesRef.current) {
        const ls = liveSize(o);
        ctx.fillStyle = OBSTACLE_COLOR[o.kind];
        if (o.kind === 'plaque') {
          ctx.fillRect(ls.x, ls.y, ls.w, ls.h);
          if (o.pulses) {
            // subtle outline so player notices it's pulsing
            ctx.strokeStyle = '#fef3c7';
            ctx.lineWidth = 1;
            ctx.strokeRect(ls.x, ls.y, ls.w, ls.h);
          }
        } else if (o.kind === 'thrombus') {
          // red circle
          ctx.beginPath();
          ctx.arc(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (o.kind === 'embolus') {
          // wobbly oval flier
          const wob = Math.sin(o.phase) * 4;
          ctx.beginPath();
          ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2 + wob, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          // small wing tick
          ctx.fillRect(o.x - 4, o.y + o.h / 2 - 1 + wob, 4, 2);
        } else if (o.kind === 'virus') {
          // purple jagged spiky thing
          const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
          const r = o.w / 2;
          ctx.beginPath();
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + o.phase * 0.3;
            const rr = i % 2 === 0 ? r : r * 0.55;
            const px = cx + Math.cos(a) * rr;
            const py = cy + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
      }

      // Heart
      const ducking = duckingRef.current && onGroundRef.current;
      const hh = ducking ? DUCK_H : HEART_H;
      const hy = ducking ? GROUND_Y - DUCK_H : heartYRef.current;
      const flying = performance.now() < flyUntilRef.current;
      const hxNow = heartXRef.current;
      // Cyan glow ring when flying
      if (flying) {
        ctx.strokeStyle = '#00E5FF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hxNow + HEART_W / 2, hy + hh / 2, HEART_W * 0.9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = gameOverRef.current ? '#7f1d1d' : flying ? '#67e8f9' : '#4ade80';
      ctx.beginPath();
      // Two-bump heart silhouette
      ctx.moveTo(hxNow + HEART_W / 2, hy + hh);
      ctx.bezierCurveTo(hxNow,           hy + hh * 0.7, hxNow,           hy,             hxNow + HEART_W / 2, hy + hh / 4);
      ctx.bezierCurveTo(hxNow + HEART_W, hy,             hxNow + HEART_W, hy + hh * 0.7, hxNow + HEART_W / 2, hy + hh);
      ctx.fill();

      // HUD
      ctx.fillStyle = '#888';
      ctx.font = '600 13px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`L${levelRef.current}`, 12, 22);
      ctx.textAlign = 'right';
      ctx.fillText(`HI ${String(highScore).padStart(5, '0')}`, W - 80, 22);
      ctx.fillStyle = '#eee';
      ctx.fillText(String(Math.floor(distanceRef.current / 10)).padStart(5, '0'), W - 12, 22);
      ctx.textAlign = 'left';

      // Fly-mode timer
      if (flying) {
        const remaining = Math.max(0, (flyUntilRef.current - performance.now()) / 1000);
        ctx.fillStyle = '#00E5FF';
        ctx.font = '700 14px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`✈ FLY MODE  ${remaining.toFixed(1)}s`, W / 2, 22);
        ctx.textAlign = 'left';
      }

      // Level-up flash + scene name
      const lm = lastLevelMsgRef.current;
      if (lm.level > 0 && performance.now() < lm.until) {
        const sceneName = SCENES[(lm.level - 1) % SCENES.length].label;
        ctx.fillStyle = '#fbbf24';
        ctx.font = '700 20px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`LEVEL ${lm.level} — ${sceneName}`, W / 2, 48);
        ctx.textAlign = 'left';
      }

      // Game over message
      if (gameOverRef.current) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#eee';
        ctx.font = '700 18px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Game Over', W / 2, 50);
        ctx.font = '600 12px ui-monospace, Menlo, monospace';
        ctx.fillStyle = '#aaa';
        ctx.fillText(
          `Difficulty: ${difficultyRef.current.toUpperCase()}  ·  press 1/2/3 to change`,
          W / 2, 78,
        );
        ctx.fillStyle = '#fbbf24';
        ctx.font = '700 14px ui-monospace, Menlo, monospace';
        ctx.fillText('press Space to restart', W / 2, H / 2 + 30);
        ctx.textAlign = 'left';
      }

      // Pre-start overlay: difficulty selector
      if (!startedRef.current && !gameOverRef.current) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#eee';
        ctx.textAlign = 'center';
        ctx.font = '700 22px ui-monospace, Menlo, monospace';
        ctx.fillText('♥ CORONARY RUNNER', W / 2, 50);

        const labels: { key: string; name: string; diff: Difficulty }[] = [
          { key: '1', name: 'Easy',   diff: 'easy'   },
          { key: '2', name: 'Medium', diff: 'medium' },
          { key: '3', name: 'Hard',   diff: 'hard'   },
        ];
        const slotW = 130;
        const totalW = slotW * labels.length + 20 * (labels.length - 1);
        let x = (W - totalW) / 2;
        labels.forEach(l => {
          const sel = difficultyRef.current === l.diff;
          ctx.fillStyle = sel ? '#2563eb' : '#1a1a1a';
          ctx.strokeStyle = sel ? '#3b82f6' : '#333';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.rect(x, 80, slotW, 42);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = sel ? '#fff' : '#aaa';
          ctx.font = '700 13px ui-monospace, Menlo, monospace';
          ctx.fillText(`${l.key}  ${l.name}`, x + slotW / 2, 106);
          x += slotW + 20;
        });

        ctx.fillStyle = '#888';
        ctx.font = '600 12px ui-monospace, Menlo, monospace';
        ctx.fillText('press 1/2/3 to change difficulty · Space to start', W / 2, 152);
        ctx.textAlign = 'left';
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [highScore]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: '#000a', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#161616', border: '1px solid #2a2a2a', borderRadius: 8,
          padding: 18, color: '#ddd',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.04em' }}>♥ Coronary Runner</span>
          <span style={{ fontSize: 11, color: '#666' }}>
            Level {hud.level} · Score {hud.score} · Best {highScore}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: '1px solid #2a2a2a', borderRadius: 4, color: '#888', padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
          >
            Close (Esc)
          </button>
        </div>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          onClick={tryJump}
          style={{ display: 'block', borderRadius: 4, cursor: 'pointer', background: '#0d0d0d' }}
        />
        <div style={{ display: 'flex', gap: 18, fontSize: 10, color: '#666', marginTop: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <span><kbd style={kbd}>Space</kbd> jump · double-tap to double-jump</span>
          <span><kbd style={kbd}>↓</kbd> hold to duck</span>
          <span><kbd style={kbd}>1</kbd>/<kbd style={kbd}>2</kbd>/<kbd style={kbd}>3</kbd> easy/medium/hard (between rounds)</span>
          <span><kbd style={kbd}>Esc</kbd> close</span>
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 9, color: '#555', marginTop: 6, justifyContent: 'center' }}>
          {(Object.keys(OBSTACLE_COLOR) as Kind[]).map(k => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: OBSTACLE_COLOR[k] }} />
              {OBSTACLE_LABEL[k]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

const kbd: React.CSSProperties = {
  background: '#222',
  padding: '1px 5px',
  borderRadius: 3,
  fontSize: 9,
  fontFamily: 'ui-monospace, Menlo, monospace',
  color: '#aaa',
  border: '1px solid #333',
};

export default MiniGame;
