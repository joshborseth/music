// Shared by every shader. The engine puts `#version 300 es` before this
// file, then `fragment.glsl` for fragment shaders, then `helpers.glsl`, then
// the shader itself. The same files run in the browser lab
// (apps/tv/visuals-lab), so keep to GLSL ES 3.00.
//
// Every uniform is highp: clocks like `uTime` and `uDrive` grow all
// evening, and in mediump a clock at 1000 seconds only counts half seconds.
// Math on a highp uniform runs in highp, but storing its result in a plain
// (mediump) variable in a fragment shader drops the precision again, so
// anything that grows with time, or becomes a texture coordinate, is kept
// in a `highp` variable.

precision highp float;
precision mediump sampler2D;

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
// How hard the beat hits the picture, 0 to 1 (motion.rs, `hit`): the kick,
// softened in calm music. What every scene punches, swells, and brightens
// with on the beat, so a ballad's beat only nods.
uniform float uHit;
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
// The cover's strong color: full strength, a little deeper, and deep.
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
// The cover's second color, at full strength: another hue the cover holds
// plenty of, or, when it has one hue only, a neighbor of it (look.rs).
// Each scene lights one part of itself in it, so no two look alike.
uniform vec3 uColorD;
// 1 when the song has a cover.
uniform float uHasCover;

uniform sampler2D uCover;    // the cover, square
uniform sampler2D uSpectrum; // live bands, low to high, across x
uniform sampler2D uHistory;  // the bands over the last few seconds; y = 0 is now
uniform sampler2D uWave;     // the waveform heard now, 0.5 is silence
uniform sampler2D uPrev;     // this scene's last frame
uniform sampler2D uNoise;    // 256 × 256 random values; g is r moved by (37, 17)
// Fractal noise, worked out ahead (`gpu::fbm_pixels`): r is the value, g
// and b its slope across and up. It repeats every 8 units; see `fbm`.
uniform sampler2D uFbm;

const float PI = 3.14159265;
const float TAU = 6.28318531;
