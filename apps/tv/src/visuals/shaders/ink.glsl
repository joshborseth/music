// INK: luminous ink poured into moving water. Each frame carries the last
// one along a swirling current; the bass and the kick pour in fresh ink,
// and a drop bursts it out from the middle.
//
// The ink is kept as one amount in the picture's alpha, and shown through
// the cover's light (`glow`): thin ink is the deep shade, thick ink burns
// to a pale core. One hue throughout, never muddy where colors pile up.

// Each pourer's place, size, and how much it pours this frame (motion.rs).
uniform vec4 uPour[3];

void main() {
  vec2 p = centered();
  highp vec2 uv = gl_FragCoord.xy / uRes;
  highp float t = uDrive * 0.05 + uSeed * 31.0;

  // A swirl without sources or sinks: the curl of a noise field, from its
  // slope worked out ahead (`uFbm`).
  vec2 slope = fbmSlope(p * 1.6 + t);
  vec2 flow = vec2(slope.y, -slope.x) * (0.0016 + 0.003 * uEnergy);
  // Breathe outward on the bass and burst on a drop.
  flow += p * (0.002 * uBands.x + 0.02 * uDrop * uDrop);
  highp vec2 back = uv - flow * vec2(uRes.y / uRes.x, 1.0);
  float ink = texture(uPrev, back).a;
  // Fade, with a floor step so the last traces clear in 8 bits.
  ink = max(ink * (0.986 - 0.01 * uDrop) - 0.6 / 255.0, 0.0);
  // Fresh ink: three pourers circling, each fed by its slice of the music.
  for (int i = 0; i < 3; i++) {
    vec4 pourer = uPour[i];
    vec2 d = p - pourer.xy;
    ink += exp(-dot(d, d) / (pourer.z * pourer.z)) * pourer.w * (0.5 - 0.1 * float(i));
  }
  // A ripple out from the middle on each bar, gone a moment after it.
  if (uBarPulse > 0.004) {
    float ring = abs(length(p) - (0.05 + 0.6 * fract(uBar)));
    ink += uBarPulse * 0.12 * exp(-ring * 60.0);
  }
  // Keep the thin ink from banding in 8 bits.
  ink = clamp(ink + (hash12(gl_FragCoord.xy + uTime) - 0.5) / 255.0, 0.0, 1.0);
  fragColor = vec4(glow(ink * 0.95), ink);
}
