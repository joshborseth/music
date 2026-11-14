// HALO: the spectrum bent into a ring of light that breathes with the bass,
// with a shock wave racing out on every beat. Each frame leaves an echo
// that drifts outward and turns, so the rings trail into a vortex.
//
// The light is kept as one amount in the picture's alpha and shown through
// the cover's light (`glowIn`), so the echo fades through the color's own
// shades instead of greying. The ring is the cover's strong color, its
// echo trailing off in the second.

void main() {
  vec2 p = centered();
  // Where to read the last frame is kept highp: in mediump it would land
  // up to half a pixel off, and the echo would smear a little more each
  // frame.
  highp vec2 uv = gl_FragCoord.xy / uRes;

  // The echo: last frame, pushed out and turned a little. The turn is
  // under a hundredth of a radian, so its sine is the angle itself.
  highp vec2 c = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= 0.985 - 0.012 * uBands.x;
  highp float turn = 0.006 + 0.012 * uBands.y;
  highp float straight = 1.0 - 0.5 * turn * turn;
  c = mat2(straight, turn, -turn, straight) * c;
  highp vec2 back = c / vec2(uRes.x / uRes.y, 1.0) + 0.5;
  float echo = texture(uPrev, back).a * (0.8 - 0.05 * uDrop);

  float r = length(p);
  // Mirrored left and right: bass at the bottom, treble at the top.
  float x = abs(atan(p.y, p.x)) / PI;
  float level = spectrum(1.0 - x);
  // The ring jumps out on the beat, and its bars reach further.
  float radius = 0.2 + 0.07 * uBands.x + 0.06 * uHit;
  float outer = radius + 0.03 + level * (0.2 + 0.08 * uHit);
  // The bars, their ends a pixel soft, split into spokes.
  float pixel = 1.5 / uRes.y;
  float bars = smoothstep(radius - pixel, radius + pixel, r)
    * smoothstep(outer + pixel, outer - pixel, r)
    * smoothstep(0.42, 0.22, abs(fract(x * 32.0) - 0.5));
  float light = bars * (0.25 + 0.5 * level) * (1.0 + 0.7 * uHit);
  // The rim, bright on the beat.
  light += exp(-abs(r - radius) * 150.0) * (0.4 + 0.9 * uHit);
  // This beat's shock wave, as strong as the music is wild.
  float beat = fract(uBeats);
  float front = abs(r - (radius + beat * 0.8));
  light += exp(-front * 90.0) * (1.0 - beat) * (0.2 + 0.5 * uEnergy) * (0.4 + 0.6 * uIntensity);
  // Each snare sends a sharper ring of its own, quick and fading: it is
  // as far out as the time since the hit (`uSnare` falls as e^-12t).
  if (uSnare > 0.05) {
    float since = -log(uSnare) / 12.0;
    float snareFront = abs(r - (radius + since * 1.6));
    light += exp(-snareFront * 140.0) * uSnare * 0.8;
  }

  // THE WORDS are the ring's shock wave: as a word lands its outline races
  // out from the letters, and again, fainter, on each beat, as the ring's
  // own wave does; the echo carries each outline away, turning, so the
  // words trail off into the vortex.
#ifdef WORDS
  if (nearWord(WORD_NOW, p, 1.0)) {
    vec4 now = uWordTime[WORD_NOW];
    float field = wordField(WORD_NOW, p);
    float letters = wordInk(field, wordPixel(WORD_NOW, 1.0));
    float outside = step(0.01, field) * (1.0 - letters);
    float land = clamp(now.x / (0.3 + 0.15 * now.z), 0.0, 1.0);
    float wave = exp(-abs(field - (0.5 - 0.48 * land)) * 70.0) * (1.0 - land);
    float beat = fract(uBeats);
    wave += exp(-abs(field - (0.5 - 0.45 * beat)) * 80.0) * (1.0 - beat) * (0.25 + 0.5 * uHit);
    light = max(light, (letters * (0.9 + 0.08 * now.z) + wave * outside) * now.w);
  }
#endif

  // The echo holds what was brightest; it never piles up.
  float amount = min(max(echo, light), 1.0);
  float trail = clamp((echo - light) * 4.0, 0.0, 0.85);
  fragColor = vec4(glowIn(amount * 0.95, mix(uColorA, uColorD, trail)), amount);
}
