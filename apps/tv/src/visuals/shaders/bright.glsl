// BLOOM, step 1: the bright parts of the picture, at a quarter size. Reads
// both scenes during a change of scene.

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform float uMix;
uniform vec2 uTexel; // one pixel of the scenes, in texture units

vec3 scenes(vec2 uv) {
  vec3 a = texture(uSceneA, uv).rgb;
  return uMix > 0.0 ? mix(a, texture(uSceneB, uv).rgb, uMix) : a;
}

void main() {
  // Four taps between pixels: a 4 × 4 box, which hides shimmering.
  vec3 sum = scenes(vUv + uTexel * vec2(-1.0, -1.0))
    + scenes(vUv + uTexel * vec2(1.0, -1.0))
    + scenes(vUv + uTexel * vec2(-1.0, 1.0))
    + scenes(vUv + uTexel * vec2(1.0, 1.0));
  vec3 color = sum * 0.25;
  float bright = max(color.r, max(color.g, color.b));
  float knee = 0.68 - 0.12 * uEnergy;
  float keep = smoothstep(knee, knee + 0.35, bright);
  fragColor = vec4(color * keep, 1.0);
}
