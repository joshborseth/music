// TERRAIN (land): the landscape as a mesh, drawn over the sky. Comes after
// terrain.glsl (with `TERRAIN_LAND` defined), which it shares the sky,
// the lift, and the horizon with.
//
// One row of points for each row of the spectrum's history (`uHistory`),
// plus the far edge. The rows ride toward you with the history, so each
// point reads its own row's height exactly and nothing swims as the land
// moves. Across, a column sits on each band, with the flat road in the
// middle and a few wide steps out to the edge of the view, where the land
// is the highest band all the way out. The engine draws it as triangle
// strips, one per pair of rows, from the horizon toward you: nearer hills
// cover farther ones, so no depth buffer is needed. Points are worked out
// from `gl_VertexID` alone, with no vertex buffers.

// Columns past the last band, out to the edge of the view.
const int FAR_COLUMNS = 5;
// The nearest the land is drawn: as close as the old ray started.
const float NEAR = 0.2;

out highp vec2 vCell;
out vec3 vBase;
out vec3 vLine;
out float vWidth;

// How far out from the middle of the road column `m` sits.
highp float sideOf(int m, int bands) {
  if (m == 0) return 0.0;
  if (m == 1) return 0.25;
  int band = m - 2;
  if (band < bands) return 0.35 + 3.2 * (float(band) + 0.5) / float(bands);
  return 3.55 * pow(1.4, float(band - bands + 1));
}

void main() {
  ivec2 size = textureSize(uHistory, 0);
  // Out from the middle: the road's edge, the bands, the far columns.
  int halfColumns = 1 + size.x + FAR_COLUMNS;
  int columns = 2 * halfColumns + 1;
  // Each strip: both rows at every column, then the strip's last point
  // and the next strip's first again, which only make empty triangles.
  int perStrip = 2 * columns + 2;
  int strip = gl_VertexID / perStrip;
  int j = gl_VertexID - strip * perStrip;
  int column = j < 2 * columns ? j / 2 : (j == 2 * columns ? columns - 1 : 0);
  int row = j < 2 * columns ? strip + (j & 1) : strip + 1;

  int m = column - halfColumns;
  highp float x = sign(float(m)) * sideOf(abs(m), size.x);
  float rows = float(size.y);
  // Row 0 is the far edge; row r + 1 holds history row r, which comes
  // toward you as it ages (as `uHistoryAge` runs to 1, it reaches where
  // row r + 1 was).
  int data = max(row - 1, 0);
  highp float z = row == 0
    ? DEPTH + 1.0
    : DEPTH * (1.0 - (float(data) + 0.5 + uHistoryAge) / rows);

  float side = abs(x);
  float road = smoothstep(0.25, 0.9, side);
  float band = clamp((side - 0.35) / 3.2, 0.0, 1.0);
  float level = history(band, (float(data) + 0.5) / rows);
  float far = smoothstep(DEPTH + 2.0, DEPTH * 0.7, z);
  float h = level * sqrt(level) * 1.6 * lift() * road * far;
  // The land scrolls this far a second, with the history.
  highp float scroll = DEPTH / HISTORY_SECONDS * uTime;
  // Small bumps, fixed to the land as it comes, which bend the grid lines.
  // Deep in the haze nobody sees them, so the read is saved there. (The
  // noise repeats every 256 / 3 units, so the clock is kept short.)
  float bumps = 0.04 * road * (1.0 - smoothstep(7.0, 10.0, z));
  if (bumps > 0.0) h += bumps * noise(vec2(x, z + mod(scroll, 256.0 / 3.0)) * 3.0);

  // The point seen from the eye, its roll undone, as the sky pass casts
  // a ray for each pixel (terrain.glsl).
  highp vec3 d = vec3(x, h, z) - vec3(uFlight.xy, 0.0);
  highp float dist = length(d);
  highp vec2 v = vec2(uFlight.z * d.x + uFlight.w * d.y, -uFlight.w * d.x + uFlight.z * d.y);
  gl_Position = vec4(
    2.0 * 1.15 * v.x * uRes.y / uRes.x,
    2.0 * (1.15 * v.y + horizon() * d.z),
    d.z - 2.0 * NEAR,
    d.z
  );

  // Grid lines fixed to the land (every 0.4, so the clock is kept short).
  vCell = vec2(x, z + mod(scroll, 0.4)) * 2.5;
  vWidth = 3.0 * (0.015 + 0.01 * dist);
  vec3 lit = palette(h * 0.5 + x * 0.04 + uTime * 0.01);
  vec3 land = mix(uColorC * 0.03, lit * 0.35, smoothstep(0.0, 1.2, h));
  // Peaks glow.
  land += lit * smoothstep(0.6, 1.6, h) * 0.6;
  vec3 line = lit * (0.5 + 0.3 * uBeatPulse + 1.6 * uHit + 1.2 * uDrop) * (0.4 + h);
  // Far off, the land fades into the sky at the horizon.
  float fog = smoothstep(2.0, DEPTH + 1.0, dist);
  vBase = mix(land, sky(vec3(d.x / dist, 0.0, 1.0)), fog);
  vLine = line * (1.0 - fog);
}
