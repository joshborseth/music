// AURORA: curtains of light hanging in the dark, folding slowly in the
// wind. Fine rays run up from a bright hem, each stretch lit by its band
// of the spectrum; on the beat the hem drops and burns, and the curtains
// flare. For calm songs and calm parts, beside Silk and Ink.
//
// Two reads a pixel: the noise worked out ahead (`uFbm`), which folds the
// curtains, and the spectrum. The rest is a few sines.

// One curtain, 0 to 1 and more: its hem at `hem` below this pixel's
// height `y`, burning `edge` bright, its rays at `rays`, rising
// `height` before they fade.
float curtain(float y, float hem, float edge, float rays, float height) {
  float above = y - hem;
  // The light spills a little below the hem, and rises in rays above it.
  float lit = smoothstep(-0.05, 0.0, above);
  float up = max(above, 0.0);
  return lit * (exp(-up / height) * rays + exp(-up * 25.0) * edge);
}

void main() {
  vec2 p = centered();
  // Kept highp: they grow all evening.
  highp float t = uDrive * 0.05 + uSeed * 13.0;
  // How the curtains fold, moving slowly along them.
  vec2 fold = fbm2(vec2(p.x * 0.6 + t * 0.3, t * 0.1 + uSeed * 7.0));
  // Where along the curtain this pixel hangs: the folds bend it. Kept
  // highp, as the rays are worked out from it seventy times over.
  highp float along = p.x + (fold.x - 0.5) * 1.1;
  highp float rayAt = along * 70.0 + t * 1.5;
  float sway = float(fract(t * 0.2)) * TAU;
  // Rays, fine and uneven, as two waves along the curtain beat against
  // each other and the folds brighten some stretches more than others.
  float fine = (0.5 + 0.5 * sin(rayAt)) * (0.5 + 0.5 * sin(rayAt * 0.53 + 2.0));
  float rays = (0.3 + 0.7 * fine) * (0.4 + 1.2 * fold.y * fold.y);
  // Each stretch lit by its band: bass in the middle, treble at the sides.
  float band = 0.4 + 0.9 * spectrum(abs(along) * 1.1);
  // Tall when the music is loud, a little taller on the beat.
  float height = 0.14 + 0.2 * uEnergy + 0.08 * uHit;

  // The front curtain, its hem in wide folds, dropping on the beat; and a
  // fainter one further off, higher up, folding the other way.
  float hem = -0.16 + 0.16 * sin(p.x * 1.7 + sway) + 0.25 * (fold.y - 0.5) - 0.05 * uHit;
  float level = curtain(p.y, hem, 0.6, rays, height) * band * (1.0 + 0.6 * uHit);
  float far = 0.08 + 0.12 * sin(p.x * 1.1 - sway + 2.0) + 0.2 * (fold.x - 0.5);
  level += 0.22 * curtain(p.y, far, 0.15, 1.0 - 0.5 * fine, height * 1.5);

  level *= 0.75 + 0.3 * uEnergy + 0.3 * uHit;
  fragColor = vec4(glow(clamp(level, 0.0, 1.0)), 1.0);
}
