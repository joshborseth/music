// Helpers every shader may use. In fragment shaders they come after
// fragment.glsl, so a plain `float` here is mediump there: arguments that
// may hold a clock or a texture coordinate are marked highp.

mat2 rot(highp float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

highp float hash12(highp vec2 p) {
  highp vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise from the noise texture: cheap on a TV's GPU.
float noise(highp vec2 x) {
  highp vec2 i = floor(x);
  highp vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) / 256.0, 0.0).r;
}

float noise3(highp vec3 x) {
  highp vec3 i = floor(x);
  highp vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  highp vec2 uv = (i.xy + vec2(37.0, 17.0) * i.z) + f.xy;
  vec2 rg = textureLod(uNoise, (uv + 0.5) / 256.0, 0.0).rg;
  return mix(rg.r, rg.g, f.z);
}

// Fractal noise, 0 to 1: four octaves of smooth noise, each about twice
// as fine as the last and turned, read in one go from `uFbm`. It repeats
// every 8 units.
float fbm(highp vec2 p) {
  return textureLod(uFbm, p / 8.0, 0.0).r;
}

// Two fractal noises at once, each 0 to 1: `fbm` and the same noise
// turned a quarter and moved (`uFbm`'s alpha), so they don't follow each
// other, and a point moving one way moves the second noise another.
vec2 fbm2(highp vec2 p) {
  return textureLod(uFbm, p / 8.0, 0.0).ra;
}

// How fast `fbm` rises across and up at `p`, per unit.
vec2 fbmSlope(highp vec2 p) {
  return (textureLod(uFbm, p / 8.0, 0.0).gb - 0.5) * 8.0;
}

// The cover's color, swinging through its shades as t goes 0 to 1 and on:
// A to B, B to C, C back to A, easing in and out of each. Only the pair it
// is between is mixed, as every scene calls this at every pixel.
vec3 palette(highp float t) {
  float s = fract(t) * 3.0;
  float f = fract(s);
  f = f * f * (3.0 - 2.0 * f);
  vec3 from = s < 1.0 ? uColorA : (s < 2.0 ? uColorB : uColorC);
  vec3 to = s < 1.0 ? uColorB : (s < 2.0 ? uColorC : uColorA);
  return mix(from, to, f);
}

// 0 to 1 and back, so a picture repeats as mirror images instead of seams.
highp vec2 mirrored(highp vec2 uv) {
  return 1.0 - abs(1.0 - mod(uv, 2.0));
}

// The cover with y up, like the screen; it repeats as mirror images.
vec3 cover(highp vec2 uv) {
  highp vec2 m = mirrored(uv);
  return texture(uCover, vec2(m.x, 1.0 - m.y)).rgb;
}

float spectrum(highp float x) {
  return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

// The bands `ago` seconds back (0 to 1 is the whole history).
float history(highp float x, highp float ago) {
  return texture(uHistory, vec2(clamp(x, 0.0, 1.0), clamp(ago, 0.0, 1.0))).r;
}

float wave(highp float x) {
  return texture(uWave, vec2(x, 0.5)).r * 2.0 - 1.0;
}

vec3 saturate3(vec3 c, float amount) {
  float grey = dot(c, vec3(0.299, 0.587, 0.114));
  return max(mix(vec3(grey), c, amount), 0.0);
}

// 1 just after each beat, easing back to 0 before the next: for steps that
// land exactly on the beat.
float onBeat(float sharpness) {
  return exp(-fract(uBeats) * sharpness);
}

// Moves one step per beat, snapping quickly then holding.
highp float beatSteps() {
  highp float f = fract(uBeats);
  return floor(uBeats) + smoothstep(0.0, 0.22, f);
}
