/**
 * Minimal vec3 math utilities for MPR crosshair rotation and slab calculations.
 */

export type Vec3 = [number, number, number];

export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const normalize = (v: Vec3): Vec3 => {
  const l = Math.sqrt(dot(v, v));
  return l < 1e-9 ? [0, 0, 0] : scale(v, 1 / l);
};

/**
 * Rodrigues' rotation formula: rotate v around unit-length axis k by angle radians.
 */
export const rotateAround = (v: Vec3, k: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(k, v);
  const cr = cross(k, v);
  return [
    v[0] * c + cr[0] * s + k[0] * d * (1 - c),
    v[1] * c + cr[1] * s + k[1] * d * (1 - c),
    v[2] * c + cr[2] * s + k[2] * d * (1 - c),
  ];
};
