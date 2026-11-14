// THE PARTICLES, drawn: one point for each, read from its texel of the
// state (particles.glsl) by its vertex number, so no vertex buffer is
// needed. Added onto the scene's picture (blending ONE, ONE), so where
// particles crowd they burn brighter, as light does.

// How large a particle draws, in pixels, at the target's size 1 (scaled
// with the scene's height), and how bright.
uniform float uSwarmSize;
uniform float uSwarmGain;

out vec3 vLight;

void main() {
  ivec2 side = textureSize(uState, 0);
  ivec2 texel = ivec2(gl_VertexID % side.x, gl_VertexID / side.x);
  uint id = texelId(texel, side);
  uvec4 state = texelFetch(uState, texel, 0);
  uvec4 target = texelFetch(uState2, texel, 0);
  vec2 at = uintBitsToFloat(state.xy);
  vec2 velocity = unpackHalf2x16(state.z);
  vec4 color = unpackColor(state.w);
  float size = unpackHalf2x16(target.z).y;
  float bright = unpackColor(target.w).a;
  float heat = color.a;

  // Each hi-hat makes a few particles flare for a moment, different ones
  // each time: a sparkle across the shape.
  uint flicker = id ^ hashU(uint(uTime * 24.0));
  float sparkle = step(unitU(flicker), uHat * 0.22);
  // Fast particles burn brighter while they fly.
  float speed = min(length(velocity), 3.0);

  gl_Position = vec4(at.x * 2.0 * uRes.y / uRes.x, at.y * 2.0, 0.0, 1.0);
  float pixels = uSwarmSize * size * (1.0 + 1.2 * sparkle + 0.8 * heat);
  gl_PointSize = max(pixels, 1.0);
  // A point smaller than a pixel still covers one: dim it to match, so
  // tiny particles don't all look the same size.
  float cover = min(pixels * pixels, 1.0);
  vLight = color.rgb * bright * uSwarmGain * cover
    * (1.0 + 2.5 * sparkle + 1.5 * heat + 0.25 * speed);
}
