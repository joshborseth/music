// THE PICTURE: the scene (or two, while one dissolves into the next), glow,
// and the camera tricks that tie it all to the music: a punch in on the
// kick, a shake and drained color as a drop builds, a flash and split
// colors when it lands. Drawn at the scenes' size; `present.glsl` then
// stretches it to the TV's.

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform sampler2D uBloom;
uniform float uMix;
// 0 to 1: how much to show at all (fades in when the visuals start).
uniform float uFade;

vec3 scenes(vec2 uv, float dissolve) {
  vec3 a = texture(uSceneA, uv).rgb;
  if (uMix <= 0.0) return a;
  vec3 b = texture(uSceneB, uv).rgb;
  return mix(a, b, dissolve);
}

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;

  // Punch in on the kick; shake as a drop builds.
  c *= 1.0 - 0.018 * uKick * (0.4 + uEnergy) - 0.03 * uDrop;
  float shake = uTension * uTension * 0.006;
  c += (vec2(noise(vec2(uTime * 23.0, 1.0)), noise(vec2(3.0, uTime * 27.0))) - 0.5) * shake;
  uv = c + 0.5;

  // The next scene shows through its brightest parts first.
  float dissolve = 0.0;
  if (uMix > 0.0) {
    vec3 b = texture(uSceneB, uv).rgb;
    float grain = noise(uv * vec2(uRes.x / uRes.y, 1.0) * 6.0 + uSeed * 50.0);
    float order = 0.55 * grain + 0.45 * (1.0 - dot(b, vec3(0.333)));
    dissolve = smoothstep(order - 0.12, order + 0.12, uMix * 1.24 - 0.12);
  }

  // Split the colors outward when a drop lands.
  float split = 0.0015 + 0.012 * pow(uDrop, 3.0) + 0.004 * uTension;
  vec2 dir = c * split;
  vec3 color;
  color.r = scenes(uv + dir, dissolve).r;
  color.g = scenes(uv, dissolve).g;
  color.b = scenes(uv - dir, dissolve).b;

  color += texture(uBloom, uv).rgb * (0.4 + 0.35 * uEnergy + 0.5 * uDrop);

  // As a drop builds, drain the color; when it lands, flash.
  float grey = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color, vec3(grey), 0.55 * uTension);
  // The flash is over in a beat; the rest of the drop lives in the scenes.
  color += mix(vec3(1.0), palette(uBeats * 0.1), 0.4) * pow(uDrop, 14.0) * 0.9;

  // A soft curve so bright light rolls off instead of clipping.
  color = color / (1.0 + 0.32 * color);
  color *= 1.18;
  // Dark corners. The grain comes later, at full size.
  float vignette = smoothstep(1.05, 0.25, length(c * vec2(1.0, 0.8)));
  color *= mix(0.55, 1.0, vignette);
  fragColor = vec4(color * uFade, 1.0);
}
