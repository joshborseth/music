// CORAL, one step of its reaction-diffusion (Gray-Scott): two chemicals
// on a small grid (`coral.rs` sizes it), u fed in everywhere, v eating u
// to grow and dying off. Each texel of `uState` (RG32UI) holds u and v as
// float bits: Gray-Scott's patterns live in differences of a thousandth,
// which 8 bits can't hold. Several steps run each frame, so each reads as
// little as it can: five texels, nothing else.
//
// The feed and kill rates choose the pattern: spots, worms, or a maze
// (`coral.rs` moves them with the bass). Over the grid they vary a little,
// so the reef is never one pattern, and a slow patch of stronger kill
// drifts across it, eating coral that grows back behind it. The music
// seeds new growth: a blob where each kick lands, a line where the lead
// melody runs; a drop bursts rings of it out across the whole reef, which
// the reaction breaks into its own pattern over the next second or two.
// The word sung now (words.rs) seeds its letters as it comes, so the reef
// grows the word, and the pattern slowly takes it back.

out uvec4 stateOut;

// Feed and kill, and how fast the reaction runs against the spreading
// (2.5 times Gray-Scott's own: the same patterns, 1.6 times finer).
uniform vec4 uCoralFeed;
// A blob to seed: x, y and radius in texels, and how much.
uniform vec4 uCoralBlob;
// A line to seed, from (x, y) to (z, w), in texels.
uniform vec4 uCoralLine;
// How much the line seeds and its radius in texels, 1 for a drop's burst,
// and 1 when everything starts over.
uniform vec4 uCoralInk;

vec2 chemicals(ivec2 texel, ivec2 side) {
  return uintBitsToFloat(texelFetch(uState, clamp(texel, ivec2(0), side - 1), 0).xy);
}

// How strongly a seed of radius `radius` texels covers a point `d` texels
// from its middle, 0 to 1.
float seedAt(float d, float radius) {
  return 1.0 - smoothstep(radius * 0.6, radius, d);
}

void main() {
  ivec2 side = textureSize(uState, 0);
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec2 here = gl_FragCoord.xy;

  if (uCoralInk.w > 0.5) {
    // A clean dish with a few seeds scattered, the same for each seed.
    ivec2 block = texel / 12;
    uint random = hashU(uint(block.y * 4096 + block.x) ^ seedU());
    vec2 middle = (vec2(block) + 0.3 + 0.4 * vec2(unitU(random + 1u), unitU(random + 2u))) * 12.0;
    float seeded = step(unitU(random), 0.14) * seedAt(distance(here, middle), 4.5);
    stateOut = uvec4(floatBitsToUint(vec2(1.0 - 0.5 * seeded, 0.25 * seeded)), 0u, 0u);
    return;
  }

  vec2 c = chemicals(texel, side);
  // The Laplacian from the four neighbors: half the reads of the usual
  // nine, for patterns a little finer. (0.22 a neighbor keeps a step
  // stable: a checkerboard would need under 0.25.)
  vec2 near = chemicals(texel + ivec2(1, 0), side) + chemicals(texel - ivec2(1, 0), side)
    + chemicals(texel + ivec2(0, 1), side) + chemicals(texel - ivec2(0, 1), side);
  vec2 laplacian = 0.22 * (near - 4.0 * c);

  // The rates vary over the reef in slow waves, and a patch of stronger
  // kill drifts across it: worked out here, not read, since this runs
  // many times a frame.
  highp vec2 uv = here / vec2(side);
  highp float phase = uSeed * 40.0;
  float waves = sin(uv.x * 7.1 + phase) * sin(uv.y * 5.3 - phase * 0.7);
  float ripple = sin(uv.x * 3.7 - uv.y * 6.1 + phase * 1.3);
  highp float drift = uTime * 0.05 + phase;
  vec2 eater = vec2(0.5 + 0.38 * sin(drift * 0.61), 0.5 + 0.3 * sin(drift * 0.83 + 1.0));
  vec2 toPatch = (uv - eater) * vec2(float(side.x) / float(side.y), 1.0);
  float eaten = exp(-dot(toPatch, toPatch) * 30.0);
  float feed = uCoralFeed.x + waves * 0.0025;
  float kill = uCoralFeed.y + ripple * 0.0015 + 0.008 * eaten;

  float u = c.x;
  float v = c.y;
  float uvv = u * v * v;
  float rate = uCoralFeed.z;
  u += laplacian.x + (feed * (1.0 - u) - uvv) * rate;
  v += 0.5 * laplacian.y + (uvv - (feed + kill) * v) * rate;

  // The music seeds it.
  float seed = uCoralBlob.w * seedAt(distance(here, uCoralBlob.xy), uCoralBlob.z);
  vec2 along = uCoralLine.zw - uCoralLine.xy;
  float t = clamp(dot(here - uCoralLine.xy, along) / max(dot(along, along), 1e-4), 0.0, 1.0);
  seed = max(seed, uCoralInk.x * seedAt(distance(here, uCoralLine.xy + along * t), uCoralInk.y));
  if (uCoralInk.z > 0.0) {
    // A drop: rings of new growth over the whole reef at once, out from
    // the middle, warped by the fractal noise so they break into worms
    // and loops, the old reef thinned between them. Dense from the first
    // frame; the reaction reorganizes it into its own pattern.
    highp vec2 q = (uv - 0.5) * vec2(float(side.x) / float(side.y), 1.0);
    float warp = fbm(uv * 2.5 + uSeed * 5.0);
    float ring = abs(fract(length(q) * 9.0 - warp * 1.8 + uSeed * 3.0) - 0.5);
    v *= 0.35;
    u = mix(u, 1.0, 0.5);
    seed = max(seed, 1.0 - smoothstep(0.1, 0.18, ring));
  }
  // The word sung now, for its first third of a second: one read, and
  // only inside its box.
  vec4 word = uWordTime[WORD_NOW];
  if (uWordAtlas.w > 0.0 && word.w > 0.0 && word.x < 0.35) {
    highp vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float letters = wordInk(wordField(WORD_NOW, p), 0.08);
    seed = max(seed, letters * word.w * (0.7 + 0.3 * word.z));
  }
  v = mix(v, 0.25, seed);
  u = mix(u, 0.5, seed);

  stateOut = uvec4(floatBitsToUint(clamp(vec2(u, v), 0.0, 1.0)), 0u, 0u);
}
