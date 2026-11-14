// TUNNEL: racing down a tunnel of light. A ring of light is laid along it
// for every beat, so a ring passes you exactly on each beat, brighter on
// the bar's first; lines run along the walls, lit by the spectrum around
// them; the tunnel bends and turns with the song, and races on a drop.
//
// With the song's score, the tunnel is the music still to come: a ring
// for each kick the song really has, laid where it will be heard, so
// fills, stops, and syncopation come at you as gaps and bunches; the walls
// lit by the spectrum that is coming; a flash along them on each snare.
//
// Light and dark only: the rings in the cover's strong color, the lines in
// its second. No picture to smear when it is drawn small, and few sums a
// pixel.

// How the tunnel bends (x, y) and the cosine and sine of its spin, worked
// out once a frame (motion.rs).
uniform vec4 uTurn;

void main() {
  vec2 p = centered();
  // The tunnel bends: shift the view by its curve ahead.
  p -= uTurn.xy * (1.0 - length(p));
  p *= mat2(uTurn.z, uTurn.w, -uTurn.w, uTurn.z);

  float r = max(length(p), 0.002);
  float around = atan(p.y, p.x) / TAU + 0.5;
  // Kept highp, with what is worked out from it: deep in the middle it
  // runs to hundreds, and the beat count is added to it.
  highp float depth = 0.32 / r;
  // Beats are laid along the tunnel: depth 1 is one beat ahead.
  highp float beat = depth + uBeats;
  highp float which = floor(beat + 0.5);
  float ring = abs(fract(beat) - 0.5) * 2.0;
  // Sharp near you, wider deep in, where rings bunch up and would shimmer.
  float width = 0.07 + 0.05 * depth;
  float rings = smoothstep(1.0 - width, 1.0, ring);
  float isBar = step(mod(which, 4.0), 0.5);
  // A ring flares as it passes you, and more on a drop.
  float passing = exp(-max(depth - 0.6, 0.0) * 1.2);
  rings *= (0.35 + 0.65 * isBar) * (0.5 + 0.5 * uEnergy) * (1.0 + 2.0 * passing * uHit);
  // The kicks themselves, from the score, at the time each depth will be
  // heard (one beat a unit of depth). Six seconds ahead is all it holds.
  highp float ahead = depth * uBeatSeconds;
  float scored = hasScore() * uDrums * step(ahead, 5.8);
  if (scored > 0.0) {
    float kicks = score(SCORE_KICK, ahead);
    kicks = smoothstep(0.25, 0.9, kicks) * (0.6 + 0.6 * uEnergy) * (1.0 + 2.0 * passing * uHit);
    rings = mix(rings, kicks, scored);
  }

  // Lines along the walls, each lit by its stretch of the spectrum.
  float sides = 12.0 + 4.0 * floor(mod(uSeed * 5.0, 3.0));
  float lane = abs(fract(around * sides) - 0.5) * 2.0;
  float lines = smoothstep(1.0 - 0.08 - 0.03 * depth, 1.0, lane);
  float x = abs(around - 0.5) * 2.0;
  float band = hasScore() > 0.0 ? futureSpectrum(x, min(ahead, 5.8)) : spectrum(x);
  lines *= (0.15 + 0.9 * band * band) * (1.0 + 0.8 * uHit + 1.2 * uSnare + 0.4 * uHat);

  // Fade into the distance.
  float fog = exp(-depth * 0.22);
  float level = (rings + lines) * fog;
  float share = lines / max(rings + lines, 1e-3);
  vec3 color = glowIn(clamp(level, 0.0, 0.92), mix(uColorA, uColorD, share));
  // A light at the end, in the color itself, swelling with the bass and
  // the beat, and bursting on a drop.
  color += uColorA * exp(-r * 9.0) * (0.25 + 0.5 * uBands.x + 0.6 * uHit + 0.9 * uDrop);
  // The lead melody glows down there too, in the second color, brighter
  // as it climbs.
  color += uColorD * exp(-r * 14.0) * uLead * (0.2 + 0.4 * uMelody);

  // THE WORDS fly at you out of the tunnel: each comes from far off,
  // small and dim, lands full size as it is sung, and rushes past you as
  // the next one comes, leaving a streak (the last frame's words, kept in
  // the alpha, read a little nearer the word's middle). The letters burn
  // in the rings' light over a dark halo, so they read over the lines.
  float word = 0.0;
#ifdef WORDS
  {
    highp vec2 q = centered();
    highp vec2 uv = gl_FragCoord.xy / uRes;
    float halo = 0.0;
    vec4 now = uWordTime[WORD_NOW];
    float hook = now.z;
    if (nearWord(WORD_NOW, q, 1.15)) {
      float arrive = smoothstep(-0.04, 0.16 + 0.08 * hook, now.x);
      float scale = mix(0.25, 1.0, arrive) + 0.03 * clamp(now.x, 0.0, 2.0);
      vec2 letters = wordLetters(WORD_NOW, q, scale, 0.03 * (1.0 - arrive));
      word = letters.x * (0.45 + 0.5 * arrive + 0.15 * uHit) * now.w;
      halo = letters.y * now.w;
    }
    vec4 before = uWordTime[WORD_BEFORE];
    float past = before.x;
    float scale = 1.03 + 3.0 * past + 8.0 * past * past;
    if (before.w > 0.0 && past < 0.3 && nearWord(WORD_BEFORE, q, scale)) {
      vec2 letters = wordLetters(WORD_BEFORE, q, scale, 0.02);
      word = max(word, letters.x * exp(-past * 12.0) * before.w);
    }
    // The streak, behind the letters.
    vec4 box = uWordBox[WORD_NOW];
    if (nearWord(WORD_NOW, q, 2.0) || nearWord(WORD_BEFORE, q, 2.0)) {
      highp vec2 middle = (box.xy * vec2(uRes.y / uRes.x, 1.0)) + 0.5;
      highp vec2 back = middle + (uv - middle) * 0.94;
      word = max(word, texture(uPrev, back).a * 0.72);
    }
    color *= 1.0 - 0.8 * halo;
    color += glowIn(min(word, 1.0) * 0.97, mix(uColorA, uColorD, 0.35 - 0.35 * hook)) * (1.0 + 0.4 * hook);
  }
#endif
  fragColor = vec4(color, word);
}
