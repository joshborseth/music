// CORAL: a living reef that grows in time with the music. A
// reaction-diffusion (`coral_step.glsl`, run by `coral.rs` on a small grid,
// several steps a frame) grows spots, worms, and mazes; this pass lights
// it as if it stood up from the sea floor: its slope makes the light and
// shade, the grooves between go dark, and its wet ridges catch a
// highlight. Colonies across the reef take
// different colors of the cover, and the growing edge glows in its strong
// color, brighter on each kick.
//
// The kicks seed new growth where each lands, the lead melody draws a line
// of it, the bass changes what grows, a chord brightens it, and a drop
// bleaches the reef white before it grows back from the middle.
//
// One read of the reef a pixel, already turned into a filtered texture
// (`coral_field.glsl`), and two of the fractal noise (each two noises in
// one).

// The reef: red how much coral, green the food left, blue and alpha its
// slope across and up (0.5 is flat).
uniform sampler2D uState2;
// How bright the growing edge glows, how white a drop has left the reef,
// and the reef's grid in texels.
uniform vec4 uCoralLook;

void main() {
  highp vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = centered();
  vec4 reef = texture(uState2, uv);
  float coral = reef.r;
  float food = reef.g;
  vec2 slope = (reef.ba - 0.5) * 2.0;

  // Standing up: the coral is a height; its slope tilts the surface.
  float height = smoothstep(0.1, 0.7, coral);
  vec3 normal = normalize(vec3(-slope * 4.5, 1.0));
  vec3 light = normalize(vec3(-0.45, 0.6, 0.65));
  float diffuse = max(dot(normal, light), 0.0);
  float shine = pow(max(dot(reflect(-light, normal), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);

  // Colonies: across the reef the coral takes the cover's colors in turn.
  vec2 colony = fbm2(p * 1.3 + vec2(uSeed * 11.0, 3.0));
  vec3 hue = mix(uColorA, uColorD, smoothstep(0.35, 0.65, colony.x));
  hue = mix(hue, uColorB, 0.5 * smoothstep(0.55, 0.75, colony.y));

  // The sea floor: dark, light rippling down onto it, and a soft halo of
  // the colony's color where the coral has eaten the food around it.
  vec2 water = fbm2(p * 3.0 + vec2(uDrive * 0.03, uTime * 0.02));
  float shimmer = water.x;
  float ripples = smoothstep(0.6, 0.8, water.y);
  vec3 floor_ = uColorC * (0.03 + 0.05 * shimmer * shimmer + 0.05 * ripples)
    + hue * 0.07 * (1.0 - food) * (1.0 - height);

  // The coral: deep in its grooves, its color on the flanks, pale at the
  // tips, lit from above; wet, so the ridges shine.
  vec3 flesh = mix(hue * 0.22, hue, smoothstep(0.2, 0.8, coral));
  flesh = mix(flesh, mix(hue, vec3(1.0), 0.45), smoothstep(0.82, 1.0, coral) * 0.6);
  // A chord change lifts it for a moment.
  flesh *= 0.25 + 0.95 * diffuse + 0.3 * uChordChange;
  flesh += mix(hue, vec3(1.0), 0.6) * shine * (0.45 + 0.4 * uBright);

  // The growing edge, where coral meets food, glows on the kick.
  float edge = smoothstep(0.06, 0.3, coral) * (1.0 - smoothstep(0.3, 0.6, coral)) * smoothstep(0.45, 0.8, food);
  vec3 glowing = mix(uColorA, vec3(1.0), 0.2) * edge * uCoralLook.x * 0.6;

  vec3 color = mix(floor_, flesh, height) + glowing;
  // Bleached: pale and lit, the color gone, fading back as it regrows.
  vec3 bleached = vec3(0.82, 0.84, 0.86) * (0.2 + 0.8 * diffuse) * height + shine * 0.3;
  color = mix(color, bleached + uColorC * 0.04, uCoralLook.y);
  // Darker toward the edges of the picture, as if seen through water.
  color *= 1.0 - 0.4 * dot(p, p);
  fragColor = vec4(color, 1.0);
}
