// LIQUID: the cover melted into slow, deep currents of its own colors.
// The currents swell with the bass and glint on sharp hits. For quiet
// stretches: intros, breakdowns, ballads.

void main() {
  vec2 p = centered();
  float t = uDrive * 0.06 + uSeed * 17.0;

  // Warp the plane twice over (domain warping) for folds within folds.
  vec2 q = vec2(fbm(p * 1.2 + vec2(0.0, t)), fbm(p * 1.2 + vec2(5.2, 1.3 - t * 0.8)));
  vec2 r = vec2(
    fbm(p * 1.5 + 3.2 * q + vec2(1.7, 9.2) + t * 0.7),
    fbm(p * 1.5 + 3.2 * q + vec2(8.3, 2.8) - t * 0.6)
  );
  float f = fbm(p * 1.8 + 4.0 * r);

  float swell = 1.0 + uBands.x * 0.3 + uBeatPulse * 0.08 * (0.4 + uEnergy);
  vec2 uv = 0.5 + p * 0.6 / swell + (r - 0.5) * (0.7 + uEnergy * 0.5);
  vec3 base = uHasCover > 0.5 ? cover(uv) : palette(r.x * 0.8 + t * 0.2);
  base = saturate3(base, 1.25);

  // Light the ridges of the currents.
  float ridge = smoothstep(0.35, 0.95, f);
  vec3 color = base * (0.35 + 0.9 * ridge);
  color += palette(f * 0.7 + uTime * 0.015) * pow(ridge, 4.0) * (0.25 + 0.9 * uAccent + 0.4 * uBeatPulse * uEnergy);
  // Deep shade in the folds.
  color *= 0.55 + 0.6 * smoothstep(0.1, 0.7, length(q - r) + 0.2);
  color *= 0.75 + 0.4 * uEnergy;
  fragColor = vec4(color, 1.0);
}
