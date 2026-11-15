// SHATTER's shards, worked out once a change: the two shards nearest each
// place of the frozen frame, into a small texture (`gpu.rs`, half the
// picture's size each way) that `final.glsl` (TRANSITION 1) reads every
// frame of the change instead of searching four shards at each pixel. It
// works out the edge between the two itself, so the cracks stay as sharp
// as the picture, however coarse the texture.
//
// The shards are Voronoi cells, their points from the noise texture, small
// at the strike in the middle and larger outward: the sheet is read at the
// square root of the distance from the middle (`toShards`). The texture
// covers the picture as it is before the sheet flies at the camera; the
// final pass reads it nearer the middle as the sheet comes closer.
//
// Red and green: the nearest shard's cell; blue and alpha: the second
// nearest's, each offset by `SHARD_CELL_BIAS` so it fits a byte.

uniform float uTransSeed;

void main() {
  highp vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  highp vec2 g = toShards((vUv - 0.5) * aspect);
  // The four cells nearest: each shard's point stays well inside its
  // cell, so the nearest two points are all but always among theirs.
  highp vec2 cell = floor(g - 0.5);
  vec2 inside = vec2(g - cell);
  ivec2 shift = shardShift(uTransSeed);
  float near = 99.0;
  float second = 99.0;
  vec2 nearest = vec2(0.0);
  vec2 next = vec2(0.0);
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 to = inside - n - 0.2 - 0.6 * shard(cell + n, shift).rg;
      float d = dot(to, to);
      float closer = step(d, near);
      float closerThanSecond = step(d, second);
      // The old nearest becomes the second, or this one does.
      next = mix(mix(next, n, closerThanSecond), nearest, closer);
      second = mix(min(second, d), near, closer);
      near = min(near, d);
      nearest = mix(nearest, n, closer);
    }
  }
  fragColor = (vec4(cell + nearest, cell + next) + SHARD_CELL_BIAS) / 255.0;
}
