// THE PICTURE: the scene (or two, while one dissolves into the next), glow,
// and the camera tricks that tie it all to the music: a punch in on the
// kick, a shake and the light closing in as a drop builds, a flash in the
// cover's color and split colors when it lands. Drawn at the scenes' size; `present.glsl` then
// stretches it to the TV's.

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform sampler2D uBloom;
uniform float uMix;
// 0 to 1: how much to show at all (fades in when the visuals start).
uniform float uFade;
// The shake as a drop builds, worked out once a frame (motion.rs).
uniform vec2 uShake;

void main() {
  // Kept highp: the reads land on the scenes' own pixels.
  highp vec2 c = vUv - 0.5;

  // Punch in on the kick; shake as a drop builds.
  c *= 1.0 - 0.018 * uKick * (0.4 + uEnergy) - 0.03 * uDrop;
  c += uShake;
  highp vec2 uv = c + 0.5;

  // Split the colors outward when a drop builds and lands. Until the split
  // reaches half a pixel in the corners, the scene is read once.
  float split = 0.006 * uDrop * uDrop * uDrop;
  vec3 a;
  vec3 b = vec3(0.0);
  if (split < 0.0005) {
    a = texture(uSceneA, uv).rgb;
    if (uMix > 0.0) b = texture(uSceneB, uv).rgb;
  } else {
    highp vec2 dir = c * split;
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

  color += texture(uBloom, uv).rgb * (0.4 + 0.35 * uEnergy + 0.5 * uDrop);

  // When a drop lands, flash in the cover's color. The flash is over in a
  // beat; the rest of the drop lives in the scenes.
  color += mix(uColorA, vec3(1.0), 0.3) * pow(uDrop, 10.0) * 0.55;

  // A soft curve so bright light rolls off instead of clipping, worked on
  // the brightest channel and applied to all three: a channel clipping on
  // its own would turn orange to yellow and teal to green. What the curve
  // takes past white burns toward white, as a hot light does.
  float peak = max(color.r, max(color.g, color.b));
  float rolled = 1.2 * peak / (1.0 + 0.3 * peak);
  color *= rolled / max(peak, 1e-4) / max(rolled, 1.0);
  color = mix(color, vec3(1.0), 0.35 * clamp(rolled - 1.0, 0.0, 1.0));
  // Dark corners, closing in as a drop builds. The grain comes later, at
  // full size.
  float vignette = smoothstep(1.05 - 0.4 * uTension, 0.25 - 0.1 * uTension, length(vec2(c) * vec2(1.0, 0.8)));
  color *= mix(0.55 - 0.25 * uTension, 1.0, vignette);
  fragColor = vec4(color * uFade, 1.0);
}
