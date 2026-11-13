// KALEIDO: the cover folded into a kaleidoscope that streams out of the
// middle. It turns one step on every beat, each ring lit by its own slice
// of the spectrum, with a flash of color through the folds on each bar.

void main() {
  vec2 p = centered();
  float folds = 6.0 + 2.0 * floor(mod(uSeed * 7.0, 3.0));
  float wedge = TAU / folds;

  // Punch in on the beat; turn half a wedge per beat, landing on it.
  float punch = 1.0 - 0.06 * uBeatPulse * (0.3 + uEnergy) - 0.05 * uDrop;
  p *= punch;
  float r = length(p);
  highp float turned = atan(p.y, p.x) + beatSteps() * wedge * 0.5 + uDrive * 0.02;

  // Fold the angle into one mirrored wedge.
  float a = abs(mod(turned, wedge) - wedge * 0.5);
  vec2 k = vec2(cos(a), sin(a)) * r;

  // Stream outward: the picture comes from the middle.
  highp float flow = uDrive * 0.09;
  highp vec2 uv = k * (1.7 - 0.35 * uBands.x) + vec2(-flow, flow * 0.37) + uSeed;
  vec3 color = uHasCover > 0.5 ? cover(uv) : palette(fbm(uv * 3.0) + uv.x);
  color = saturate3(color, 1.25);

  // Each ring brightens with its band.
  float band = spectrum(r * 1.2);
  color *= 0.4 + 0.85 * band;
  // Glowing seams along the folds.
  float seam = exp(-a * r * 160.0) * (0.15 + 0.8 * uBeatPulse * uEnergy);
  color += palette(r + uBar) * seam;
  // A colored ring races out on each bar.
  float wave = abs(r - uBar * 0.95);
  color += palette(uBeats * 0.05) * exp(-wave * 60.0) * (0.1 + 0.4 * uIntensity);
  // Dark in the very middle, so the eye falls into it.
  color *= smoothstep(0.0, 0.18, r) * 0.85 + 0.15;
  fragColor = vec4(color, 1.0);
}
