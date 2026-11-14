// CORAL's reef as a picture the scene can read smoothly: the
// reaction-diffusion's state (integer, read a texel at a time) turned into
// an 8-bit texture the GPU filters, on the same small grid. Red is how
// much coral (v), green the food left around it (u), blue and alpha how
// steeply the coral rises across and up, for its lighting. The scene then
// reads it once a pixel, at its own size.

precision highp usampler2D;
uniform usampler2D uState;

float coralAt(ivec2 texel, ivec2 side) {
  return uintBitsToFloat(texelFetch(uState, clamp(texel, ivec2(0), side - 1), 0).y);
}

void main() {
  ivec2 side = textureSize(uState, 0);
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec2 here = uintBitsToFloat(texelFetch(uState, texel, 0).xy);
  float across = coralAt(texel + ivec2(1, 0), side) - coralAt(texel - ivec2(1, 0), side);
  float up = coralAt(texel + ivec2(0, 1), side) - coralAt(texel - ivec2(0, 1), side);
  fragColor = vec4(clamp(here.y * 2.5, 0.0, 1.0), here.x, 0.5 + across * 1.6, 0.5 + up * 1.6);
}
