// PARTICLES (background): last frame, dimmed, so moving grains leave short
// trails. The grains are drawn on top by particles.vert.

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 last = texture(uPrev, uv).rgb;
  float keep = 0.6 + 0.25 * uDrop + 0.1 * uTension;
  vec3 color = max(last * keep - 1.0 / 255.0, 0.0);
  // A faint wash of the cover's color behind.
  vec2 p = centered();
  color += palette(0.6) * 0.03 * (1.0 - length(p));
  fragColor = vec4(color, 1.0);
}
