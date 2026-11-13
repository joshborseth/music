// TERRAIN: flying low over a landscape made of the song itself. The last
// four seconds of the spectrum stand up as mountains: new ones rise on the
// horizon and roll toward you, bass by the road and treble far out. A sun
// in the cover's colors sits on the horizon and the grid flashes on the beat.

// How far the landscape reaches, and the seconds of music it shows; the
// engine keeps `HISTORY_SECONDS` of bands in `uHistory`.
const float DEPTH = 14.0;
const float HISTORY_SECONDS = 4.0;
// The most steps a ray takes toward the land.
const int STEPS = 40;
uniform float uHistoryAge; // 0 to 1: how far toward the next row the history is
uniform float uHistoryPeak; // the loudest band anywhere in the history
// The eye's x and height, and the cosine and sine of its roll, worked out
// once a frame (motion.rs).
uniform vec4 uFlight;

// How much the mountains stand up now.
float lift() {
  return (0.35 + 0.65 * uIntensity) * (1.0 + 0.5 * uDrop);
}

// The land's height at `at` (across, ahead).
float height(highp vec2 at) {
  float side = abs(at.x);
  float road = smoothstep(0.25, 0.9, side);
  // The road itself is flat: no reads.
  if (road <= 0.0) return 0.0;
  float band = clamp((side - 0.35) / 3.2, 0.0, 1.0);
  highp float ago = clamp(1.0 - at.y / DEPTH, 0.0, 1.0);
  // Between rows the data ages toward the next row: read a little newer.
  float level = history(band, ago - uHistoryAge / 128.0);
  float far = smoothstep(DEPTH + 2.0, DEPTH * 0.7, at.y);
  float land = level * sqrt(level) * 1.6 * lift() * road * far;
  // Small bumps, which bend the grid lines. Deep in the haze nobody sees
  // them, so the read is saved there.
  float bumps = 0.04 * road * (1.0 - smoothstep(7.0, 10.0, at.y));
  if (bumps > 0.0) land += bumps * noise(at * 3.0);
  return land;
}

vec3 sky(highp vec3 dir) {
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
  if (dir.y > 0.15) {
    highp vec2 grid = floor(dir.xz / dir.y * 60.0);
    highp float random = hash12(grid);
    float star = step(0.995, random) * smoothstep(0.15, 0.4, dir.y);
    color += vec3(star) * (0.5 + 0.5 * sin(uTime * 3.0 + random * 40.0));
  }
  return color;
}

void main() {
  highp vec2 p = centered();
  highp vec3 eye = vec3(uFlight.xy, 0.0);
  highp vec3 dir = normalize(vec3(p.x, p.y - 0.17 + 0.05 * uTension, 1.15));
  dir.xy = mat2(uFlight.z, uFlight.w, -uFlight.w, uFlight.z) * dir.xy;

  // March only where the ray can meet the land: below its highest peak,
  // and not past where the haze hides it completely.
  highp float peak = uHistoryPeak * sqrt(uHistoryPeak) * 1.6 * lift() + 0.04;
  highp float t = 0.2;
  highp float end = DEPTH + 1.0;
  if (dir.y > 0.0) {
    end = min(end, (peak - eye.y) / dir.y);
  } else if (eye.y > peak) {
    t = max(t, (eye.y - peak) / -dir.y);
  }
  highp float lastGap = eye.y;
  highp float stride = 0.02;
  highp float hit = -1.0;
  highp float gap = 1.0;
  for (int i = 0; i < STEPS; i++) {
    if (t > end) break;
    highp vec3 at = eye + dir * t;
    gap = at.y - height(at.xz);
    if (gap < 0.0) {
      // Step back to where the ray crossed the surface.
      hit = t + gap / (lastGap - gap) * stride;
      break;
    }
    lastGap = gap;
    // A step may go as far as the ray needs to fall to this height: past
    // that it dips under the land and the crossing is found between the
    // two steps. Only a ridge could be stepped over whole, so steps stay
    // about a row of the history long, longer far off where rows are small.
    stride = clamp(gap / max(-dir.y, 0.08), 0.03 + t * 0.045, 0.12 + t * 0.06);
    t += stride;
  }
  // Out of steps short of the end: far off, nearly in the haze. Take the
  // land under the ray there.
  if (hit < 0.0 && t <= end) {
    hit = t;
  }

  vec3 color;
  if (hit > 0.0) {
    highp vec3 at = eye + dir * hit;
    // Where the ray meets the land, its height is the land's.
    float h = hit == t && gap >= 0.0 ? at.y - gap : at.y;
    // Grid lines fixed to the land, which comes toward us.
    highp float scroll = DEPTH / HISTORY_SECONDS * uTime;
    highp vec2 cell = vec2(at.x * 2.5, (at.z + scroll) * 2.5);
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
  } else {
    color = sky(dir);
  }
  fragColor = vec4(color, 1.0);
}
