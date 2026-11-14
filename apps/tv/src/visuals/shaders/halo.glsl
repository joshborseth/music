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

  // The echo holds what was brightest; it never piles up.
  float amount = min(max(echo, light), 1.0);
  float trail = clamp((echo - light) * 4.0, 0.0, 0.85);
  fragColor = vec4(glowIn(amount * 0.95, mix(uColorA, uColorD, trail)), amount);
}
