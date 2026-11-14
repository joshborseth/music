// THE PICTURE: the scene, its glow, and the camera tricks that tie it all
// to the music: a punch in on the kick, the light lifting with it, a shake
// and the light closing in as a drop builds, a flash in the cover's color
// and split colors when it lands. Then the tone, the vignette, and the
// shade the app's words need, which the UI would otherwise paint as three
// more full-screen layers on top: a light shade everywhere, then either a
// band behind the lyrics on the right (`uSide`) or a pool behind the song
// in the middle (`uCentre`), whose stops match the Slint gradients they
// replace (`ui/app.slint`, NOW PLAYING). Where the lyrics run, the light is
// also held down, so a bright line never crosses the words: a thin line is
// pulled toward how bright its neighborhood is (it softens to a haze),
// bright light is held down past a dim knee, and the drop's flash is kept
// low there, so the dim lines of the lyrics stay readable.
//
// THE MOMENTS. While one scene takes over from another, the old one has
// stopped drawing and its last frame waits, frozen, in `uSceneB`; the new
// one draws into `uSceneA` every frame, and this pass destroys the frozen
// frame to show it (over `uMix`, transition.rs): it shatters
// into shards flying at the camera, melts away in drips, rushes past the
// camera through a hole that opens in it, is dragged along the new scene's
// shapes in blocks (a datamosh), or is swept away by an edge in the
// cover's color. Through a build the colors drain toward the cover's deep
// shade (`uCueDrain`), the half beat before its landing all but goes dark
// (`uCueInhale`), and fills, a build's last bar, and the climax tear the
// picture (`uGlitch`): rows and blocks pushed sideways, the colors split,
// and posterized.
//
// Each change is its own program, this file compiled with `TRANSITION`
// defined as its number (1 shatter, 2 melt, 3 zoom through, 4 datamosh,
// 5 wipe; gpu.rs): the picture drawn between changes carries none of their
// code, so a TV's GPU gives it no more registers than it needs.
//
// Drawn at the scenes' size, never the screen's: the scenes are drawn
// small, so everything that works on them happens at their size, where a
// pixel costs a half to a fifth of one at the screen's. `present.glsl`
// stretching it loses little: the glitch's tears are a few pixels wide at
// the least.

// The scene showing (the one coming in, during a change), and the frozen
// last frame of the one leaving.
#ifndef TRANSITION
#define TRANSITION 0
#endif

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform sampler2D uBloom;
// How far the change of scene is, 0 to 1, and the incoming scene's look,
// which varies it.
uniform float uMix;
uniform float uTransSeed;
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
// The moments (motion.rs, `Screen`): the colors drained through a build,
// the inhale before its landing, and the glitch layer: how much, its
// pattern (new each sixteenth note), and how far it posterizes.
uniform float uCueDrain;
uniform float uCueInhale;
uniform float uGlitch;
uniform float uGlitchSeed;
uniform float uGlitchPosterize;
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

float luma(vec3 color) {
  return dot(color, vec3(0.3, 0.55, 0.15));
}

// The scene showing: the one coming in while a change runs.
vec3 live(highp vec2 uv) {
  return texture(uSceneA, uv).rgb;
}

// The frozen frame of the scene leaving, black outside it.
vec3 frozen(highp vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(uSceneB, uv).rgb * inside.x * inside.y;
}

// THE GLITCH: where to read the picture from, torn. Bands of rows slide
// sideways, and a few blocks jump, a new pattern each sixteenth note.
highp vec2 torn(highp vec2 uv) {
  highp float seed = uGlitchSeed * 97.0;
  float rows = 14.0 + floor(uGlitchSeed * 4.0) * 9.0;
  highp float row = floor(uv.y * rows);
  if (hash12(vec2(row, seed)) < 0.55 * uGlitch) {
    uv.x += (hash12(vec2(row + 0.5, seed + 3.1)) - 0.5) * 0.22 * uGlitch;
  }
  highp vec2 block = floor(uv * vec2(9.0, 5.0) * (1.0 + floor(uGlitchSeed * 2.99)));
  if (hash12(block + seed) < 0.3 * uGlitch) {
    uv += (vec2(hash12(block + 7.1 + seed), hash12(block + 3.3 + seed)) - 0.5) * 0.18 * uGlitch;
  }
  return uv;
}

#if TRANSITION == 1
// SHATTER: the frozen frame breaks like glass struck in the middle, into
// shards (Voronoi cells, their points from the noise texture) small at the
// strike and larger outward, which fly at the camera: the whole sheet
// rushes closer while each shard drifts, turns, and tilts its own way,
// lit along its edges in the cover's color, and drops away, the middle
// first, showing the new scene behind through the widening cracks. Most of
// it happens at once, on the beat, then slows.
const float SHARDS = 3.0;
// Shards are smaller toward the middle: the sheet is read at the square
// root of the distance from it (no `pow`, which a TV's GPU and the lab's
// software renderer both pay for), and back.
highp vec2 toShards(highp vec2 p) {
  return p * sqrt(inversesqrt(max(dot(p, p), 1e-6))) * SHARDS;
}
highp vec2 fromShards(highp vec2 g) {
  return g * length(g) / (SHARDS * SHARDS);
}
// The noise texture's values for shard `n`: its point, its tilt.
vec4 shard(highp vec2 n, ivec2 shift) {
  return texelFetch(uNoise, (ivec2(n) + shift) & 255, 0);
}
vec3 shatter(vec3 fresh, highp vec2 uv, float t) {
  highp vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  float fast = 1.0 - (1.0 - t) * (1.0 - t);
  // The whole sheet flies at the camera; the shards spread with it.
  float zoom = 1.0 + 2.4 * fast * fast;
  highp vec2 g = toShards((uv - 0.5) * aspect / zoom);
  // The four cells nearest: each shard's point stays well inside its
  // cell, so the nearest point is all but always among theirs (under half
  // the work of the usual nine). Kept: the two nearest distances, and
  // which cell is nearest, worked out again after.
  highp vec2 cell = floor(g - 0.5);
  vec2 inside = vec2(g - cell);
  float drift = 0.24 * fast;
  ivec2 shift = ivec2(128.0 + uTransSeed * 61.0);
  float near = 99.0;
  float second = 99.0;
  vec2 nearest = vec2(0.0);
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 r = shard(cell + n, shift).rg;
      // Each shard drifts its own way as it goes.
      vec2 to = inside - n - 0.2 - 0.6 * r - (r.yx - 0.5) * drift;
      float d = dot(to, to);
      // Without branches: neighbouring pixels would take different ones,
      // and a GPU then runs both.
      float closer = step(d, near);
      second = mix(min(second, d), near, closer);
      near = min(near, d);
      nearest = mix(nearest, n, closer);
    }
  }
  vec4 chosen = shard(cell + nearest, shift);
  highp vec2 point = cell + nearest + 0.2 + 0.6 * chosen.rg;
  highp vec2 moved = point + (chosen.gr - 0.5) * drift;
  near = sqrt(near);
  second = sqrt(second);
  float edge = second - near;
  // Each shard turns and grows (comes nearer) at its own pace.
  float spin = (fract(chosen.r * 31.7) - 0.5) * 1.6 * fast;
  float nearer = 1.0 + 1.5 * fract(chosen.g * 23.1) * fast;
  // Turned by `spin` (small enough that 1 - spin²/2 and spin stand in
  // for its cosine and sine).
  highp vec2 off = (g - moved) / nearer;
  highp vec2 turned = vec2(1.0 - 0.5 * spin * spin, spin);
  highp vec2 home = point + vec2(turned.x * off.x - turned.y * off.y, turned.y * off.x + turned.x * off.y);
  vec3 old = frozen(fromShards(home) / aspect + 0.5);
  // A shard tilting catches the light, or turns from it.
  old *= 1.0 + 1.4 * (chosen.b - 0.5) * fast;
  // The middle goes first, the shards flying out from a hole punched
  // through; the last are gone before the end.
  float life = 0.04 + 0.4 * fract(chosen.r * 7.3 + chosen.g) + 0.48 * smoothstep(0.0, 3.0, length(point));
  float crack = 0.01 + 0.2 * fast * fast;
  float solid = step(t, life) * smoothstep(crack, crack + 0.02, edge);
  // The cracks flash in the cover's color the moment they open, then the
  // shards' edges keep a glint.
  float rim = (1.0 - smoothstep(0.0, crack + 0.035, edge)) * step(t, life);
  vec3 lit = mix(uColorA, vec3(1.0), 0.45) * rim * (0.35 + 2.0 * (1.0 - fast));
  return mix(fresh, old, solid) + lit;
}

#elif TRANSITION == 2
// MELT: the frozen frame slides down the screen in drips, each column at
// its own pace (fractal noise across: a slow wave, and its fine detail
// raised to make a few long fingers), smeared as it goes, with a wet
// bright lip at its top edge; the new scene shows above it.
vec3 melt(vec3 fresh, highp vec2 uv, float t) {
  highp float x = uv.x * uRes.x / uRes.y;
  vec2 drips = fbm2(vec2(x * 4.0, uTransSeed * 8.0));
  float wave = drips.x;
  float finger = smoothstep(0.4, 0.8, drips.y);
  finger = finger * finger;
  float fall = t * t * (0.9 + 1.2 * wave + 2.6 * finger) + 0.03 * t;
  float top = 1.0 - fall;
  if (uv.y > top) return fresh;
  // The nearer the lip, the more it is smeared from above.
  float near = clamp((top - uv.y) / 0.3, 0.0, 1.0);
  highp float from = uv.y + fall * mix(0.55, 1.0, near * near);
  vec3 old = frozen(vec2(uv.x, from));
  float lip = 1.0 - smoothstep(0.0, 0.02, top - uv.y);
  return old * (1.0 + 1.6 * lip) + mix(uColorA, vec3(1.0), 0.3) * 0.3 * lip;
}

#elif TRANSITION == 3
// ZOOM THROUGH: the frozen frame rushes past the camera, streaking, as a
// hole opens in its middle and grows past the corners, the new scene
// coming up from behind through it, its rim lit.
vec3 zoomThrough(highp vec2 uv, float t) {
  highp vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  highp vec2 c = uv - 0.5;
  float ease = t * t;
  float z = 1.0 + 6.0 * ease;
  highp vec2 at = c / z;
  // Streaks along the rush: two reads toward the middle.
  float streak = 0.1 * t;
  vec3 old = 0.55 * frozen(at + 0.5) + 0.45 * frozen(at * (1.0 - streak) + 0.5);
  highp vec2 q = c * aspect;
  float r = 1.25 * t * sqrt(t);
  // Ragged around the ring: waves along its direction, no angle needed.
  highp float far = length(q);
  vec2 way = q / max(far, 1e-3);
  float seed = uTransSeed * 40.0;
  float d = far + 0.025 * (sin(way.x * 7.0 + seed) + sin(way.y * 11.0 - seed + 3.0 * t));
  float open = 1.0 - smoothstep(r - 0.03, r + 0.03, d);
  // The new scene comes from behind, growing to its place.
  vec3 fresh = live(c * mix(0.55, 1.0, sqrt(t)) + 0.5);
  float rim = (1.0 - smoothstep(0.0, 0.05, abs(d - r))) * (1.0 - t) * step(0.01, t);
  return mix(old * (1.0 + 0.8 * ease), fresh, open) + mix(uColorA, vec3(1.0), 0.4) * rim * 1.4;
}

#elif TRANSITION == 4
// DATAMOSH: as a broken video stream does, the frozen frame's pixels are
// dragged along the new scene's shapes, in blocks (each 16 pixels moved
// by the new scene's slope there), while blocks of the new scene break
// through, more and more, its sharpest edges first.
vec3 datamosh(vec3 fresh, highp vec2 uv, float t, float here) {
  highp vec2 size = 16.0 / uRes;
  highp vec2 block = floor(uv / size);
  highp vec2 middle = (block + 0.5) * size;
  // The new scene's slope there, from its glow's brightness (`uBloom`'s
  // alpha: blurred already, and an eighth of the size, so its reads are
  // cheap), against the glow here, two blocks across.
  vec2 slope = vec2(
    texture(uBloom, middle + vec2(2.0 * size.x, 0.0)).a - here,
    texture(uBloom, middle + vec2(0.0, 2.0 * size.y)).a - here
  );
  float jitter = hash12(block + uTransSeed * 17.0);
  // The slope steers the drag; a little of each block's own sway keeps
  // flat parts moving too.
  vec2 steer = slope * 9.0 + (vec2(jitter, fract(jitter * 7.0)) - 0.5) * 0.4;
  highp vec2 drag = steer / max(1.0, length(steer)) * 0.16 * (t + 1.5 * t * t);
  vec3 old = frozen(uv - drag);
  // Smeared blocks keep a stale tint, as a stream missing its keyframe.
  old = mix(old, old.gbr, 0.15 * t * step(0.7, fract(jitter * 13.0)));
  float through = step(fract(jitter * 31.0 + 0.37), t * 1.3 - 0.25);
  through = max(through, smoothstep(0.06, 0.2, length(slope)) * smoothstep(0.1, 0.6, t));
  return mix(old, fresh, through);
}

#elif TRANSITION == 5
// WIPE: an edge in the cover's color sweeps across, ragged like ink, at
// an angle each change picks; ahead of it the frozen frame is dragged
// toward it (a slit scan), behind it the new scene shows.
vec3 wipe(vec3 fresh, highp vec2 uv, float t) {
  highp vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  float angle = uTransSeed * TAU;
  vec2 dir = vec2(cos(angle), sin(angle));
  highp vec2 q = (uv - 0.5) * aspect;
  float reach = 0.5 * (abs(dir.x) * aspect.x + abs(dir.y));
  float across = dot(q, vec2(-dir.y, dir.x));
  float s = 0.5 + 0.5 * dot(q, dir) / reach;
  s += 0.1 * (fbm(vec2(across * 4.0, uTransSeed * 8.0)) - 0.5);
  float ease = t * t * (3.0 - 2.0 * t);
  float at = mix(-0.16, 1.16, ease);
  float ahead = s - at;
  if (ahead < -0.04) return fresh;
  // Dragged toward the edge as it comes: the slit scan.
  float pull = 1.0 - smoothstep(0.0, 0.22, ahead);
  vec3 old = frozen(uv - dir / aspect * pull * 0.12 * reach);
  float band = 1.0 - smoothstep(0.0, 0.04, abs(ahead + 0.01));
  vec3 color = ahead < 0.0 ? fresh : old;
  return mix(color, mix(uColorA, vec3(1.0), 0.25) * 1.3, band);
}

#endif

void main() {
  // Kept highp: the reads land between the scenes' own pixels.
  highp vec2 c = vUv - 0.5;

  // Punch in on the kick, the edges a little more, like a lens thumped;
  // shake as a drop builds.
  c = c * (uPunch - uBulge * dot(c, c)) + uShake;
  highp vec2 uv = c + 0.5;
  if (uGlitch > 0.0) uv = torn(uv);

  // Split the colors outward when a drop builds and lands, and sideways
  // when the picture glitches. Until the split reaches half a pixel in
  // the corners, the scene is read once.
  // While a change runs, its own reads take the place of the split's: the
  // change is the show, and a change costs no more than a scene alone
  // plus a few reads.
  vec4 bloom = texture(uBloom, uv);
  vec3 color;
#if TRANSITION == 0
  if (uSplit < 0.0005 && uGlitch <= 0.0) {
    color = live(uv);
  } else {
    highp vec2 dir = c * uSplit + vec2(0.018 * uGlitch * (uGlitchSeed - 0.3), 0.0);
    color = vec3(live(uv + dir).r, live(uv).g, live(uv - dir).b);
  }
#elif TRANSITION != 3
  color = live(uv);
#endif

  // A change of scene: the frozen frame destroyed, the new scene showing
  // through.
#if TRANSITION == 1
  color = shatter(color, uv, clamp(uMix, 0.0, 1.0));
#elif TRANSITION == 2
  color = melt(color, uv, clamp(uMix, 0.0, 1.0));
#elif TRANSITION == 3
  color = zoomThrough(uv, clamp(uMix, 0.0, 1.0));
#elif TRANSITION == 4
  color = datamosh(color, uv, clamp(uMix, 0.0, 1.0), bloom.a);
#elif TRANSITION == 5
  color = wipe(color, uv, clamp(uMix, 0.0, 1.0));
#endif

  // The light lifts on the kick and through a drop, and glows.
  color = color * uLift + bloom.rgb * uGlow;

  // Through a build the colors drain to the cover's deep shade, as if
  // the light were being drawn in.
  if (uCueDrain > 0.0) color = mix(color, uColorC * luma(color) * 2.2, uCueDrain);

  // Where the lyrics run, the light is calmed, and out of the words' way
  // nothing changes. (Every pixel takes the same side of a branch on a
  // uniform, so the pixels without lyrics on screen skip it for free.)
  // Around the letters of the word being sung (words.rs), the light is
  // neither calmed nor shaded: the words sit where no line of the app's
  // runs, and under the shade they would be dim.
  float sung = 0.0;
  if (uWordAtlas.w > 0.0) {
    highp vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    sung = smoothstep(0.0, 0.5, wordField(WORD_NOW, q)) * uWordTime[WORD_NOW].w;
  }
  float calm = 0.0;
  if (uSide > 0.0) {
    calm = uSide * wordsZone(vUv) * (1.0 - sung);
    float lit = max(color.r, max(color.g, color.b));
    // A thin bright line is far brighter than its neighborhood on average
    // (the glow's alpha, the picture's brightness blurred), so it loses
    // the more the brighter it stands out: by the square of how much of
    // its neighborhood's light it has. A line fades into the haze around
    // it, while broad light, as bright as its neighborhood, keeps its
    // level, and the calm shows no edge.
    float around = bloom.a * uLift + max(bloom.r, max(bloom.g, bloom.b)) * uGlow;
    float stands = min(around / max(lit, 1e-4), 1.0);
    float soft = lit * (1.0 - 0.9 * calm * (1.0 - stands * stands));
    // Past a dim knee, the brighter it is the more it loses, so a ray
    // crossing the words fades to a glimmer, while the dark and the dim
    // keep their shades.
    float over = max(soft - 0.1, 0.0);
    color *= (soft - over + over / (1.0 + 8.0 * calm * over)) / max(lit, 1e-4);
  }

  // The inhale before a landing: all but black, only the brightest
  // shapes left, as a silhouette rimmed in the cover's color.
  if (uCueInhale > 0.0) {
    float shape = smoothstep(0.12, 0.6, luma(color));
    color = mix(color, color * 0.04 + mix(uColorA, vec3(1.0), 0.2) * shape * shape * 0.45, uCueInhale);
  }

  // When a drop lands, a flash in the cover's color, everywhere but
  // behind the lyrics, where it would wash out their dim lines, and less
  // on what is bright already, which it would only burn white. It is over
  // in half a beat; the rest of the drop lives in the lift, the glow, and
  // the scenes.
  color += uFlash * (1.0 - 0.75 * calm) * (1.0 - 0.6 * smoothstep(0.4, 1.4, luma(color)));

  // A soft curve so bright light rolls off instead of clipping, worked on
  // the brightest channel and applied to all three: a channel clipping on
  // its own would turn orange to yellow and teal to green. What the curve
  // takes past white burns toward white, as a hot light does.
  float peak = max(color.r, max(color.g, color.b));
  float rolled = 1.2 * peak / (1.0 + 0.3 * peak);
  color *= rolled / max(peak, 1e-4) / max(rolled, 1.0);
  color = mix(color, vec3(1.0), 0.35 * clamp(rolled - 1.0, 0.0, 1.0));

  // The glitch posterizes: the colors fall to a few steps.
  if (uGlitchPosterize > 0.0) {
    float steps = mix(24.0, 3.0, uGlitchPosterize);
    color = floor(color * steps + 0.5) / steps;
  }

  // Dark corners, closing in as a drop builds, then the shade for the
  // app's words; each covers what is under it, as the UI's layers did.
  float vignette = smoothstep(uVignette.x, uVignette.y, length(vec2(c) * vec2(1.0, 0.8)));
  float keep = mix(uVignette.z, 1.0, vignette) * uKeep;
  if (uSide > 0.0) keep *= 1.0 - uSide * sideShade(vUv.x) * (1.0 - 0.8 * sung);
  // Slint's radial gradient reaches half the diagonal.
  if (uCentre > 0.0) keep *= 1.0 - uCentre * 0.50 * max(0.0, 1.0 - length((vUv - 0.5) * uPool)) * (1.0 - 0.8 * sung);
  fragColor = vec4(color * keep, 1.0);
}
