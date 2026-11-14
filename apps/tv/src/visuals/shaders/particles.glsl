// State kept on the GPU between frames: the particle engine's
// (particles.rs) and Coral's (coral.rs). It comes after common.glsl in
// their state passes and in the particles' vertex shader, before
// helpers.glsl.
//
// The TV may draw only into 8-bit color or integer textures (no float
// targets without an extension), so precise state lives in integer
// textures: a float is kept as its bits (`floatBitsToUint`), a velocity
// as two halves (`packHalf2x16`), a color as four bytes (`packColor`).
// Integer textures can't be filtered: they are read whole, a texel at a
// time, with `texelFetch`. Everything here is highp, ints included: a
// particle's place is a texture coordinate, and its bits must survive.
//
// A particle is one texel of `uState` (RGBA32UI): its place (x, y, in the
// scene's centered units, as `centered()` gives them: y from -0.5 to 0.5),
// its velocity (units a second, two halves), and its color (rgb) and heat
// (a, how hot a blast left it). Its target is the same texel of `uState2`:
// where it is pulled (x, y), how hard and how large it draws (two halves),
// and the color it takes on and how bright it draws (a). A scene shapes
// the swarm by writing the targets (`swarm_targets.glsl` is one way).

precision highp int;
precision highp usampler2D;

uniform usampler2D uState;
uniform usampler2D uState2;

// Four values, 0 to 1, as one uint, a byte each (GLSL ES 3.00 has no
// `packUnorm4x8`).
uint packColor(vec4 color) {
  uvec4 bytes = uvec4(clamp(color, 0.0, 1.0) * 255.0 + 0.5);
  return bytes.r | (bytes.g << 8) | (bytes.b << 16) | (bytes.a << 24);
}

vec4 unpackColor(uint packed) {
  return vec4(
    float(packed & 255u),
    float((packed >> 8) & 255u),
    float((packed >> 16) & 255u),
    float(packed >> 24)
  ) / 255.0;
}

// The same integer hash as `motion::hash` on the CPU.
uint hashU(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

// 0 to 1 from a hash, as `motion::unit`.
float unitU(uint x) {
  return float(hashU(x) >> 8) / 16777216.0;
}

// The look's seed (`uSeed`, 0 to 1) as a whole number to hash with.
uint seedU() {
  return uint(uSeed * 16777215.0);
}

// The particle (or cell) this texel holds, counted along rows.
uint texelId(ivec2 texel, ivec2 side) {
  return uint(texel.y * side.x + texel.x);
}

// Where the engine's stream runs at `t` (`uSwarmStream.x`), lifted by
// `lift`: a slow figure across the whole picture, in centered units.
vec2 swarmStreamAt(highp float t, float lift, float aspect) {
  return vec2(
    0.42 * aspect * sin(t * 0.53) + 0.06 * aspect * sin(t * 1.37),
    0.26 * sin(t * 0.81 + 1.3) + lift
  );
}
