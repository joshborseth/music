// PARTICLES (points): the cover rebuilt from glowing grains, one per pixel
// of a small copy. Bright parts stand out toward you, the bass makes the
// picture breathe, a ripple crosses it on every beat, the grains tremble
// and draw in before a drop, then blow apart when it lands and drift back.

uniform float uGrid; // grains along each side

out vec3 vColor;

void main() {
  float id = float(gl_VertexID);
  vec2 cell = vec2(mod(id, uGrid), floor(id / uGrid));
  vec2 st = (cell + 0.5) / uGrid;
  vec3 color = uHasCover > 0.5
    ? textureLod(uCover, vec2(st.x, 1.0 - st.y), 0.0).rgb
    : palette(st.x * 0.5 + st.y * 0.3 + uTime * 0.02);
  float lum = dot(color, vec3(0.299, 0.587, 0.114));

  vec3 home = vec3((st - 0.5) * 0.9, 0.0);
  home.z = -(lum - 0.4) * (0.12 + 0.45 * uBands.x);
  float r = length(home.xy);
  home.z -= 0.07 * uBeatPulse * sin(r * 22.0 - fract(uBeats) * TAU) * (0.3 + uEnergy);

  vec3 seed = vec3(st * 5.0, uDrive * 0.08 + uSeed * 9.0);
  vec3 flow = vec3(noise3(seed), noise3(seed + 19.1), noise3(seed + 47.3)) - 0.5;
  float scatter = 0.03 + 0.22 * uEnergy * uIntensity + 0.15 * uAccent;
  vec3 at = home + flow * scatter;

  // Before a drop: draw in and tremble. On it: blow apart.
  at.xy *= 1.0 - 0.35 * uTension * uTension;
  at += (vec3(hash12(st * 91.0 + uTime), hash12(st * 37.0 - uTime), 0.5) - 0.5) * 0.03 * uTension;
  vec3 out_ = normalize(home + flow * 0.8 + vec3(0.0, 0.0, -0.3));
  at += out_ * uDrop * uDrop * 1.6;

  at.xz = rot(0.45 * sin(uDrive * 0.09 + uSeed * 4.0)) * at.xz;
  at.yz = rot(0.22 * sin(uDrive * 0.07)) * at.yz;

  float w = at.z + 1.5;
  vec2 screen = at.xy / max(w, 0.05) * 1.5;
  gl_Position = vec4(screen.x * 2.0 * uRes.y / uRes.x, screen.y * 2.0, 0.0, 1.0);
  gl_PointSize = clamp(uRes.y / uGrid * 1.5 * 1.5 / w, 1.0, 48.0);

  float band = spectrum(st.x * 0.8 + 0.1);
  vColor = saturate3(color, 1.3) * (0.22 + 0.35 * band + 0.25 * uBeatPulse + 0.3 * uDrop);
}
