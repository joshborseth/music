// HALO: the spectrum bent into a ring of light that breathes with the bass,
// with a shock wave racing out on every beat. Each frame leaves an echo
// that drifts outward and turns, so the rings trail into a vortex.

void main() {
  vec2 p = centered();
  // Where to read the last frame is kept highp: in mediump it would land
  // up to half a pixel off, and the echo would smear a little more each
  // frame.
  highp vec2 uv = gl_FragCoord.xy / uRes;

  // The echo: last frame, pushed out and turned a little. The turn is
  // under a hundredth of a radian, so its sine is the angle itself.
  highp vec2 c = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  c *= 0.975 - 0.02 * uBands.x;
  highp float turn = 0.006 + 0.012 * uBands.y;
  highp float straight = 1.0 - 0.5 * turn * turn;
  c = mat2(straight, turn, -turn, straight) * c;
  highp vec2 back = c / vec2(uRes.x / uRes.y, 1.0) + 0.5;
  vec3 color = texture(uPrev, back).rgb * (0.9 - 0.04 * uDrop);
  color = max(color - 1.0 / 255.0, 0.0);

  float r = length(p);
  float a = atan(p.y, p.x);
  // Mirrored left and right: bass at the bottom, treble at the top.
  float x = abs(a) / PI;
  float level = spectrum(1.0 - x);
  float radius = 0.2 + 0.08 * uBands.x + 0.04 * uBeatPulse;
  float outer = radius + level * 0.22;
  float bar = step(radius, r) * step(r, outer);
  // Separate the ring into spokes.
  float spokes = smoothstep(0.35, 0.1, abs(fract(x * 64.0) - 0.5));
  vec3 lit = palette(x * 0.6 + uTime * 0.02);
  color += lit * bar * spokes * (0.5 + 1.2 * level);
  color += lit * exp(-abs(r - radius) * 220.0) * 0.8;

  // The shock wave of this beat, and a bigger one on each bar.
  float beat = fract(uBeats);
  float front = abs(r - (radius + beat * 0.9));
  color += palette(floor(uBeats) * 0.17) * exp(-front * 120.0) * (1.0 - beat) * (0.4 + 1.2 * uEnergy);
  float barFront = abs(r - (radius + uBar * 1.4));
  color += vec3(1.0) * exp(-barFront * 80.0) * uBarPulse * 0.6;

  // The waveform inside the ring.
  float w = wave(fract(a / TAU + 0.5));
  float inner = abs(r - radius * (0.6 + 0.25 * w));
  color += palette(0.5 + uTime * 0.02) * exp(-inner * 300.0) * (0.3 + uBands.w);
  fragColor = vec4(color, 1.0);
}
