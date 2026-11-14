// SWARM's shapes: where each particle belongs this frame (its target, see
// particles.glsl), worked out again every frame so the shapes move with
// the music. Four, which `swarm.rs` moves between at phrases and drops:
//
// 0. The cover, made of light: particles laid over the cover on a jittered
//    grid, colored by the pixel each sits on, and more of them on its
//    brightest parts, raised a little by its brightness and turned in
//    space, so the art floats as a relief of points.
// 1. A galaxy: spiral arms around a hot core, turning a quarter each bar,
//    the inside faster, tilted like a disc seen from above.
// 2. The spectrum as rings: their radius at each angle is the band heard
//    there, now (the middle ring), a moment ago (the outer), and to come.
// 3. A grid of dots that ripples out from the middle on every beat, each
//    column lit by its band.
//
// And over any of them, a hook word (words.rs; a chorus line's word, or
// the song's phrase): most of the particles leave the shape to spell it,
// where the word sits, as the cover's shape samples the cover.
//
// While one shape gives way to the next, each particle moves on at its own
// moment, so the change sweeps through the swarm. Before a big hit the
// shape draws in (the score says one is coming), and as a drop builds it
// tightens and turns. A share of the particles leaves the shape to run in
// a stream behind the lead melody.

out uvec4 stateOut;

// The shape before and after (as numbers above), how far each particle
// has moved on (0 to 1), and, while a drop has blown the shape apart, 1
// and the seconds since it landed (0 otherwise).
uniform vec4 uSwarmForm;
// The stream (particles_update.glsl).
uniform vec4 uSwarmStream;

struct Spot {
  highp vec2 at;
  vec3 color;
  float bright;
  float size;
};

// A point in space, turned and seen in perspective: x, y across the
// picture, z toward you.
highp vec2 seen(highp vec3 p, float yaw, float pitch) {
  p.xz = mat2(cos(yaw), sin(yaw), -sin(yaw), cos(yaw)) * p.xz;
  p.yz = mat2(cos(pitch), sin(pitch), -sin(pitch), cos(pitch)) * p.yz;
  return p.xy / (1.0 - 0.9 * p.z);
}

Spot coverShape(uint id, uint count) {
  float side = floor(sqrt(float(count)));
  float n = float(id);
  highp vec2 uv;
  if (n < side * side) {
    // A jittered grid over the whole cover.
    vec2 cell = vec2(mod(n, side), floor(n / side));
    uv = (cell + vec2(unitU(id * 5u + 1u), unitU(id * 5u + 2u))) / side;
  } else {
    uv = vec2(unitU(id * 5u + 1u), unitU(id * 5u + 2u));
  }
  // A quarter of them go where the cover is brightest: the brightest of
  // three random places.
  if (unitU(id * 5u + 3u) < 0.25) {
    float best = -1.0;
    highp vec2 chosen = uv;
    for (int i = 0; i < 3; i++) {
      highp vec2 at = vec2(unitU(id * 11u + uint(i) * 2u), unitU(id * 11u + uint(i) * 2u + 1u));
      vec3 c = cover(at);
      float score_ = dot(c, vec3(0.3, 0.55, 0.15)) + 0.4 * (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)));
      if (score_ > best) {
        best = score_;
        chosen = at;
      }
    }
    uv = chosen;
  }
  vec3 color = cover(uv);
  float light = dot(color, vec3(0.3, 0.55, 0.15));
  float size = 0.9 + 0.08 * uBands.x;
  highp vec3 p = vec3((uv - 0.5) * size, (light - 0.4) * 0.14);
  float yaw = 0.32 * sin(uBeats * PI / 16.0 + uSeed * 6.0);
  float pitch = 0.16 * sin(uBeats * PI / 23.0 + 1.0);
  Spot spot;
  spot.at = seen(p, yaw, pitch);
  // Even a black cover keeps its shape: its darkest parts glow faintly in
  // its strong color.
  spot.color = max(saturate3(color, 1.25) * 0.85 + 0.15 * uColorA * light, uColorA * 0.3);
  spot.bright = 0.22 + 0.6 * light;
  spot.size = 0.9 + 0.5 * light;
  return spot;
}

Spot galaxyShape(uint id) {
  float arms = 2.0 + floor(uSeed * 2.99);
  float r1 = unitU(id * 7u + 1u);
  float r2 = unitU(id * 7u + 2u);
  float r3 = unitU(id * 7u + 3u);
  float arm = floor(unitU(id * 7u + 4u) * arms);
  // Most particles near the middle, fewer and fewer out to the rim.
  float r = 0.03 + 0.52 * pow(r1, 1.3);
  // Spread around each arm: tight far out, a haze near the core.
  float spread = (r2 - 0.5) * (0.35 + 1.2 * exp(-r * 9.0)) + (r3 - 0.5) * 0.25;
  // A quarter turn each bar, the inside turning faster, and swelling on
  // the bass.
  highp float turn = uBeats * TAU / 16.0 * (0.6 + 0.08 / (r + 0.05));
  highp float angle = arm * TAU / arms + log(r) * 2.4 + spread + turn;
  r *= 1.0 + 0.12 * uBands.x + 0.1 * uHit;
  highp vec3 p = vec3(cos(angle) * r, (r3 - 0.5) * 0.04 * (1.0 - r), sin(angle) * r);
  Spot spot;
  spot.at = seen(p, 0.0, -1.05 + 0.15 * sin(uBeats * PI / 32.0));
  float core = exp(-r * 9.0);
  // The core is the strong color alone: arms of two colors crowding there
  // would add up to grey.
  spot.color = mix(mix(uColorA, uColorD, step(1.0, mod(arm, 2.0)) * 0.7 + 0.3 * r2), mix(uColorA, vec3(1.0), 0.15), core);
  spot.bright = (0.25 + 0.2 * r3) * (1.0 - 0.4 * core);
  spot.size = 0.8 + 0.5 * core + 0.4 * r2;
  return spot;
}

Spot ringShape(uint id) {
  float r1 = unitU(id * 9u + 1u);
  float r2 = unitU(id * 9u + 2u);
  float ring = r1 < 0.5 ? 0.0 : (r1 < 0.8 ? 1.0 : 2.0);
  highp float angle = unitU(id * 9u + 3u) * TAU + uBeats * TAU / 64.0 * (ring - 0.8);
  // Low bands at the bottom, high at the top, mirrored left and right.
  float x = abs(fract(angle / TAU + 0.25) - 0.5) * 2.0;
  float band;
  if (ring < 0.5) band = spectrum(x);
  else if (ring < 1.5) band = history(x, 0.25);
  else band = hasScore() > 0.0 ? futureSpectrum(x, 0.6) : history(x, 0.6);
  float base = 0.17 + 0.09 * ring;
  float r = base + band * (0.13 + 0.05 * ring) * (1.0 + 0.6 * uDrop) + (r2 - 0.5) * 0.012 * (1.0 + 2.0 * band);
  Spot spot;
  spot.at = vec2(cos(angle), sin(angle)) * r;
  spot.color = ring < 0.5 ? uColorA : (ring < 1.5 ? mix(uColorA, uColorD, 0.6) : uColorD);
  spot.bright = (0.25 + 0.7 * band) * (ring < 0.5 ? 1.0 : 0.7);
  spot.size = 0.8 + 0.8 * band;
  return spot;
}

Spot gridShape(uint id, float aspect) {
  const float ACROSS = 28.0;
  const float DOWN = 16.0;
  float node = mod(float(id), ACROSS * DOWN);
  vec2 cell = vec2(mod(node, ACROSS), floor(node / ACROSS));
  highp vec2 at = (cell - vec2(ACROSS - 1.0, DOWN - 1.0) * 0.5) / vec2(ACROSS - 1.0, DOWN - 1.0);
  at *= vec2(aspect * 0.86, 0.84);
  // A ring runs out from the middle on each beat, lifting the dots it
  // passes toward you.
  float d = length(at * vec2(1.0, 1.2));
  float front = fract(uBeats) * 1.3;
  float wave = exp(-pow((d - front) * 9.0, 2.0)) * (0.4 + 0.6 * uEnergy) * (1.0 - fract(uBeats) * 0.6);
  float band = spectrum(abs(cell.x / (ACROSS - 1.0) - 0.5) * 2.0);
  highp vec3 p = vec3(at, 0.12 * wave + 0.05 * band);
  // A little scatter in each dot, so a dot is a small cloud.
  p.xy += (vec2(unitU(id * 3u + 1u), unitU(id * 3u + 2u)) - 0.5) * 0.006 * (1.0 + 3.0 * wave);
  Spot spot;
  spot.at = seen(p, 0.12 * sin(uBeats * PI / 16.0), 0.0);
  spot.color = mix(uColorD, uColorA, clamp(wave * 1.5 + band * 0.5, 0.0, 1.0));
  spot.bright = 0.1 + 0.5 * wave + 0.25 * band;
  spot.size = 0.9 + 1.0 * wave;
  return spot;
}

// A place on the letters of word `w`, for particle `id`: the first of
// four random places in the word's box that lands on a letter. False when
// none does (a quarter of the particles, near a thin word), and those
// keep the shape.
bool wordSpot(int w, uint id, out Spot spot) {
  vec4 box = uWordBox[w];
  for (int i = 0; i < 4; i++) {
    highp vec2 at = box.xy + (vec2(unitU(id * 19u + uint(i) * 2u + 1u), unitU(id * 19u + uint(i) * 2u + 2u)) * 2.0 - 1.0) * box.zw;
    float field = wordField(w, at);
    if (field > 0.52) {
      spot.at = at;
      // The letters' insides brighter than their edges, and each particle
      // dimmer the smaller the word, so the many crowded onto a small one
      // don't add up to a blur of white.
      float inside = smoothstep(0.52, 0.75, field);
      float crowd = min(1.0, 0.005 / max(box.z * box.w, 1e-4));
      spot.color = mix(uColorA, vec3(1.0), 0.25 + 0.3 * inside);
      spot.bright = (0.3 + 0.35 * inside) * crowd;
      spot.size = 0.7 + 0.25 * inside;
      return true;
    }
  }
  return false;
}

Spot shape(float which, uint id, uint count, float aspect) {
  if (which < 0.5 && uHasCover > 0.5) return coverShape(id, count);
  if (which < 1.5) return galaxyShape(id); // and the cover's, without one
  if (which < 2.5) return ringShape(id);
  return gridShape(id, aspect);
}

void main() {
  ivec2 side = textureSize(uState, 0);
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uint id = texelId(texel, side);
  uint count = uint(side.x * side.y);
  float aspect = uRes.x / uRes.y;

  // Each particle moves on to the next shape at its own moment.
  float moment = unitU(id ^ 0x5bd1e995u);
  float which = moment < uSwarmForm.z ? uSwarmForm.y : uSwarmForm.x;
  Spot spot = shape(which, id, count, aspect);

  // Before a big hit, and as a drop builds, the shape draws in and turns.
  float coming = hasScore() * smoothstep(0.3, 0.9, score(SCORE_KICK, 0.12)) * uDrums;
  float draw = 1.0 - 0.06 * coming - 0.3 * uTension * uTension;
  float twist = 1.4 * uTension * uTension * (0.3 + length(spot.at));
  spot.at = rot(twist) * spot.at * draw;
  float pull = 1.0 + 0.6 * uTension;

  // A hook word: up to three quarters of the swarm spells it while it is
  // sung, pulled hard so it forms within a word's time, and lets it go as
  // the word fades. A hook word coming in under half a second gathers
  // them first, so the next word of a chorus line forms from the last.
  if (uWordAtlas.w > 0.0) {
    vec4 now = uWordTime[WORD_NOW];
    vec4 next = uWordTime[WORD_NEXT];
    int w = -1;
    float share = 0.0;
    if (now.z > 0.5 && now.w > 0.0) {
      w = WORD_NOW;
      share = 0.75 * now.w;
    } else if (next.z > 0.5 && next.w > 0.0 && next.x > -0.45) {
      w = WORD_NEXT;
      share = 0.75 * smoothstep(-0.45, -0.1, next.x);
    }
    Spot letter;
    if (w >= 0 && unitU(id * 17u + 3u) < share && wordSpot(w, id, letter)) {
      spot = letter;
      pull = 6.0;
    }
  }

  // A share follows the lead melody, strung out along its path.
  if (unitU(id * 13u + 5u) < 0.14 * uSwarmStream.z) {
    // Fewer near the head, so it burns without blowing out.
    float behind = sqrt(unitU(id * 13u + 6u));
    highp float t = uSwarmStream.x - behind * 2.4;
    spot.at = swarmStreamAt(t, uSwarmStream.y, aspect)
      + (vec2(unitU(id * 13u + 7u), unitU(id * 13u + 8u)) - 0.5) * (0.02 + 0.08 * behind);
    spot.color = mix(mix(uColorD, vec3(1.0), 0.4), uColorD, behind);
    spot.bright = 0.06 + 0.22 * (1.0 - behind);
    spot.size = 1.2 - 0.4 * behind;
    pull = 2.0;
  }

  // A drop blows the shape up past the edges: each particle is thrown
  // straight out from the middle, through where it was, to a place of its
  // own in a burst that fills the whole picture, evenly (the square root
  // spreads them by area), and the blast carries it past that place and
  // back (`swarm.rs`). The burst turns, the middle fastest, and swells, so
  // every particle keeps chasing its place: the picture full of streaks.
  // Paler toward the cover's strong color. The letters of a hook word hold.
  if (uSwarmForm.w > 0.5 && pull < 4.0) {
    float since = uSwarmForm.w - 1.0;
    highp vec2 out_ = spot.at + (vec2(unitU(id * 23u + 1u), unitU(id * 23u + 2u)) - 0.5) * 0.04;
    out_ /= max(length(out_), 1e-3);
    // How far the picture reaches that way, a little past its edge.
    float reach = 1.08 * min(0.5 * aspect / max(abs(out_.x), 1e-3), 0.5 / max(abs(out_.y), 1e-3));
    float far = mix(0.03, 1.0, sqrt(unitU(id * 23u + 3u)));
    spot.at = rot(since * (2.4 - 1.6 * far)) * out_ * reach * far * (0.85 + 0.2 * since);
    spot.color = mix(spot.color, mix(uColorA, vec3(1.0), 0.35), 0.3);
    pull = 1.0;
  }

  stateOut = uvec4(
    floatBitsToUint(spot.at),
    packHalf2x16(vec2(pull, spot.size)),
    packColor(vec4(spot.color, clamp(spot.bright, 0.0, 1.0)))
  );
}
