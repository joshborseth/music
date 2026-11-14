// Comes after common.glsl in every fragment shader. From here on a plain
// `float` is mediump, which a TV's GPU (Mali) runs at twice the rate of
// highp. See common.glsl for what has to stay highp.

precision mediump float;

in highp vec2 vUv;
// At location 0, so a pass may add a second output (the datamosh does).
layout(location = 0) out vec4 fragColor;

// Centered coordinates: y runs -0.5 to 0.5, x keeps the aspect.
highp vec2 centered() {
  return (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
}
