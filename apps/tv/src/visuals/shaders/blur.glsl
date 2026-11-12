// BLOOM, steps 2 and 3: a wide blur along `uDirection` (one pixel of the
// source, across or down), nine taps folded into five with linear sampling.

uniform sampler2D uSource;
uniform vec2 uDirection;

void main() {
  vec3 sum = texture(uSource, vUv).rgb * 0.2270270;
  sum += texture(uSource, vUv + uDirection * 1.3846154).rgb * 0.3162162;
  sum += texture(uSource, vUv - uDirection * 1.3846154).rgb * 0.3162162;
  sum += texture(uSource, vUv + uDirection * 3.2307692).rgb * 0.0702703;
  sum += texture(uSource, vUv - uDirection * 3.2307692).rgb * 0.0702703;
  fragColor = vec4(sum, 1.0);
}
