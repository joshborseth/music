// BLOOM, step 1: the bright parts of the picture, at an eighth of the
// scenes' size. Reads both scenes during a change of scene: the frozen
// one leaving (`uSceneA`) and the one coming in (`uSceneB`). The alpha
// keeps how bright the picture is there on average, bright parts or not,
// which `final.glsl` uses to soften thin lines behind the lyrics; during
// a change, how bright the scene coming in is, whose shapes the datamosh
// drags the frozen frame along (`mosh.glsl`).

uniform sampler2D uSceneA;
uniform sampler2D uSceneB;
uniform float uMix;
uniform vec2 uTexel; // one pixel of the scenes, in texture units

// The 4 × 4 pixels around `uv` in `scene`: four taps between pixels make
// the box, which hides shimmering.
vec3 box(sampler2D scene, highp vec2 uv) {
  return 0.25 * (texture(scene, uv + uTexel * vec2(-1.0, -1.0)).rgb
    + texture(scene, uv + uTexel * vec2(1.0, -1.0)).rgb
    + texture(scene, uv + uTexel * vec2(-1.0, 1.0)).rgb
    + texture(scene, uv + uTexel * vec2(1.0, 1.0)).rgb);
}

float peakOf(vec3 color) {
  return max(color.r, max(color.g, color.b));
}

// The bright part of the 4 × 4 pixels around `uv`, each box cut on its
// own, so a thin bright line keeps its glow.
vec4 bright(highp vec2 uv, float knee) {
  vec3 color = box(uSceneA, uv);
  float incoming = peakOf(color);
  if (uMix > 0.0) {
    vec3 fresh = box(uSceneB, uv);
    incoming = peakOf(fresh);
    color = mix(color, fresh, uMix);
  }
  return vec4(color * smoothstep(knee, knee + 0.35, peakOf(color)), incoming);
}

void main() {
  float knee = 0.68 - 0.12 * uEnergy;
  // The 8 × 8 pixels under this one, as four boxes of 4 × 4.
  vec4 sum = bright(vUv + uTexel * vec2(-2.0, -2.0), knee)
    + bright(vUv + uTexel * vec2(2.0, -2.0), knee)
    + bright(vUv + uTexel * vec2(-2.0, 2.0), knee)
    + bright(vUv + uTexel * vec2(2.0, 2.0), knee);
  fragColor = sum * 0.25;
}
