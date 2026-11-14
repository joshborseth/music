// SWARM: tens of thousands of glowing particles in the cover's colors,
// forming shapes and breaking them on the music (`swarm.rs` choreographs,
// `swarm_targets.glsl` makes the shapes, `particles_update.glsl` moves
// them). The cover made of light, a galaxy, the spectrum as rings, a
// rippling grid. Kicks blow the shape outward, snares swirl it, hi-hats
// make it sparkle, the lead melody drags a stream across the picture, and
// a drop blows it all apart until the next downbeat, when it snaps back.
//
// This pass draws what is under the particles: their trails (the last
// frame, fading) and a faint haze in the cover's deep color. The
// particles are added on top as points. One read a pixel.

// How much of the last frame stays (worked out for this frame's length).
uniform float uSwarmTrail;

void main() {
  vec2 p = centered();
  // Kept highp: where to read the last frame, which must land on its
  // pixels or the trails smear.
  highp vec2 uv = gl_FragCoord.xy / uRes;
  // On a kick and through a drop, the trails stream outward a little.
  highp vec2 back = 0.5 + (uv - 0.5) * (1.0 - 0.006 * uHit - 0.012 * uDrop);
  vec3 trail = texture(uPrev, back).rgb;
  // Fade, and take a step more so the last dim pixels go black instead of
  // sticking at the 8-bit floor.
  trail = max(trail * uSwarmTrail - 1.5 / 255.0, 0.0);

  // A faint haze behind, drifting.
  float haze = fbm(p * 1.8 + vec2(uDrive * 0.015, uSeed * 9.0));
  vec3 under = mix(uColorC, uColorD, haze) * (0.012 + 0.03 * haze * haze) * (1.0 + 0.5 * uEnergy);
  under *= exp(-dot(p, p) * 2.5);
  fragColor = vec4(max(trail, under), 1.0);
}
