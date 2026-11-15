// THE PARTICLES, one step: each texel is a particle (particles.glsl), read
// from the last state and written to the next. Each is pulled toward its
// target like a spring, swirled by curl noise, blown out by blasts, and
// caught by the stream, then moves. Drawn once a frame over as many pixels
// as there are particles: a few thousandths of a scene.
//
// Whatever shape the targets make, these forces keep it alive: a scene
// only says where each particle belongs (`uState2`) and how the music
// pushes them (the uniforms below, from `swarm.rs`).

out uvec4 stateOut;

// How hard targets pull (a spring's stiffness, a second squared), how
// hard the curl noise swirls, how fast motion dies away (a second), and
// the step's length in seconds.
uniform vec4 uSwarmForce;
// A blast: from (x, y), how hard it throws particles outward (units a
// second), and how hot it leaves them (0 to 1).
uniform vec4 uSwarmBlast;
// The stream: where along its path (`swarmStreamAt`), how high it is
// lifted, how strongly it drags particles along, and how far it reaches.
uniform vec4 uSwarmStream;
// 1 on the first step: every particle starts over, from the seed.
uniform float uSwarmReset;

void main() {
  ivec2 side = textureSize(uState, 0);
  ivec2 texel = ivec2(gl_FragCoord.xy);
  uint id = texelId(texel, side);
  uvec4 target = texelFetch(uState2, texel, 0);
  highp vec2 goal = uintBitsToFloat(target.xy);
  vec2 pullAndSize = unpackHalf2x16(target.z);
  vec4 tint = unpackColor(target.w);
  float aspect = uRes.x / uRes.y;

  if (uSwarmReset > 0.5) {
    // Every particle bursts out of a point in the middle toward where it
    // belongs, so a scene coming on blooms into its first shape.
    uint seed = hashU(id ^ seedU());
    float angle = unitU(seed) * TAU;
    float out_ = 0.4 + 1.6 * unitU(seed + 1u);
    highp vec2 at = 0.02 * vec2(cos(angle), sin(angle)) * unitU(seed + 2u);
    vec2 velocity = vec2(cos(angle), sin(angle)) * out_ + (goal - at) * 0.6;
    stateOut = uvec4(floatBitsToUint(at), packHalf2x16(velocity), packColor(vec4(tint.rgb, 1.0)));
    return;
  }

  uvec4 state = texelFetch(uState, texel, 0);
  highp vec2 at = uintBitsToFloat(state.xy);
  highp vec2 velocity = unpackHalf2x16(state.z);
  vec4 color = unpackColor(state.w);
  highp float dt = uSwarmForce.w;
  // Each particle its own: some lag, some lead, so a shape forms like a
  // flock settling rather than all at once.
  float own = unitU(id * 3u + 7u);
  // A particle spelling a word (pulled this hard: swarm_targets.glsl)
  // holds still on its letter: no swirl, the kicks' blasts barely move it,
  // and it settles without swinging past.
  float lettered = step(4.0, pullAndSize.x);

  // The spring toward the target, never so stiff that a long step (a slow
  // frame) would swing it past further than it started.
  float stiff = min(uSwarmForce.x * pullAndSize.x * (0.55 + 0.9 * own), 1.5 / (dt * dt));
  highp vec2 accel = (goal - at) * stiff;

  // Curl noise: the slope of the fractal noise turned a quarter, which
  // swirls without bunching particles up or spreading them out.
  vec2 slope = fbmSlope(at * 1.6 + vec2(uSeed * 7.0, uTime * 0.07));
  accel += vec2(slope.y, -slope.x) * uSwarmForce.y * (1.0 - lettered);

  // The stream drags what it passes along with it, and pulls it in a
  // little.
  if (uSwarmStream.z > 0.0) {
    highp float t = uSwarmStream.x;
    highp vec2 head = swarmStreamAt(t, uSwarmStream.y, aspect);
    highp vec2 ahead = swarmStreamAt(t + 0.05, uSwarmStream.y, aspect);
    highp vec2 toward = head - at;
    float reach = uSwarmStream.w;
    float caught = uSwarmStream.z * exp(-dot(toward, toward) / (reach * reach));
    accel += (toward * 6.0 + (ahead - head) * 700.0) * caught;
  }

  // A blast throws everything outward, the near harder, each particle a
  // little differently.
  highp vec2 away = at - uSwarmBlast.xy;
  float distance_ = length(away) + 0.03;
  velocity += away / distance_ * uSwarmBlast.z * (0.5 + own) * (0.4 + 0.6 * exp(-distance_ * 2.0))
    * (1.0 - 0.85 * lettered);

  velocity += accel * dt;
  velocity *= exp(-(uSwarmForce.z + 20.0 * lettered) * dt);
  // Never so fast a half can't hold it, or a step can't follow it.
  float speed = length(velocity);
  if (speed > 6.0) velocity *= 6.0 / speed;
  at += velocity * dt;
  // Just off the picture a soft wall turns particles back, so a blast
  // never loses them: they wait at the edges and stream back in.
  highp vec2 wall = vec2(0.62 * aspect, 0.62);
  highp vec2 past = at - clamp(at, -wall, wall);
  velocity -= past * 120.0 * dt;

  // It takes on its target's color over a fraction of a second, and cools.
  color.rgb = mix(color.rgb, tint.rgb, 1.0 - exp(-dt * 5.0));
  color.a = max(color.a * exp(-dt * 3.0), uSwarmBlast.w * (0.5 + 0.5 * own));
  stateOut = uvec4(floatBitsToUint(at), packHalf2x16(velocity), packColor(color));
}
