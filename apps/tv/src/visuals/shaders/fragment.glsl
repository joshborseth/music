// Comes after common.glsl in every fragment shader.

in vec2 vUv;
out vec4 fragColor;

// Centered coordinates: y runs -0.5 to 0.5, x keeps the aspect.
vec2 centered() {
  return (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
}
