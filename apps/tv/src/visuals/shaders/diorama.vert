// DIORAMA (mesh): the cover raised by its depth into a relief. Comes after
// diorama.glsl (with `DIORAMA_MESH` defined). Points are worked out from
// `gl_VertexID` alone, with no vertex buffers.
//
// A grid of `COLUMNS` × `ROWS` squares over the cover and far past its
// edges (where the cover's edge runs on), where it fades into the backdrop's
// colors: wide enough that, whole, it covers the picture wherever the
// camera swings, so the backdrop is only drawn while it shatters. Its
// squares are twice as large out there, where nobody sees them. Drawn
// two ways (the engine picks by `uDioramaShatter`, as this does):
//
// - Whole, as triangle strips, one a row of squares, joined by empty
//   triangles, as Terrain's land: each point is shared by the squares
//   round it, so the GPU works out a third as many as triangles need.
// - Shattering, as triangles with three points of their own, so each can
//   fly off on its own: the grid is cut into shards, right triangles
//   `SHARD` squares on a side, and every triangle of a shard moves with
//   it. The shards' edges are lit by where each point sits in its shard
//   (`vEdge`).

// Squares across the cover itself, and past each of its edges; how far
// past the edges the grid reaches.
const ivec2 INNER = ivec2(66, 66);
const ivec2 OUTER = ivec2(32, 12);
const int COLUMNS = INNER.x + 2 * OUTER.x;
const int ROWS = INNER.y + 2 * OUTER.y;
const vec2 BEYOND = vec2(0.95, 0.35);
const int SHARD = 13;
// The points read the depth this many mip levels down, about one of the
// grid's squares wide: a figure's step into the distance becomes a slope
// a square or two across, which the grid follows smoothly. (Read sharp,
// the step zigzags along the grid.) The pixels read it sharp.
const float SMOOTH = 1.6;

// Where grid line `line` (0 to the squares across, each axis) lies on the
// cover: evenly across it, twice as far apart past its edges.
vec2 gridUv(vec2 line) {
  vec2 inner = vec2(INNER);
  vec2 outer = vec2(OUTER);
  vec2 into = (line - outer) / inner;
  vec2 before = -BEYOND + line * BEYOND / outer;
  vec2 after = 1.0 + (line - outer - inner) * BEYOND / outer;
  return mix(mix(before, into, step(outer, line)), after, step(outer + inner + 0.5, line));
}

out highp vec2 vUv;
out vec3 vLight;
out vec3 vAdd;
out vec3 vFog;
out float vHaze;
out vec3 vEdge;
out float vShard;
out float vDepth;

// `v` turned `angle` round the unit `axis`.
vec3 turn(vec3 v, vec3 axis, float angle) {
  float c = cos(angle), s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// The cover at `uv` raised: x and y across (the cover from -1 to 1), z
// toward you.
vec3 raised(vec2 uv, float depth) {
  return vec3(uv * 2.0 - 1.0, depth * RELIEF);
}

void main() {
  // The grid point, and for a shard's triangle which half of its square
  // it is (0: the lower right, 1: the upper left).
  ivec2 square;
  ivec2 at;
  int half_ = 0;
  if (uDioramaShatter.y > 0.0) {
    int corner = gl_VertexID % 3;
    int triangle = gl_VertexID / 3;
    int index = triangle / 2;
    half_ = triangle - index * 2;
    square = ivec2(index % COLUMNS, index / COLUMNS);
    // The corner, in the square: (0,0) (1,0) (1,1), or (0,0) (1,1) (0,1).
    at = half_ == 0
      ? (corner == 0 ? ivec2(0, 0) : (corner == 1 ? ivec2(1, 0) : ivec2(1, 1)))
      : (corner == 0 ? ivec2(0, 0) : (corner == 1 ? ivec2(1, 1) : ivec2(0, 1)));
  } else {
    // Each strip: both rows at every column, then the strip's last point
    // and the next strip's first again, which only make empty triangles.
    int perStrip = 2 * (COLUMNS + 1) + 2;
    int strip = gl_VertexID / perStrip;
    int j = gl_VertexID - strip * perStrip;
    int column = j < 2 * (COLUMNS + 1) ? j / 2 : (j == 2 * (COLUMNS + 1) ? COLUMNS : 0);
    int row = j < 2 * (COLUMNS + 1) ? strip + (j & 1) : strip + 1;
    square = ivec2(column, row);
    at = ivec2(0);
  }
  vec2 uv = gridUv(vec2(square + at));

  // Its shard: the shard square, and which half of it. A square on the
  // shard's diagonal is split along its own, which lies on the shard's.
  ivec2 shardSquare = square / SHARD;
  ivec2 local = square - shardSquare * SHARD;
  int shardHalf = local.x > local.y || (local.x == local.y && half_ == 0) ? 0 : 1;
  // Where the point sits in its shard, 0 to 1 each way, and so how far it
  // is from each of the shard's three edges.
  vec2 f = vec2(local + at) / float(SHARD);
  vEdge = shardHalf == 0
    ? vec3(1.0 - f.x, f.x - f.y, f.y)
    : vec3(1.0 - f.y, f.x, f.y - f.x);

  // Past the cover's edges its edge runs on, sinking back and fading.
  vec2 outside = max(abs(uv - 0.5) - 0.5, 0.0);
  float edge = max(smoothstep(0.0, 0.3, outside.x), smoothstep(0.0, 0.12, outside.y));
  float sink = 1.0 - 0.75 * edge;
  float own = depthAt(uv, SMOOTH);
  vDepth = own;
  float depth = sink * own;
  // The slope, for the light: two more reads, a few texels on.
  const float E = 3.0 / 256.0;
  float across = sink * depthAt(uv + vec2(E, 0.0), SMOOTH);
  float up = sink * depthAt(uv + vec2(0.0, E), SMOOTH);
  vec3 normal = normalize(vec3(-(across - depth) * RELIEF / (2.0 * E), -(up - depth) * RELIEF / (2.0 * E), 1.0));

  // Each layer with its own part of the music: the near one jumps with the
  // kick, the middle breathes with the bass, the far one shimmers with the
  // hi-hats.
  float near = smoothstep(0.55, 0.9, depth);
  float middle = exp(-pow((depth - 0.45) / 0.22, 2.0));
  float far = 1.0 - smoothstep(0.15, 0.45, depth);
  highp float sparkle = hash12(floor(uv * 90.0) + floor(uBeats * 4.0));
  float shimmer = uHat * far * step(0.88, sparkle);
  float lift = depth * (1.0 + 0.3 * uBass * middle) + 0.22 * uHit * near
    + 0.03 * shimmer;
  vec3 position = raised(uv, lift);

  // The shatter.
  float shatter = uDioramaShatter.y;
  float flying = 0.0;
  if (shatter > 0.0) {
    int id = shardSquare.y * 64 + shardSquare.x;
    highp vec2 seed = vec2(float(id), float(shardHalf) * 7.3 + uSeed * 13.0);
    vec3 random = vec3(hash12(seed), hash12(seed + 3.1), hash12(seed + 5.7));
    float t = uDioramaShatter.x;
    // Out in under a beat; back one shard after another, all home by the
    // second bar's end.
    float out_ = smoothstep(0.0, 0.07 + 0.05 * random.x, t);
    float home = smoothstep(0.15 + 0.3 * random.y, 0.55 + 0.4 * random.y, t);
    home = home * home * (3.0 - 2.0 * home);
    flying = shatter * out_ * (1.0 - home);
    // The shard's middle, which it spins round.
    vec2 corner = vec2(shardSquare * SHARD);
    vec2 middleUv = gridUv(corner + (shardHalf == 0 ? vec2(2.0, 1.0) : vec2(1.0, 2.0)) / 3.0 * float(SHARD));
    float middleDepth = depthAt(middleUv, SMOOTH);
    vec3 centre = raised(middleUv, middleDepth);
    // Away from the middle of the picture and toward you, the near
    // ones furthest; spinning on a random axis; sagging as they hang.
    vec3 away = normalize(vec3(centre.xy * 0.8 + (random.xy - 0.5) * 1.2, 0.5 + 0.6 * random.z));
    vec3 axis = normalize(random - 0.5 + 1e-3);
    // The near layer bursts at you; the far one only cracks and drifts.
    float burst = 0.25 + 0.9 * middleDepth;
    float spin = flying * (1.0 + 4.0 * random.y) * burst * (random.x < 0.5 ? -1.0 : 1.0);
    float reach = flying * (0.2 + 0.6 * random.z) * burst;
    position = centre + turn(position - centre, axis, spin) + away * reach
      - vec3(0.0, 0.45 * flying * flying * random.x, 0.0);
    normal = turn(normal, axis, spin);
  }
  vShard = flying;

  gl_Position = uDioramaView * vec4(position, 1.0);
  vUv = uv;

  // The light: a key light swinging slowly with the bars, from the upper
  // left, the cover's own colors left mostly as they are; a rim in the
  // second color on the slopes facing away; the near layer brightening
  // on the kick.
  vec3 eye = normalize(uDioramaEye.xyz - position);
  highp float swing = uBeats / 32.0 * TAU;
  vec3 key = normalize(vec3(-0.5 + 0.35 * sin(swing), 0.55, 0.8));
  float diffuse = max(dot(normal, key), 0.0);
  float facing = abs(dot(normal, eye));
  // Steep slopes are where the picture was stretched over a step in its
  // depth, round a figure: they go dark, a shadow that sets it apart.
  float steep = 1.0 - smoothstep(0.2, 0.65, normal.z);
  vLight = vec3(0.62 + 0.55 * diffuse) * (1.0 + 0.18 * uHit * near) * (1.0 - 0.55 * steep);
  float rim = pow(1.0 - facing, 3.0);
  vAdd = uColorD * rim * (0.35 + 0.4 * uBass) + mix(uColorA, vec3(1.0), 0.5) * shimmer * 0.6
    + vec3(pow(max(dot(reflect(-key, normal), eye), 0.0), 24.0)) * 0.18;

  // The haze: far parts of the cover sink into the deep color, and past
  // its edges the grid fades into the backdrop.
  float distance_ = length(uDioramaEye.xyz - position);
  float haze = 0.35 * pow(1.0 - depth, 1.6) * (1.0 - 0.6 * shatter * flying);
  haze = max(haze, smoothstep(2.2, 4.4, distance_));
  vHaze = max(haze, edge);
  // The color it fades to: the backdrop where the point shows, for the
  // edges; the deep color for the haze inside.
  highp vec2 screen = gl_Position.xy / max(gl_Position.w, 1e-3);
  highp vec2 p = vec2(screen.x * uRes.x / uRes.y, screen.y) * 0.5;
  vec3 sky = dioramaSky(p, uDioramaEye.w);
  vFog = mix(uColorC * 0.12 + uColorD * 0.05, sky, edge);
}
