// TERRAIN: flying low over a landscape made of the song itself. The last
// four seconds of the spectrum stand up as mountains: new ones rise on the
// horizon and roll toward you, bass by the road and treble far out. A sun
// in the cover's colors sits on the horizon and the grid flashes on the beat.

// How far the landscape reaches, and the seconds of music it shows; the
// engine keeps `HISTORY_SECONDS` of bands in `uHistory`.
const float DEPTH = 14.0;
const float HISTORY_SECONDS = 4.0;
uniform float uHistoryAge; // 0 to 1: how far toward the next row the history is

float height(vec2 at) {
  float side = abs(at.x);
  float band = clamp((side - 0.35) / 3.2, 0.0, 1.0);
  float ago = clamp(1.0 - at.y / DEPTH, 0.0, 1.0);
  // Between rows the data ages toward the next row: read a little newer.
  float level = history(band, ago - uHistoryAge / 128.0);
  float road = smoothstep(0.25, 0.9, side);
  float far = smoothstep(DEPTH + 2.0, DEPTH * 0.7, at.y);
  float lift = (0.35 + 0.65 * uIntensity) * (1.0 + 0.5 * uDrop);
  return pow(level, 1.6) * 1.6 * lift * road * far + 0.04 * noise(at * 3.0) * road;
}

vec3 sky(vec3 dir) {
  float up = clamp(dir.y * 3.0, 0.0, 1.0);
  vec3 color = mix(uColorB * 0.35, uColorC * 0.04, pow(up, 0.6));
  // The sun: banded like an old poster, swelling on the bass.
  vec2 s = vec2(dir.x, dir.y - 0.12) * 3.2;
  float radius = 0.55 + 0.08 * uBands.x + 0.05 * uBeatPulse;
  float d = length(s);
  float bands = step(0.0, sin((s.y + uDrive * 0.05) * 38.0) + 0.85 + s.y * 3.5);
  float disc = smoothstep(radius, radius - 0.01, d) * bands;
  vec3 sun = mix(uColorA, uColorB, clamp(0.5 - s.y * 1.2, 0.0, 1.0)) * 1.4;
  color = mix(color, sun, disc);
  color += sun * 0.35 * exp(-max(d - radius, 0.0) * 4.0) * (0.6 + 0.6 * uEnergy);
  // Stars, high up.
  vec2 grid = dir.xz / max(dir.y, 0.05) * 60.0;
  float star = step(0.995, hash12(floor(grid))) * smoothstep(0.15, 0.4, dir.y);
  color += vec3(star) * (0.5 + 0.5 * sin(uTime * 3.0 + hash12(floor(grid)) * 40.0));
  return color;
}

void main() {
  vec2 p = centered();
  float bob = 0.04 * uBeatPulse * uEnergy - 0.12 * uDrop;
  vec3 eye = vec3(0.12 * sin(uDrive * 0.11), 0.62 + bob + 0.15 * uTension, 0.0);
  vec3 dir = normalize(vec3(p.x, p.y - 0.17 + 0.05 * uTension, 1.15));
  dir.xy = rot(0.04 * sin(uDrive * 0.09)) * dir.xy;

  // March along the ray until it dips under the land.
  float t = 0.2;
  float lastGap = eye.y;
  float stride = 0.02;
  float hit = -1.0;
  for (int i = 0; i < 72; i++) {
    vec3 at = eye + dir * t;
    if (t > DEPTH + 3.0) break;
    float gap = at.y - height(at.xz);
    if (gap < 0.0) {
      // Step back to where the ray crossed the surface.
      hit = t + gap / (lastGap - gap) * stride;
      break;
    }
    lastGap = gap;
    stride = max(0.02 + t * 0.03, gap * 0.5);
    t += stride;
  }

  vec3 color = sky(dir);
  if (hit > 0.0) {
    vec3 at = eye + dir * hit;
    float h = height(at.xz);
    // Grid lines fixed to the land, which comes toward us.
    float scroll = DEPTH / HISTORY_SECONDS * uTime;
    vec2 cell = vec2(at.x * 2.5, (at.z + scroll) * 2.5);
    vec2 g = abs(fract(cell) - 0.5);
    float width = 0.015 + 0.01 * hit;
    float line = smoothstep(width * 3.0, 0.0, min(g.x, g.y));
    vec3 lit = palette(h * 0.5 + at.x * 0.04 + uTime * 0.01);
    vec3 land = mix(uColorC * 0.03, lit * 0.35, smoothstep(0.0, 1.2, h));
    land += lit * line * (0.5 + 1.4 * uBeatPulse + 1.2 * uDrop) * (0.4 + h);
    // Peaks glow.
    land += lit * smoothstep(0.6, 1.6, h) * 0.6;
    float fog = smoothstep(2.0, DEPTH + 1.0, hit);
    color = mix(land, sky(vec3(dir.x, 0.0, 1.0)), fog);
  }
  fragColor = vec4(color, 1.0);
}
