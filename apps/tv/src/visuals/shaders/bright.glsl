// BLOOM, step 1: the bright parts of the picture, at an eighth of the
// scenes' size. Reads both scenes during a change of scene.

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform float uMix;
uniform vec2 uTexel; // one pixel of the scenes, in texture units

vec3 scenes(highp vec2 uv) {
  vec3 a = texture(uSceneA, uv).rgb;
  return uMix > 0.0 ? mix(a, texture(uSceneB, uv).rgb, uMix) : a;
}

// The bright part of the 4 × 4 pixels around `uv`: four taps between
// pixels make the box, which hides shimmering, and each box is cut on its
// own, so a thin bright line keeps its glow.
vec3 bright(highp vec2 uv, float knee) {
  vec3 color = 0.25 * (scenes(uv + uTexel * vec2(-1.0, -1.0))
    + scenes(uv + uTexel * vec2(1.0, -1.0))
    + scenes(uv + uTexel * vec2(-1.0, 1.0))
    + scenes(uv + uTexel * vec2(1.0, 1.0)));
  float peak = max(color.r, max(color.g, color.b));
  return color * smoothstep(knee, knee + 0.35, peak);
}

void main() {
  float knee = 0.68 - 0.12 * uEnergy;
  // The 8 × 8 pixels under this one, as four boxes of 4 × 4.
  vec3 sum = bright(vUv + uTexel * vec2(-2.0, -2.0), knee)
    + bright(vUv + uTexel * vec2(2.0, -2.0), knee)
    + bright(vUv + uTexel * vec2(-2.0, 2.0), knee)
    + bright(vUv + uTexel * vec2(2.0, 2.0), knee);
  fragColor = vec4(sum * 0.25, 1.0);
}
