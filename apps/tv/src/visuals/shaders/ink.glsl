// INK: colored ink poured into moving water. Each frame carries the last one
// along a swirling current; the kick and the beat pour in fresh ink, and a
// drop bursts it out from the middle.

vec2 current(vec2 p, float t) {
  // A swirl without sources or sinks: the curl of a noise field.
  float e = 0.04;
  vec2 s = p * 1.6;
  float n1 = fbm(s + vec2(0.0, e) + t);
  float n2 = fbm(s - vec2(0.0, e) + t);
  float n3 = fbm(s + vec2(e, 0.0) + t);
  float n4 = fbm(s - vec2(e, 0.0) + t);
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

void main() {
  vec2 p = centered();
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uDrive * 0.05 + uSeed * 31.0;

  vec2 flow = current(p, t) * (0.0016 + 0.003 * uEnergy);
  // Breathe outward on the bass and burst on a drop.
  flow += p * (0.002 * uBands.x + 0.02 * uDrop * uDrop);
  vec2 back = uv - flow * vec2(uRes.y / uRes.x, 1.0);
  vec3 ink = texture(uPrev, back).rgb;
  // Fade, with a floor step so the last traces clear in 8-bit color.
  ink = max(ink * (0.988 - 0.01 * uDrop) - 0.8 / 255.0, 0.0);
  // Fresh ink: three pourers circling, each fed by its slice of the music.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float phase = uDrive * (0.21 + 0.07 * fi) + fi * 2.1 + uSeed * 5.0;
    vec2 at = vec2(0.55 * sin(phase * 1.3), 0.32 * cos(phase));
    float level = i == 0 ? uBands.x : (i == 1 ? uBands.y : uBands.z);
    float radius = 0.025 + 0.05 * level + 0.06 * uBeatPulse * step(fi, 0.5);
    float d = length(p - at);
    float pour = exp(-d * d / (radius * radius)) * (0.02 + 0.22 * level + 0.35 * uKick * step(fi, 0.5));
    ink += palette(fi / 3.0 + floor(uBeats / 4.0) * 0.13 + uSeed) * pour;
  }
  // A ring of the waveform at each bar.
  float ring = abs(length(p) - (0.05 + 0.6 * fract(uBar)));
  ink += palette(uBar + 0.5) * uBarPulse * 0.25 * exp(-ring * 90.0);
  // Keep the darks from banding in 8 bits.
  ink += (hash12(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  fragColor = vec4(min(ink, vec3(1.4)), 1.0);
}
