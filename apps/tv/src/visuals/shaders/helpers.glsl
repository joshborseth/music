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

// The cover's colors, swinging as t goes 0 to 1 and on: the strong color,
// the second color a little deep, the strong color deeper, and back,
// easing in and out of each. Only the pair it is between is mixed.
vec3 palette(highp float t) {
  float s = fract(t) * 3.0;
  float f = fract(s);
  f = f * f * (3.0 - 2.0 * f);
  vec3 second = uColorD * 0.8;
  vec3 from = s < 1.0 ? uColorA : (s < 2.0 ? second : uColorB);
  vec3 to = s < 1.0 ? second : (s < 2.0 ? uColorB : uColorA);
  return mix(from, to, f);
}

// Light in the color `hue` (one at full strength), 0 to 1: near black,
// through its deep shade and the full color, to a pale, hot core. One hue
// throughout, so a scene shaded with it looks lit rather than painted.
vec3 glowIn(float x, vec3 hue) {
  vec3 color = mix(hue * 0.03, hue * 0.525, smoothstep(0.0, 0.45, x));
  color = mix(color, hue, smoothstep(0.35, 0.8, x));
  return mix(color, mix(hue, vec3(1.0), 0.3), smoothstep(0.8, 1.0, x));
}

// Light in the cover's strong color.
vec3 glow(float x) {
  return glowIn(x, uColorA);
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

// The song's score (music.rs, `AHEAD_ROWS` rows of `SCORE_COLUMNS`): what
// the music does from a moment ago to six seconds ahead, worked out by the
// server from the whole song. What a scene draws from it at `ahead`
// seconds arrives exactly as that music plays. 0 without a score.
const float SCORE_COLUMNS = 32.0;
const float SCORE_ROWS = 128.0;
const float SCORE_DRUMS = 24.0;
const float SCORE_KICK = 25.0;
const float SCORE_SNARE = 26.0;
const float SCORE_HAT = 27.0;
const float SCORE_BASS = 28.0;
const float SCORE_LEAD = 29.0;
const float SCORE_MELODY = 30.0;
const float SCORE_BRIGHT = 31.0;

highp float scoreRow(highp float ahead) {
  return (uScoreBehind + uScoreShift + ahead * uScoreRate + 0.5) / SCORE_ROWS;
}

// One column of the score, `ahead` seconds from now (negative: past).
float score(float column, highp float ahead) {
  return texture(uScore, vec2((column + 0.5) / SCORE_COLUMNS, scoreRow(ahead))).r;
}

// The spectrum `ahead` seconds from now, x from low (0) to high (1).
float futureSpectrum(highp float x, highp float ahead) {
  highp float u = (0.5 + clamp(x, 0.0, 1.0) * 23.0) / SCORE_COLUMNS;
  return texture(uScore, vec2(u, scoreRow(ahead))).r;
}

// 1 when the song has a score.
float hasScore() {
  return step(0.001, uScoreRate);
}

// SHATTER's shards (`shards.glsl` works them out, `final.glsl` reads
// them): the sheet's shards are smaller toward the middle, so it is read
// at the square root of the distance from it (no `pow`, which a TV's GPU
// and the lab's software renderer both pay for), and back.
const float SHARDS = 3.0;
// The shard texture keeps a cell plus this in a byte.
const float SHARD_CELL_BIAS = 8.0;
highp vec2 toShards(highp vec2 p) {
  return p * sqrt(inversesqrt(max(dot(p, p), 1e-6))) * SHARDS;
}
highp vec2 fromShards(highp vec2 g) {
  return g * length(g) / (SHARDS * SHARDS);
}
// Where in the noise texture a change's shards read, from its seed.
ivec2 shardShift(float seed) {
  return ivec2(128.0 + seed * 61.0);
}
// The noise texture's values for the shard of cell `n`: its point, its
// turn, its tilt.
vec4 shard(highp vec2 n, ivec2 shift) {
  return texelFetch(uNoise, (ivec2(n) + shift) & 255, 0);
}

// THE WORDS being sung (words.rs): three words, `WORD_NOW` the one sung
// now, `WORD_NEXT` the next, `WORD_BEFORE` the one it replaced, each a
// signed distance field in the atlas `uWords`. A word's rect is where it
// lies in the atlas (texture units, y down); its box where it sits in
// `centered()` units (middle, then half its width and height); its time:
// seconds since it started (the one before: since the one now started;
// the next: negative until it starts), how far through it is, how big a
// hook it is (0, 0.6 for a hook line, 1 for the song's phrase), and how
// much it shows. `uWordAtlas`: the atlas's size in pixels, its field's
// spread, and 1 when any word shows. A scene draws its words between
// `#ifdef WORDS` and `#endif`: each is compiled with and without them, and
// the frames without a word showing use the one without, so the words
// cost nothing then, whatever the GPU makes of a branch.
const int WORD_NOW = 0;
const int WORD_NEXT = 1;
const int WORD_BEFORE = 2;
// highp: the vertex shaders that take these helpers (Terrain's land,
// Diorama's relief) declare them highp by default, and a uniform must be
// declared alike in both stages.
uniform highp vec4 uWordRect[3];
uniform highp vec4 uWordBox[3];
uniform highp vec4 uWordTime[3];
uniform highp vec4 uWordAtlas;
uniform sampler2D uWords;

// Word i's field at `p` (centered units): 0.5 on the letters' edge, more
// inside, falling to 0 a spread outside, and 0 outside its box. One read,
// and only inside the box.
float wordField(int i, highp vec2 p) {
  vec4 box = uWordBox[i];
  if (box.z <= 0.0) return 0.0;
  highp vec2 q = (p - box.xy) / box.zw;
  if (abs(q.x) >= 1.0 || abs(q.y) >= 1.0) return 0.0;
  highp vec4 rect = uWordRect[i];
  highp vec2 uv = rect.xy + vec2(0.5 + 0.5 * q.x, 0.5 - 0.5 * q.y) * rect.zw;
  return textureLod(uWords, uv, 0.0).r;
}

// Word i's field at `p`, the word drawn `scale` times its size about its
// middle.
float wordFieldScaled(int i, highp vec2 p, float scale) {
  highp vec2 middle = uWordBox[i].xy;
  return wordField(i, middle + (p - middle) / scale);
}

// How much word i's field changes across one pixel of this picture, drawn
// `scale` times its size: an edge this soft is crisp.
float wordPixel(int i, float scale) {
  return uWordRect[i].w * uWordAtlas.y / (2.0 * uWordBox[i].w * scale * uRes.y)
    * 128.0 / (255.0 * uWordAtlas.z);
}

// The letters from a field: 1 inside, 0 outside, the edge `soft` wide in
// the field's units (`wordPixel` is crisp).
float wordInk(float field, float soft) {
  return smoothstep(0.5 - soft, 0.5 + soft, field);
}

// Word i drawn `scale` times its size about its middle, at `p`: x is the
// letters (1 inside, crisp, or `soft` wider at the edge), y a halo, 1 at
// the letters' edge and fading to 0 a spread outside them.
vec2 wordLetters(int i, highp vec2 p, float scale, float soft) {
  float field = wordFieldScaled(i, p, scale);
  return vec2(wordInk(field, wordPixel(i, scale) + soft), smoothstep(0.0, 0.5, field));
}

// Whether `p` is within `reach` of word i's box (its own units): to skip
// all of a scene's word work far from the words.
bool nearWord(int i, highp vec2 p, float reach) {
  vec4 box = uWordBox[i];
  return box.z > 0.0 && uWordTime[i].w > 0.0
    && all(lessThan(abs(p - box.xy), box.zw * reach));
}

// The words as soft light, for the calm scenes (Silk, Aurora): the word
// sung now comes up gently and is lit by `level`, the scene's own light
// where it is, glowing faintly around; the one before fades away. Returns
// the light the words add.
float softWords(highp vec2 p, float level) {
  float light = 0.0;
  if (nearWord(WORD_NOW, p, 1.0)) {
    vec4 now = uWordTime[WORD_NOW];
    float come = smoothstep(0.0, 0.3, now.x);
    vec2 letters = wordLetters(WORD_NOW, p, 1.0, 0.06 * (1.0 - come) + 0.015);
    light = (letters.x * (0.75 + 0.2 * now.z + 0.4 * level) * come + 0.18 * letters.y) * now.w;
  }
  if (nearWord(WORD_BEFORE, p, 1.0)) {
    vec4 before = uWordTime[WORD_BEFORE];
    vec2 letters = wordLetters(WORD_BEFORE, p, 1.0, 0.04 + 0.1 * before.x);
    light = max(light, letters.x * 0.6 * exp(-before.x * 20.0) * before.w);
  }
  return light;
}
