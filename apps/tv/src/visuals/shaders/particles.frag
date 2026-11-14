// A particle's light: a soft round dot, brightest in its middle. Comes
// after common.glsl only (there is no `vUv` to read).

precision mediump float;

in vec3 vLight;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float fall = max(1.0 - dot(d, d), 0.0);
  fragColor = vec4(vLight * fall * fall, 0.0);
}
