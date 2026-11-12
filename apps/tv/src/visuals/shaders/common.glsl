// Shared by every shader. The engine puts `#version 300 es` before this
// file, then `fragment.glsl` for fragment shaders, then the shader itself.
// The same files run in the browser lab (apps/tv/visuals-lab), so keep to
// GLSL ES 3.00.

precision highp float;
precision highp sampler2D;

// The picture being drawn, in pixels.
uniform vec2 uRes;
// Seconds since the visuals started, and since this scene came on.
uniform float uTime;
uniform float uSceneTime;
// A clock that runs faster when the music is busier.
uniform float uDrive;
// Beats since the song started (whole part) and how far into this one.
// Anything driven by `uBeats` moves exactly in time with the song.
uniform float uBeats;
// How far into the bar, 0 to 1.
uniform float uBar;
// 1 on each beat and each bar's first beat, falling away quickly.
uniform float uBeatPulse;
uniform float uBarPulse;
// Heard right now: the kick, a sharp hit, and the bass, mids, treble and
// overall level (each 0 to 1).
uniform float uKick;
uniform float uAccent;
uniform vec4 uBands;
// The spectrum in eight coarse bands, low to high: cheaper than the
// texture inside loops.
uniform float uLevels[8];
// How loud this part of the song is, 0 to 1 across the song.
uniform float uEnergy;
// Builds from 0 to 1 over the bars before a drop.
uniform float uTension;
// 1 the moment a drop lands, fading over the next two bars.
uniform float uDrop;
// How intense this section is, 0 calm to 1 wild.
uniform float uIntensity;
// Different for each scene showing, so a scene never looks the same twice.
uniform float uSeed;
// The cover's three most vivid colors.
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
// 1 when the song has a cover.
uniform float uHasCover;

uniform sampler2D uCover;    // the cover, square
uniform sampler2D uSpectrum; // live bands, low to high, across x
uniform sampler2D uHistory;  // the bands over the last few seconds; y = 0 is now
uniform sampler2D uWave;     // the waveform heard now, 0.5 is silence
uniform sampler2D uPrev;     // this scene's last frame
uniform sampler2D uNoise;    // 256 × 256 random values; g is r moved by (37, 17)

const float PI = 3.14159265;
const float TAU = 6.28318531;

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Smooth value noise from the noise texture: cheap on a TV's GPU.
float noise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) / 256.0, 0.0).r;
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (i.xy + vec2(37.0, 17.0) * i.z) + f.xy;
  vec2 rg = textureLod(uNoise, (uv + 0.5) / 256.0, 0.0).rg;
  return mix(rg.r, rg.g, f.z);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise(p);
    p = rot(0.6) * p * 2.03 + 11.7;
    amp *= 0.5;
  }
  return sum / 0.9375;
}

// The cover's colors, cycling smoothly as t goes 0 to 1 and on.
vec3 palette(float t) {
  t = fract(t) * 3.0;
  vec3 a = mix(uColorA, uColorB, smoothstep(0.0, 1.0, t));
  vec3 b = mix(uColorB, uColorC, smoothstep(1.0, 2.0, t));
  vec3 c = mix(uColorC, uColorA, smoothstep(2.0, 3.0, t));
  return t < 1.0 ? a : (t < 2.0 ? b : c);
}

// 0 to 1 and back, so a picture repeats as mirror images instead of seams.
vec2 mirrored(vec2 uv) {
  return 1.0 - abs(1.0 - mod(uv, 2.0));
}

// The cover with y up, like the screen; it repeats as mirror images.
vec3 cover(vec2 uv) {
  vec2 m = mirrored(uv);
  return texture(uCover, vec2(m.x, 1.0 - m.y)).rgb;
}

float spectrum(float x) {
  return texture(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

// The bands `ago` seconds back (0 to 1 is the whole history).
float history(float x, float ago) {
  return texture(uHistory, vec2(clamp(x, 0.0, 1.0), clamp(ago, 0.0, 1.0))).r;
}

float wave(float x) {
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
float beatSteps() {
  float f = fract(uBeats);
  return floor(uBeats) + smoothstep(0.0, 0.22, f);
}
