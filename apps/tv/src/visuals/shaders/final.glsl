// THE PICTURE: the scene (or two, while one dissolves into the next), its
// glow, and the camera tricks that tie it all to the music: a punch in on
// the kick, the light lifting with it, a shake and the light closing in
// as a drop builds, a flash in the cover's color and split colors when it
// lands. Then the tone, the vignette, and the shade the app's words need,
// which the UI would otherwise paint as three more full-screen layers on
// top: a light shade everywhere, then either a band behind the lyrics on
// the right (`uSide`) or a pool behind the song in the middle (`uCentre`),
// whose stops match the Slint gradients they replace (`ui/app.slint`, NOW
// PLAYING). Where the lyrics run, the light is also held down, so a bright
// line never crosses the words.
//
// Drawn at the scenes' size, never the screen's: the scenes are drawn
// small, so everything that works on them happens at their size, where a
// pixel costs a half to a fifth of one at the screen's. All of it changes
// smoothly across the picture, so `present.glsl` stretching it loses
// nothing.

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform sampler2D uBloom;
uniform float uMix;
// Worked out once a frame (motion.rs, `Screen`), not at every pixel: how
// large the picture is read (the punch) and how much more at its edges
// (the bulge), how bright its light is (the lift), the colors' split, the
// glow's strength, the drop's flash, and the vignette (where it starts,
// where it ends, how dark its corners are).
uniform float uPunch;
uniform float uBulge;
uniform float uLift;
uniform float uSplit;
uniform float uGlow;
uniform vec3 uFlash;
uniform vec3 uVignette;
// The shake as a drop builds (motion.rs, `Motion`).
uniform vec2 uShake;
// How much light shows at all: the fade in when the visuals start, under
// the light shade the app's words always need.
uniform float uKeep;
// How much of the lyrics band and of the pool behind the song in the
// middle show, 0 to 1; and the picture in units of the pool's reach.
uniform float uSide;
uniform float uCentre;
uniform vec2 uPool;

// The lyrics band's opacity across the screen, left to right.
float sideShade(float x) {
  if (x < 0.30) return mix(0.40, 0.078, x / 0.30);
  if (x < 0.46) return mix(0.078, 0.50, (x - 0.30) / 0.16);
  return mix(0.50, 0.60, (x - 0.46) / 0.54);
}

// Where the lyrics run, 1 to 0: the column `lyrics-box` holds in
// `ui/app.slint` (from 37 of its 54ths of the height across to 5 short of
// the right edge, from 4 down to 14 above the bottom), where the lines
// gather around the one being sung, two fifths of the way down. Its edge
// fades over a tenth of the screen's width, round at the corners, so the
// calm has no edge to see.
float wordsZone(vec2 uv) {
  vec2 d = max(abs(uv - vec2(0.68, 0.57)) - vec2(0.25, 0.25), 0.0);
  // In widths of the screen, so the fade is as wide up as across.
  d.y *= uRes.y / uRes.x;
  return 1.0 - smoothstep(0.0, 0.1, length(d));
}

void main() {
  // Kept highp: the reads land between the scenes' own pixels.
  highp vec2 c = vUv - 0.5;

  // Punch in on the kick, the edges a little more, like a lens thumped;
  // shake as a drop builds.
  c = c * (uPunch - uBulge * dot(c, c)) + uShake;
  highp vec2 uv = c + 0.5;

  // Split the colors outward when a drop builds and lands. Until the split
  // reaches half a pixel in the corners, the scene is read once.
  vec3 a;
  vec3 b = vec3(0.0);
  if (uSplit < 0.0005) {
    a = texture(uSceneA, uv).rgb;
    if (uMix > 0.0) b = texture(uSceneB, uv).rgb;
  } else {
    highp vec2 dir = c * uSplit;
    a = vec3(texture(uSceneA, uv + dir).r, texture(uSceneA, uv).g, texture(uSceneA, uv - dir).b);
    if (uMix > 0.0) {
      b = vec3(texture(uSceneB, uv + dir).r, texture(uSceneB, uv).g, texture(uSceneB, uv - dir).b);
    }
  }

  vec3 color = a;
  if (uMix > 0.0) {
    // The next scene shows through its brightest parts first.
    float grain = noise(uv * vec2(uRes.x / uRes.y, 1.0) * 6.0 + uSeed * 50.0);
    float order = 0.55 * grain + 0.45 * (1.0 - dot(b, vec3(0.333)));
    float dissolve = smoothstep(order - 0.12, order + 0.12, uMix * 1.24 - 0.12);
    color = mix(a, b, dissolve);
  }

  // The light lifts on the kick and through a drop, and glows.
  color = color * uLift + texture(uBloom, uv).rgb * uGlow;

  // Where the lyrics run, bright light is held down: past a dim knee, the
  // brighter it is the more it loses, so a ray crossing the words fades to
  // a glimmer, while the dark and the dim keep their shades and the
  // calm shows no edge. Out of the words' way, nothing changes. (Every
  // pixel takes the same side of a branch on a uniform, so the pixels
  // without lyrics on screen skip it for free.)
  if (uSide > 0.0) {
    float calm = uSide * wordsZone(vUv);
    float lit = max(color.r, max(color.g, color.b));
    float over = max(lit - 0.15, 0.0);
    color *= (lit - over + over / (1.0 + 5.0 * calm * over)) / max(lit, 1e-4);
  }

  // When a drop lands, a flash in the cover's color, everywhere alike. It
  // is over in a beat; the rest of the drop lives in the lift, the glow,
  // and the scenes.
  color += uFlash;

  // A soft curve so bright light rolls off instead of clipping, worked on
  // the brightest channel and applied to all three: a channel clipping on
  // its own would turn orange to yellow and teal to green. What the curve
  // takes past white burns toward white, as a hot light does.
  float peak = max(color.r, max(color.g, color.b));
  float rolled = 1.2 * peak / (1.0 + 0.3 * peak);
  color *= rolled / max(peak, 1e-4) / max(rolled, 1.0);
  color = mix(color, vec3(1.0), 0.35 * clamp(rolled - 1.0, 0.0, 1.0));

  // Dark corners, closing in as a drop builds, then the shade for the
  // app's words; each covers what is under it, as the UI's layers did.
  float vignette = smoothstep(uVignette.x, uVignette.y, length(vec2(c) * vec2(1.0, 0.8)));
  float keep = mix(uVignette.z, 1.0, vignette) * uKeep;
  if (uSide > 0.0) keep *= 1.0 - uSide * sideShade(vUv.x);
  // Slint's radial gradient reaches half the diagonal.
  if (uCentre > 0.0) keep *= 1.0 - uCentre * 0.50 * max(0.0, 1.0 - length((vUv - 0.5) * uPool));
  fragColor = vec4(color * keep, 1.0);
}
