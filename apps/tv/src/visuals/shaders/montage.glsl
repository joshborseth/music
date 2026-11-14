// MONTAGE: the song's own pictures (key frames of its music video, or the
// artist's photos and covers), cut on the beat like a VJ cutting the
// official video live. Which picture shows, where the camera sits on it,
// and how each cut is graded are worked out once a frame (montage.rs,
// `Cutter`); here every picture is graded into the visuals' look so it
// never reads as raw video:
//
// - a duotone in the cover's color (its light running from near black
//   through the color to a pale core) or a tritone (shadows in the deep
//   shade, mids in the second color, highs pale), keeping a hint of the
//   picture's own hues, its blacks crushed;
// - at times a halftone print (dots sized by the light) or a posterized
//   one (five steps of light), or the screen split into strips of
//   different pictures;
// - a punch in on each kick and on each cut, the colors split on the
//   snare, the picture before echoing through the last frame (`uPrev`),
//   smearing outward through a drum fill;
// - the live spectrum cut into the bottom as bars of negative, when the
//   music is intense.
//
// The atlas holds `uMontageGrid.z` pictures, `uMontageGrid.x` across, row
// by row from the top; each fills the screen (cropped to it), the camera
// moving across it in calm music (Ken Burns).

uniform sampler2D uMontage;
// Columns, rows, pictures, a cell's width over its height.
uniform vec4 uMontageGrid;
// The picture showing and the one before it: index, camera x and y (in
// the picture's units), zoom.
uniform vec4 uMontageA;
uniform vec4 uMontageB;
// Seconds since the cut, how hard it landed (0 to 1), the grade (0
// duotone, 1 tritone, 2 halftone, 3 posterized), strips across (1 to 3).
uniform vec4 uMontageCut;
// The echo of past frames, how far blacks are crushed, how much of the
// spectrum is cut in, how much of the picture's own color shows.
uniform vec4 uMontageMix;
// How much the light of the picture showing is raised or lowered, so dark
// and bright pictures grade alike; then half a texel of the atlas, in a
// cell's units, across and down.
uniform vec4 uMontageTone;

// Where `uv` (0 to 1 across the picture, y up, mirrored past its edges)
// of picture `picture` is in the atlas, kept half a texel inside its cell.
highp vec2 atlasUv(float picture, highp vec2 uv) {
  float column = mod(picture, uMontageGrid.x);
  float row = floor((picture + 0.5) / uMontageGrid.x);
  highp vec2 inset = uMontageTone.zw;
  highp vec2 m = mirrored(uv);
  highp vec2 inCell = clamp(vec2(m.x, 1.0 - m.y), inset, 1.0 - inset);
  return (vec2(column, row) + inCell) / uMontageGrid.xy;
}

// Where the screen point `p` (centered, y -0.5 to 0.5) falls on a picture
// as tall as the screen, seen through `camera` (x, y, zoom): 0 to 1 across
// it. A square one (a cover) leaves room each side, where it shows
// mirrored and dimmed (`sides`).
highp vec2 onPicture(highp vec2 p, vec3 camera) {
  highp vec2 uv = vec2(p.x / uMontageGrid.w, p.y);
  return uv / camera.z + camera.xy + 0.5;
}

float lightOf(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// The picture's light graded into the look: duotone or tritone.
vec3 tone(float l, float look) {
  if (look > 0.5 && look < 1.5) {
    vec3 tri = mix(uColorC * 0.1, uColorD * 0.85, smoothstep(0.02, 0.5, l));
    return mix(tri, mix(uColorA, vec3(1.0), 0.2), smoothstep(0.5, 1.0, l));
  }
  return glowIn(l, uColorA);
}

// How bright a read pixel is once its light is evened out (`gain`), its
// blacks crushed, and its contrast raised.
float crushed(vec3 raw, float gain) {
  float l = smoothstep(uMontageMix.y, 0.96, lightOf(raw) * gain);
  return mix(l, l * l * (3.0 - 2.0 * l), 0.5);
}

void main() {
  highp vec2 p = centered();
  float age = uMontageCut.x;
  float strength = uMontageCut.y;
  float look = uMontageCut.z;
  float strips = uMontageCut.w;
  float count = uMontageGrid.z;
  float gain = uMontageTone.x;

  // The strips: each its own picture, seen through its own middle.
  float picture = uMontageA.x;
  float edge = 1.0;
  if (strips > 1.5) {
    highp float across = vUv.x * strips;
    float strip = floor(across);
    picture = mod(picture + strip * 7.0, count);
    p.x = (fract(across) - 0.5) * (uRes.x / uRes.y) / strips;
    p.y += (strip - 1.0) * 0.04;
    // A dark seam between strips.
    float seam = min(fract(across), 1.0 - fract(across)) * uRes.x / strips;
    edge = smoothstep(1.0, 3.0, seam);
  }

  // Punch in on the kick, and harder on the cut, settling at once; creep
  // in as a drop builds.
  float punch = (1.0 + 0.06 * uHit + 0.14 * strength * exp(-age * 9.0)) * (1.0 + 0.22 * uTension);
  vec3 camera = vec3(uMontageA.yz, uMontageA.w * punch);
  highp vec2 uv = onPicture(p, camera);

  vec3 color;
  if (look > 2.5) {
    // POSTERIZED: five steps of light.
    float l = crushed(texture(uMontage, atlasUv(picture, uv)).rgb, gain);
    float steps = floor(l * 4.0 + 0.5) / 4.0;
    color = tone(steps, 1.0 - step(0.5, fract(picture * 0.5)));
  } else if (look > 1.5) {
    // HALFTONE: dots on a turned grid, each as large as the light under
    // its middle, read once a dot.
    highp vec2 grid = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p * (34.0 + 12.0 * uIntensity);
    highp vec2 cell = floor(grid) + 0.5;
    highp vec2 middle = mat2(0.7071, -0.7071, 0.7071, 0.7071) * cell / (34.0 + 12.0 * uIntensity);
    float l = crushed(texture(uMontage, atlasUv(picture, onPicture(middle, camera))).rgb, gain);
    float radius = 0.62 * sqrt(l);
    float d = length(grid - cell);
    float ink = smoothstep(radius + 0.08, radius - 0.08, d);
    color = mix(uColorC * 0.06, tone(0.35 + 0.65 * l, 0.0), ink);
  } else {
    // DUOTONE or TRITONE, a hint of the picture's own hues kept, the red
    // split off to one side on the snare (one more read).
    vec3 raw = texture(uMontage, atlasUv(picture, uv)).rgb;
    float l = crushed(raw, gain);
    color = tone(l, look);
    if (uSnare > 0.04) {
      highp vec2 shift = vec2(0.022 * uSnare / camera.z, 0.0);
      float red = crushed(texture(uMontage, atlasUv(picture, uv + shift)).rgb, gain);
      color.r = tone(red, look).r;
    }
    float rawLight = max(lightOf(raw), 0.04);
    color = mix(color, min(color * raw / rawLight, vec3(1.4)), uMontageMix.w);
  }

  // The cut lands bright, then settles.
  // Past a cover's edges, its mirror images are dimmed.
  float sides = step(0.5, abs(uv.x - 0.5));
  color *= edge * (1.0 - 0.6 * sides) * (1.0 + 0.4 * strength * exp(-age * 7.0));

  // The live spectrum cut into the bottom, as bars of negative (read only
  // where a bar may reach).
  if (uMontageMix.z > 0.0 && vUv.y < 0.4 * uMontageMix.z) {
    float bars = 28.0;
    float bar = floor(vUv.x * bars);
    float level = spectrum((bar + 0.5) / bars);
    float inBar = step(vUv.y, level * level * 0.4 * uMontageMix.z) *
      step(0.18, fract(vUv.x * bars));
    color = mix(color, abs(uColorD * 0.9 - color), inBar);
  }

  // The frames before echo through, a little larger each time: the
  // picture before a cut lingers as a ghost, and trails smear outward
  // through a fill.
  highp vec2 back = 0.5 + (vUv - 0.5) * (0.988 - 0.025 * uFill);
  float echo = uMontageMix.x + 0.45 * exp(-age * 14.0) * step(0.5, abs(uMontageB.x - uMontageA.x));
  color = max(color, texture(uPrev, back).rgb * min(echo, 0.85));

  // THE WORDS (words.rs) cut into the picture: a word is knocked out of
  // it, its letters a flat negative of what is under them; a hook word
  // masks it instead, the picture showing only through its letters, and
  // the rest comes back as the word goes on.
#ifdef WORDS
  {
    vec4 now = uWordTime[WORD_NOW];
    // Where the word sits on the screen (the strips move `p`).
    highp vec2 q = centered();
    if (now.w > 0.0) {
      vec2 letters = nearWord(WORD_NOW, q, 1.0) ? wordLetters(WORD_NOW, q, 1.0, 0.0) : vec2(0.0);
      if (now.z > 0.5) {
        float mask = now.w * (1.0 - smoothstep(0.3, 1.0, now.x));
        color = mix(color, color * mix(0.1, 1.3, letters.x) + uColorA * 0.12 * letters.y * (1.0 - letters.x), mask);
      } else {
        color = mix(color, abs(uColorD * 0.95 - color), letters.x * now.w);
      }
    }
  }
#endif

  fragColor = vec4(color, 1.0);
}
