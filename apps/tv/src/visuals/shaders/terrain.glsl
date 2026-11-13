// TERRAIN: flying low over a landscape made of the song itself. The last
// four seconds of the spectrum stand up as mountains: new ones rise on the
// horizon and roll toward you, bass by the road and treble far out. A sun
// in the cover's colors sits on the horizon; on the beat it swells, the
// mountains jump, and the grid flashes.
//
// Two draws. This file's `main` paints the sky across the picture; then
// the land goes on top as a mesh (`terrain.vert`, `terrain.frag`), one row
// of points for each row of the spectrum's history, drawn from the horizon
// toward you so nearer hills cover farther ones. The vertex shader reads
// each point's height once; the pixels read nothing. (Marching a ray over
// the land took up to forty reads a pixel.) The mesh's shaders include
// this file, with `TERRAIN_LAND` defined, for what the two share.

// How far the landscape reaches, and the seconds of music it shows; the
// engine keeps `HISTORY_SECONDS` of bands in `uHistory`.
const float DEPTH = 14.0;
const float HISTORY_SECONDS = 4.0;
uniform float uHistoryAge; // 0 to 1: how far toward the next row the history is
// The eye's x and height, and the cosine and sine of its roll, worked out
// once a frame (motion.rs).
uniform vec4 uFlight;

// How much the mountains stand up now: they jump on the beat.
float lift() {
  return (0.35 + 0.65 * uIntensity) * (1.0 + 0.35 * uHit + 0.5 * uDrop);
}

// How far the camera looks down: the horizon sits this far above the
// middle of the picture, and rises as a drop builds.
float horizon() {
  return 0.17 - 0.05 * uTension;
}

vec3 sky(highp vec3 dir) {
  float up = clamp(dir.y * 3.0, 0.0, 1.0);
  vec3 color = mix(uColorB * 0.35, uColorC * 0.04, pow(up, 0.6));
  // The sun: banded like an old poster, swelling on the bass.
  vec2 s = vec2(dir.x, dir.y - 0.1) * 3.2;
  float radius = 0.36 + 0.05 * uBands.x + 0.05 * uHit;
  float d = length(s);
  float bands = step(0.0, sin((s.y + uDrive * 0.05) * 30.0) + 0.85 + s.y * 4.0);
  float disc = smoothstep(radius, radius - 0.01, d) * bands;
  vec3 sun = mix(uColorA, uColorB, clamp(0.5 - s.y * 1.2, 0.0, 1.0)) * 1.1;
  color = mix(color, sun, disc);
  color += sun * 0.35 * exp(-max(d - radius, 0.0) * 4.0) * (0.6 + 0.6 * uEnergy);
  // Stars, high up.
  if (dir.y > 0.15) {
    highp vec2 grid = floor(dir.xz / dir.y * 60.0);
    highp float random = hash12(grid);
    float star = step(0.995, random) * smoothstep(0.15, 0.4, dir.y);
    color += vec3(star) * (0.5 + 0.5 * sin(uTime * 3.0 + random * 40.0));
  }
  return color;
}

#ifndef TERRAIN_LAND
void main() {
  highp vec2 p = centered();
  highp vec3 dir = normalize(vec3(p.x, p.y - horizon(), 1.15));
  dir.xy = mat2(uFlight.z, uFlight.w, -uFlight.w, uFlight.z) * dir.xy;
  // Well below the horizon the land always covers the sky (it reaches
  // DEPTH + 1 ahead, and the eye is never below 0.5): skip the sun there.
  if (dir.y < -0.08) {
    fragColor = vec4(uColorB * 0.35, 1.0);
    return;
  }
  fragColor = vec4(sky(dir), 1.0);
}
#endif
