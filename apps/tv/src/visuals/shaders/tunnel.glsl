// TUNNEL: racing down a tunnel lined with the cover. Rings of light are laid
// along it one per beat, so a ring passes you exactly on every beat; the
// walls bulge with the bass and the tunnel bends with the song.

void main() {
  vec2 p = centered();
  float speed = 0.6 + 1.4 * uEnergy + 2.5 * uDrop;
  // The tunnel bends: shift the view by its curve ahead.
  vec2 bend = vec2(sin(uDrive * 0.23), cos(uDrive * 0.17)) * 0.08;
  p -= bend * (1.0 - length(p));
  p *= rot(uDrive * 0.05 + 0.15 * sin(uBeats * PI * 0.25));

  float r = length(p);
  float a = atan(p.y, p.x);
  float sides = 6.0 + 2.0 * floor(mod(uSeed * 5.0, 3.0));
  // A many-sided tunnel, round where the music is soft.
  float edge = cos(PI / sides) / cos(mod(a + PI / sides, TAU / sides) - PI / sides);
  r *= mix(1.0, edge, 0.4 + 0.4 * uIntensity);
  float bulge = 1.0 + 0.25 * spectrum(fract(a / TAU * 2.0)) * uBands.w;
  float depth = 0.35 / max(r * bulge, 0.001);

  // Beats are laid along the tunnel: depth 1 is one beat ahead.
  float beatDepth = depth * 0.5 + uBeats;
  float travel = depth + uDrive * speed * 0.3;
  vec2 uv = vec2(a / TAU * 2.0, travel * 0.35);
  vec3 wall = uHasCover > 0.5 ? cover(uv) : palette(fbm(uv * 4.0) + uv.y * 0.2);
  wall = saturate3(wall, 1.2) * 0.8;
  // Panel seams.
  float seams = smoothstep(0.47, 0.5, abs(fract(a / TAU * sides) - 0.5));
  wall *= 0.55 + 0.6 * spectrum(fract(travel * 0.1)) + seams * 0.6;

  // A ring per beat; brighter on the bar's first beat.
  float ring = abs(fract(beatDepth) - 0.5);
  float isBar = step(mod(floor(beatDepth + 0.5), 4.0), 0.5);
  vec3 ringColor = palette(floor(beatDepth + 0.5) * 0.11);
  wall += ringColor * exp(-(0.5 - ring) * 30.0 / (depth * 0.25 + 0.2)) * (0.4 + 1.0 * isBar) * (0.3 + 0.7 * uEnergy);

  // Fade into the distance, with a light at the end that pulses on the bass.
  float fog = exp(-depth * 0.12);
  vec3 color = wall * fog;
  color += palette(uTime * 0.03) * exp(-r * 9.0) * (0.4 + 1.6 * uBands.x + 2.0 * uDrop);
  fragColor = vec4(color, 1.0);
}
