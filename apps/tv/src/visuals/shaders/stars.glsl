// STARS: flying through a field of stars. They come out of the dark ahead
// and stream past, faster as the music drives; on the beat they surge and
// streak, and a drop throws you through them.
//
// The stars live on a grid around the middle: across, slices of the
// circle; outward, steps of the distance's logarithm, which the stars ride
// out along at a steady pace, so on screen they speed up as they come, as
// stars flown through do. At most one star a cell, worked out from a hash
// (no reads), drawn as a streak along its slice, longer as you surge. The
// last frame, spread out a little and fading, adds an afterglow: one read
// a pixel.

void main() {
  vec2 p = centered();
  // Kept highp: where to read the last frame, which must land on its
  // pixels or the afterglow smears.
  highp vec2 uv = gl_FragCoord.xy / uRes;
  // The afterglow: last frame, spread out from the middle and fading.
  highp vec2 back = 0.5 + (uv - 0.5) * (0.994 - 0.006 * uHit);
  float trail = texture(uPrev, back).a * (0.78 + 0.06 * uEnergy);

  float r = max(length(p), 1e-3);
  // Kept highp: times the slices, mediump would blur where stars sit.
  highp float around = atan(p.y, p.x) / TAU + 0.5;
  // Kept highp: it grows all evening.
  highp float out_ = log(r) * 2.5 - (uDrive * 0.5 + uSeed * 9.0);
  // How long each streak is, in its cell: with the music's drive, and on
  // the beat and in a drop as you surge forward.
  float streak = 0.06 + 0.1 * uEnergy + 0.25 * uHit + 0.3 * uDrop + 0.15 * uSnare;

  float light = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    // Slices of the circle (a whole number, so the grid closes up) and
    // steps outward, finer for the second layer.
    float slices = 36.0 + 28.0 * fi;
    highp vec2 g = vec2(around * slices, out_ * (1.0 + 0.6 * fi) + fi * 0.37);
    // Each slice's steps start a little further out than the last one's,
    // so the stars never line up in rings.
    g.y += fract(floor(g.x) * 0.618034);
    highp vec2 cell = floor(g);
    highp float random = hash12(cell + fi * 57.0);
    vec2 f = vec2(g - cell);
    // Across the slice, and along it: ahead of the star (outward) it is
    // sharp; behind it, toward the middle, it trails off.
    float across = (f.x - 0.2 - 0.6 * random) * 7.0;
    float along = f.y - 0.65 - 0.25 * fract(random * 37.13);
    float tail = along < 0.0 ? streak : 0.04;
    float star = exp(-across * across - along * along / (tail * tail));
    // Under half the cells hold a star, each its own brightness.
    star *= step(0.55, fract(random * 71.3)) * (0.5 + 0.5 * fract(random * 13.7));
    light += star * (0.6 + 0.6 * uLevels[i * 3 + 1]);
  }
  // Out of the dark ahead: none right in the middle, where they bunch up.
  // Every hi-hat makes the field twinkle.
  light *= smoothstep(0.04, 0.3, r) * (1.0 + 0.8 * uHit + 0.6 * uDrop + 0.7 * uHat);
  // A faint haze ahead, where the stars come from.
  light += 0.1 * (0.4 + uEnergy) * exp(-r * r * 9.0);

  // The afterglow holds what was brightest; it never piles up.
  float amount = min(max(trail, light), 1.0);
  // Half the sky's slices are the cover's strong color, half its second,
  // turning slowly; a star and its trail keep their slice, so its color.
  float side = 0.5 + 0.5 * sin(float(around) * TAU * 2.0 + uDrive * 0.02 + uSeed * 6.0);
  fragColor = vec4(glowIn(amount * 0.95, mix(uColorA, uColorD, side * side)), amount);
}
