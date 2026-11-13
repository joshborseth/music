// BLOOM, step 2: one blur, across and down at once, at the bright parts'
// size. Four taps, each between four pixels, make a 3 × 3 tent (1 2 1
// each way), and stretching the glow to the screen smooths it the rest of
// the way: with the 8 × 8 boxes, light spreads as far as it did when the
// glow was blurred at a quarter size, for a sixteenth of the pixels.

uniform sampler2D uSource;
uniform vec2 uTexel; // one pixel of the source, in texture units

void main() {
  highp vec2 corner = 0.5 * uTexel;
  vec3 sum = texture(uSource, vUv - corner).rgb
    + texture(uSource, vUv + corner).rgb
    + texture(uSource, vUv + vec2(corner.x, -corner.y)).rgb
    + texture(uSource, vUv + vec2(-corner.x, corner.y)).rgb;
  fragColor = vec4(sum * 0.25, 1.0);
}
