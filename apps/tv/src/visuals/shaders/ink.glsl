// INK: colored ink poured into moving water. Each frame carries the last one
// along a swirling current; the kick and the beat pour in fresh ink, and a
// drop bursts it out from the middle.

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
  vec3 ink = texture(uPrev, back).rgb;
  // Fade, with a floor step so the last traces clear in 8-bit color.
  ink = max(ink * (0.988 - 0.01 * uDrop) - 0.8 / 255.0, 0.0);
  // Fresh ink: three pourers circling, each fed by its slice of the music.
  highp float shade = floor(uBeats / 4.0) * 0.13 + uSeed;
  for (int i = 0; i < 3; i++) {
    vec4 pourer = uPour[i];
    vec2 d = p - pourer.xy;
    float pour = exp(-dot(d, d) / (pourer.z * pourer.z)) * pourer.w;
    ink += palette(float(i) / 3.0 + shade) * pour;
  }
  // A ring of the waveform at each bar.
  float ring = abs(length(p) - (0.05 + 0.6 * fract(uBar)));
  ink += palette(uBar + 0.5) * uBarPulse * 0.25 * exp(-ring * 90.0);
  // Keep the darks from banding in 8 bits.
  ink += (hash12(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  fragColor = vec4(min(ink, vec3(1.4)), 1.0);
}
