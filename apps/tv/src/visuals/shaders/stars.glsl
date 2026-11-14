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

// The stars that make up word i drawn `scale` times its size: one on a
// grid fixed to the word, three pixels apart at its own size, in a share
// `density` of the cells, each its own place in its cell, so they move
// with the word as it gathers or scatters.
float wordStars(int i, highp vec2 p, float scale, float density) {
  vec4 box = uWordBox[i];
  highp vec2 local = (p - box.xy) / scale * (uRes.y / 3.0);
  highp vec2 cell = floor(local);
  highp float random = hash12(cell + uWordRect[i].xy * 997.0);
  vec2 at = vec2(fract(random * 13.7), fract(random * 71.3)) * 0.6 + 0.2;
  vec2 d = vec2(local - cell) - at;
  return exp(-dot(d, d) * 12.0) * step(1.0 - density, fract(random * 37.1));
}

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

  // THE WORDS form out of the starfield: each is stars on a grid fixed to
  // the word, a few pixels apart, that rush in from around it as it is
  // sung, fill in, and burn; when the next word comes they fly apart
  // from its middle and their afterglow streaks away.
#ifdef WORDS
  {
    vec4 now = uWordTime[WORD_NOW];
    float form = smoothstep(-0.06, 0.28, now.x);
    float gather = mix(1.5, 1.0, form);
    if (nearWord(WORD_NOW, p, gather)) {
      float stars = wordStars(WORD_NOW, p, gather, 0.35 + 0.55 * form);
      vec2 letters = wordLetters(WORD_NOW, p, gather, 0.0);
      float fill = letters.x * (0.55 + 0.25 * now.z) * form;
      light = max(light, (max(stars * letters.x, fill) + 0.25 * letters.y * form) * now.w * (1.0 + 0.4 * uHit));
    }
    vec4 before = uWordTime[WORD_BEFORE];
    float apart = 1.0 + 2.2 * before.x;
    if (before.w > 0.0 && before.x < 0.5 && nearWord(WORD_BEFORE, p, apart)) {
      float stars = wordStars(WORD_BEFORE, p, apart, 0.5);
      float letters = wordLetters(WORD_BEFORE, p, apart, 0.15).x;
      light = max(light, stars * letters * exp(-before.x * 6.0) * before.w * 1.4);
    }
  }
#endif

  // The afterglow holds what was brightest; it never piles up.
  float amount = min(max(trail, light), 1.0);
  // Half the sky's slices are the cover's strong color, half its second,
  // turning slowly; a star and its trail keep their slice, so its color.
  float side = 0.5 + 0.5 * sin(float(around) * TAU * 2.0 + uDrive * 0.02 + uSeed * 6.0);
  fragColor = vec4(glowIn(amount * 0.95, mix(uColorA, uColorD, side * side)), amount);
}
