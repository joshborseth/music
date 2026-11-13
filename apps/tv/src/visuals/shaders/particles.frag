// PARTICLES (points): a soft round grain, added on top of the others.

precision mediump float;

in vec3 vColor;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float fall = smoothstep(0.5, 0.0, length(d));
  fragColor = vec4(vColor * fall, 1.0);
}
