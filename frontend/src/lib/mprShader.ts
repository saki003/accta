/**
 * GLSL shaders for single-plane MPR with optional MIP slab.
 *
 * The vertex shader passes a fullscreen UV quad.
 * The fragment shader:
 *   1. Maps each pixel to a world-mm point on the slice plane.
 *   2. Converts world → texture [0,1]³ via uWorldToTex.
 *   3. For MIP: marches along the plane normal and takes the maximum.
 *   4. Applies window/level mapping.
 */

export const MPR_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const MPR_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;

uniform sampler3D uVolume;
uniform mat4      uWorldToTex;   // world mm → texture [0,1]³
uniform vec3      uPlaneCenter;  // world mm
uniform vec3      uBasisU;       // right direction (unit, world mm)
uniform vec3      uBasisV;       // up direction    (unit, world mm)
uniform vec3      uPlaneNormal;  // plane normal    (unit, world mm)
uniform float     uFovU;         // half-width  in mm
uniform float     uFovV;         // half-height in mm
uniform float     uWL;           // window level (HU)
uniform float     uWW;           // window width (HU)
uniform float     uSlabMm;       // 0 = single slice; >0 = MIP slab thickness

// Vesselness overlay
uniform sampler3D uVesselness;
uniform mat4      uVesselnessWorldToTex;
uniform bool      uHasVesselness;
uniform float     uVesselnessOpacity;
uniform float     uVesselnessMax;
uniform float     uVesselnessThreshold;

varying vec2 vUv;

float sampleHU(vec3 worldPt) {
  vec4 tc = uWorldToTex * vec4(worldPt, 1.0);
  if (any(lessThan(tc.xyz, vec3(0.0))) || any(greaterThan(tc.xyz, vec3(1.0))))
    return -3000.0;
  return texture(uVolume, tc.xyz).r;
}

// Hot colormap: 0→dark-red, 0.5→orange, 1→yellow-white
vec3 hotColor(float t) {
  return vec3(
    clamp(t * 3.0, 0.0, 1.0),
    clamp(t * 3.0 - 1.0, 0.0, 1.0),
    clamp(t * 3.0 - 2.0, 0.0, 1.0)
  );
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  vec3 worldPt = uPlaneCenter
    + uv.x * uFovU * uBasisU
    + uv.y * uFovV * uBasisV;

  float hu;

  if (uSlabMm < 0.5) {
    hu = sampleHU(worldPt);
  } else {
    // MIP: march 32 steps along the normal across the slab
    float halfSlab = uSlabMm * 0.5;
    hu = -3000.0;
    for (int i = 0; i < 32; i++) {
      float t = -halfSlab + float(i) / 31.0 * uSlabMm;
      float v = sampleHU(worldPt + t * uPlaneNormal);
      if (v > hu) hu = v;
    }
  }

  float lo = uWL - uWW * 0.5;
  float intensity = clamp((hu - lo) / uWW, 0.0, 1.0);
  vec3 rgb = vec3(intensity);

  if (uHasVesselness) {
    vec4 vtc = uVesselnessWorldToTex * vec4(worldPt, 1.0);
    if (all(greaterThanEqual(vtc.xyz, vec3(0.0))) && all(lessThanEqual(vtc.xyz, vec3(1.0)))) {
      float v = texture(uVesselness, vtc.xyz).r;
      if (v >= uVesselnessThreshold) {
        float vn = clamp(v / max(uVesselnessMax, 1e-6), 0.0, 1.0);
        vec3 vcolor = hotColor(vn);
        rgb = mix(rgb, vcolor, vn * uVesselnessOpacity);
      }
    }
  }

  gl_FragColor = vec4(rgb, 1.0);
}
`;
