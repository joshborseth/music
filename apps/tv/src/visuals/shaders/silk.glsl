// SILK: three ribbons of light in the cover's color, the middle one in its
// second color, drifting across the dark like silk in a slow wind. They swell with the bass, flick, widen,
// and brighten on each beat as much as the music is wild, their sheen
// runs along them, and they drift faster as it builds. For quiet
// stretches: intros, breakdowns, ballads.
//
// Soft all over, so it holds up drawn small and stretched to the TV, and
// cheap: one read of the noise worked out ahead (`uFbm`) and a few sines a
// ribbon.

void main() {
  vec2 p = centered();
  // Kept highp: it grows all evening.
  highp float t = uDrive * 0.06 + uSeed * 11.0;
  // The wind bends every ribbon along the way.
  vec2 wind = fbm2(vec2(p.x * 0.55 + t * 0.25, t * 0.15 + uSeed * 3.0)) - 0.5;

  float level = 0.0;
  // How much of the light is the middle ribbon's.
  float second = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // Each ribbon's own slow wave, read as an angle that wraps.
    float swing = fract((t * (0.13 + 0.04 * fi) + fi * 0.33)) * TAU;
    // On the beat each ribbon flicks, as silk does when its end is
    // snapped, and swells.
    float centre = (0.2 + 0.08 * uHit) * sin(p.x * (1.1 + 0.35 * fi) + swing)
      + 0.4 * wind.x * (1.0 + 0.4 * fi)
      + 0.14 * (fi - 1.0);
    // The middle ribbon rides the lead melody, high notes high.
    if (i == 1) centre += 0.35 * (uMelody - 0.5) * uLead;
    float width = (0.05 + 0.03 * sin(p.x * 1.7 - swing + fi) + 0.04 * uBands.x + 0.03 * uBass) * (1.0 + 0.6 * uHit);
    float d = (p.y - centre) / max(width, 0.015);
    float core = exp(-d * d);
    // A sheen running along the ribbon, where it twists toward the light.
    float sheen = 0.5 + 0.5 * sin(p.x * 2.6 - swing * 2.0 + fi * 1.7 + wind.y * 4.0);
    float lit = core * (0.25 + 0.75 * sheen * sheen) * (0.6 - 0.12 * fi);
    level += lit;
    if (i == 1) second = lit;
  }
  float share = second / max(level, 1e-3);
  level *= 0.8 + 0.35 * uEnergy + 0.6 * uHit;
  // A faint haze where the ribbons run.
  level += 0.05 * exp(-p.y * p.y * 5.0);
  fragColor = vec4(glowIn(clamp(level, 0.0, 1.0), mix(uColorA, uColorD, share)), 1.0);
}
