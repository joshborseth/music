// DIORAMA (mesh): each pixel of the relief is the cover, lit as its point
// worked out (diorama.vert), sunk into the haze, with a shard's edges lit
// while it flies. Two reads.
//
// The points read the depth smoothed (diorama.vert), so where the cover
// steps from a figure to what is behind it, the relief slopes, and the
// far side's pixels are drawn forward on the slope, round the figure.
// Each pixel reads its own depth, sharp: one that lies further back than
// its point holds is on that slope, and falls into shadow. So a figure's
// outline is the picture's own, with a soft shadow behind it.

// The cover's depth (diorama.glsl), which the points read too.
uniform sampler2D uDepth;

#ifdef WORDS
// THE WORDS float in the relief as a pane of letters at `WORD_PLANE`,
// between the near parts and the far: a pixel whose point lies behind the
// pane looks along its ray to where it crosses the pane, and shows the
// letters there; the parts in front hide them. The pane is the word's
// own, centred on the cover, a hook larger. The eye (diorama.rs), highp
// as diorama.glsl declares it for the points.
uniform highp vec4 uDioramaEye;
// `RELIEF` in diorama.glsl times how far forward the pane stands: in front
// of most of a cover, behind its nearest parts (the depth maps pin the
// nearest at 1, the farthest at 0).
const float WORD_PLANE = 0.62 * 0.6;
// Half the pane's width over the cover's (2 across), a hook's more.
const float WORD_REACH = 0.42;

// The letters (x) and their halo (y) where the ray to the relief's point
// `world` crosses the pane, if the point lies behind it.
vec2 wordPane(highp vec3 world) {
  vec4 now = uWordTime[WORD_NOW];
  highp vec3 eye = uDioramaEye.xyz;
  if (now.w <= 0.0 || world.z >= WORD_PLANE || eye.z <= WORD_PLANE) return vec2(0.0);
  highp float t = (eye.z - WORD_PLANE) / (eye.z - world.z);
  highp vec2 on = eye.xy + (world.xy - eye.xy) * t;
  vec4 box = uWordBox[WORD_NOW];
  float reach = WORD_REACH * (1.0 + 0.5 * now.z);
  // The pane's units to the word's own: its half width across `reach`.
  highp vec2 p = box.xy + on * (box.z / reach);
  float come = smoothstep(0.0, 0.25, now.x);
  return wordLetters(WORD_NOW, p, 1.0, 0.03) * now.w * come;
}
#endif

in vec3 vLight;
in vec3 vAdd;
in vec3 vFog;
in float vHaze;
in vec3 vEdge;
in float vShard;
in float vDepth;

void main() {
  // Past the cover's edges, its edge runs on (diorama.glsl, `depthAt`).
  highp vec2 at = clamp(vUv, 0.0, 1.0);
  float depth = textureLod(uDepth, vec2(at.x, 1.0 - at.y), 0.0).r;
  float behind = smoothstep(0.04, 0.25, vDepth - depth);
  vec3 color = cover(at) * vLight * (1.0 - 0.6 * behind) + vAdd * (1.0 - behind);
  color = mix(color, vFog, vHaze);
#ifdef WORDS
  if (vShard <= 0.001) {
    vec2 pane = wordPane(vec3(vUv * 2.0 - 1.0, vDepth * 0.62));
    // The letters lit in the cover's colors, a faint shadow around them.
    vec3 ink = mix(uColorA, vec3(1.0), 0.6) * (1.5 + 0.3 * uHit);
    color = mix(color * (1.0 - 0.45 * pane.y), ink, pane.x);
  }
#endif
  if (vShard > 0.001) {
    // A line a pixel and a half wide along each edge of the shard.
    vec3 width = fwidth(vEdge) * 1.5;
    vec3 inside = smoothstep(vec3(0.0), width, vEdge);
    float edge = 1.0 - min(min(inside.x, inside.y), inside.z);
    color += mix(uColorA, vec3(1.0), 0.35) * edge * min(vShard * 3.0, 1.0) * 1.4;
    color *= 1.0 + 0.25 * vShard;
  }
  fragColor = vec4(color, 1.0);
}
