/**
 * NIfTI-1 volume loader for Three.js.
 *
 * Fetches GET /volumes/{uid}/nifti, decompresses with DecompressionStream,
 * parses the 348-byte NIfTI-1 header, and returns a VolumeData object
 * ready to be uploaded as a THREE.Data3DTexture.
 */

import * as THREE from 'three';

export interface VolumeData {
  texture: THREE.Data3DTexture;
  shape: [number, number, number];    // [nz, ny, nx]
  spacing: [number, number, number];  // [dz, dy, dx] mm
  origin: [number, number, number];   // world mm of voxel [0,0,0] in (x,y,z)
  huMin: number;
  huMax: number;
  /** 4×4 matrix: world mm (x,y,z) → texture [0,1]³ */
  worldToTex: THREE.Matrix4;
  /** Raw HU voxel data in C order [z,y,x] for CPU sampling */
  data: Float32Array;
}

// ---------------------------------------------------------------------------
// Decompress gzip in the browser
// ---------------------------------------------------------------------------

async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// Parse NIfTI-1 header (little-endian, 348 bytes)
// ---------------------------------------------------------------------------

interface NiftiHeader {
  nx: number; ny: number; nz: number;
  dx: number; dy: number; dz: number;
  qfac: number;
  qb: number; qc: number; qd: number;
  qox: number; qoy: number; qoz: number;
  voxOffset: number;
}

function parseNifti1Header(buf: ArrayBuffer): NiftiHeader {
  const v = new DataView(buf);
  const le = true;

  const nx = v.getInt16(42, le);
  const ny = v.getInt16(44, le);
  const nz = v.getInt16(46, le);

  const qfac = v.getFloat32(76, le) || 1.0;
  const dx   = v.getFloat32(80, le);
  const dy   = v.getFloat32(84, le);
  const dz   = v.getFloat32(88, le);

  const voxOffset = Math.max(352, v.getFloat32(108, le));

  const qb = v.getFloat32(256, le);
  const qc = v.getFloat32(260, le);
  const qd = v.getFloat32(264, le);
  const qox = v.getFloat32(268, le);
  const qoy = v.getFloat32(272, le);
  const qoz = v.getFloat32(276, le);

  return { nx, ny, nz, dx, dy, dz, qfac, qb, qc, qd, qox, qoy, qoz, voxOffset };
}

// ---------------------------------------------------------------------------
// Quaternion → rotation matrix (NIfTI convention)
// ---------------------------------------------------------------------------

function qformMatrix(h: NiftiHeader): THREE.Matrix4 {
  const { qb, qc, qd, qfac, dx, dy, dz, qox, qoy, qoz } = h;
  const qa = Math.sqrt(Math.max(0, 1 - qb*qb - qc*qc - qd*qd));

  // Rotation matrix columns (i, j, k) in world (x,y,z)
  const r00 = qa*qa + qb*qb - qc*qc - qd*qd;
  const r10 = 2*(qb*qc + qa*qd);
  const r20 = 2*(qb*qd - qa*qc);

  const r01 = 2*(qb*qc - qa*qd);
  const r11 = qa*qa + qc*qc - qb*qb - qd*qd;
  const r21 = 2*(qc*qd + qa*qb);

  const r02 = qfac * 2*(qb*qd + qa*qc);
  const r12 = qfac * 2*(qc*qd - qa*qb);
  const r22 = qfac * (qa*qa + qd*qd - qb*qb - qc*qc);

  // Affine: world = R * diag(dx,dy,dz) * voxIdx + origin
  // world_x = r00*dx*i + r01*dy*j + r02*dz*k + qox
  return new THREE.Matrix4().set(
    r00*dx, r01*dy, r02*dz, qox,
    r10*dx, r11*dy, r12*dz, qoy,
    r20*dx, r21*dy, r22*dz, qoz,
    0,      0,      0,      1,
  );
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export async function loadNiftiVolume(uid: string): Promise<VolumeData> {
  const resp = await fetch(`/volumes/${uid}/nifti`);
  if (!resp.ok) throw new Error(`NIfTI fetch failed: ${resp.status}`);
  const compressed = await resp.arrayBuffer();
  const raw = await decompressGzip(compressed);

  const hdr = parseNifti1Header(raw);
  const { nx, ny, nz, dx, dy, dz, voxOffset } = hdr;

  const voxelBytes = nx * ny * nz * 4;
  const voxelBuf = raw.slice(voxOffset, voxOffset + voxelBytes);
  const arr = new Float32Array(voxelBuf);

  // HU range
  let huMin = Infinity, huMax = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < huMin) huMin = arr[i];
    if (arr[i] > huMax) huMax = arr[i];
  }

  // Three.js Data3DTexture: width=nx, height=ny, depth=nz
  const texture = new THREE.Data3DTexture(arr, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  // World-to-texture matrix: tex = (voxIdx) / (shape-1)
  //   voxIdx = affineInverse * worldPt
  const voxToWorld = qformMatrix(hdr);
  const worldToVox = voxToWorld.clone().invert();

  // Scale voxel indices to [0,1]
  const voxToTex = new THREE.Matrix4().makeScale(
    1 / Math.max(nx - 1, 1),
    1 / Math.max(ny - 1, 1),
    1 / Math.max(nz - 1, 1),
  );

  const worldToTex = voxToTex.multiply(worldToVox);

  // Origin of voxel [0,0,0] in world (x,y,z)
  const origin0 = new THREE.Vector3(hdr.qox, hdr.qoy, hdr.qoz);

  return {
    texture,
    shape: [nz, ny, nx],
    spacing: [dz, dy, dx],
    origin: [origin0.x, origin0.y, origin0.z],
    huMin,
    huMax,
    worldToTex,
    data: arr,
  };
}
