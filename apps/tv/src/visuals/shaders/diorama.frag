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
