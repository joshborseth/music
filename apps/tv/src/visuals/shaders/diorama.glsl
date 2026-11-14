// DIORAMA: the album cover as a world. The server guesses how near each
// part of the cover is (Depth Anything V2, `uDepth`), and the cover is
// raised by it into a relief, lit, with the far parts lost in a haze of
// its own deep color: a diorama of the album art that the camera drifts
// round, orbiting slowly with the bars, pushing in on each beat, and
// closing on the nearest figure as a drop builds. The near layer jumps
// with the kick, the far one shimmers with the hi-hats, the middle
// breathes with the bass, and on the snare the view wiggles between two
// eyes, so the depth shows at once. When a drop lands the picture shatters:
// its shards fly at you, spinning, lit along their edges, and fall back
// into place over the next two bars.
//
// The relief is a mesh (`diorama.vert`, `diorama.frag`), drawn with a
// depth buffer, since shards cross each other. Whole, it covers the whole
// picture, fading into the backdrop's colors past the cover's edges.
// While it shatters, this file's `main` paints the backdrop behind it,
// only where it left the picture empty (the engine draws it at the far
// plane with the depth test on): between the shards. The mesh's shaders
// include this file, with `DIORAMA_MESH` defined, for what the two share.
// The camera is worked out once a frame (diorama.rs).

// The cover's depth, row by row from the top like `uCover`, near bright.
uniform sampler2D uDepth;
// The camera: the picture's projection and view, and the eye's place,
// with how far it has swung round (radians) in w.
uniform mat4 uDioramaView;
uniform vec4 uDioramaEye;
// The shatter: how far through it (0 to 1 over the two bars after a drop)
// and how hard (0 when no drop has landed lately).
uniform vec2 uDioramaShatter;

// How far the nearest part of the cover stands out; the cover is 2 across.
const float RELIEF = 0.62;

// The cover's depth at `uv` (y up), `lod` mip levels down. Past its edges
// the edge itself runs on, as the cover's colors do on the relief.
float depthAt(highp vec2 uv, float lod) {
  highp vec2 at = clamp(uv, 0.0, 1.0);
  return textureLod(uDepth, vec2(at.x, 1.0 - at.y), lod).r;
}

// The backdrop's colors at `p` (centered, y up, as `centered()`), the
// camera swung round by `yaw`: the cover's deep color up high, its second
// color low down as a haze, and a soft light behind where the cover hangs,
// which flares as it shatters. The mesh fades into exactly this past the
// cover's edges, so they never show.
vec3 dioramaSky(highp vec2 p, highp float yaw) {
  float up = clamp(p.y + 0.5, 0.0, 1.0);
  vec3 color = mix(uColorD * 0.2, uColorC * 0.09, smoothstep(0.0, 0.9, up));
  // The light behind the picture: it flares as it shatters.
  float shatter = uDioramaShatter.y * smoothstep(0.0, 0.05, uDioramaShatter.x)
    * (1.0 - smoothstep(0.2, 0.9, uDioramaShatter.x));
  highp vec2 q = p + vec2(yaw * 0.3, 0.0);
  float behind = exp(-dot(q, q) * 3.0);
  color += uColorA * behind * (0.08 + 0.06 * uBass + 0.22 * shatter);
  return color;
}

#ifndef DIORAMA_MESH
void main() {
  highp vec2 p = centered();
  highp float yaw = uDioramaEye.w;
  vec3 color = dioramaSky(p, yaw);
  // Dust: a speck in some cells of a grid that slides as the camera swings,
  // so the void behind the picture has depth too. One read of the noise
  // gives the cell's chance and its speck's place.
  highp vec2 g = (p + vec2(yaw * 0.5, -uTime * 0.004)) * 20.0;
  highp vec2 cell = floor(g);
  vec2 random = textureLod(uNoise, (cell + 0.5) / 256.0, 0.0).rg;
  vec2 at = fract(g) - 0.5 - (random - 0.5) * 0.6;
  float speck = smoothstep(0.1, 0.0, length(at)) * step(0.88, random.x);
  // They twinkle with the hi-hats.
  color += mix(uColorD, vec3(1.0), 0.4) * speck * (0.12 + 0.25 * uHat);
  fragColor = vec4(color, 1.0);
}
#endif
