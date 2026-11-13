// CHROME: a liquid-metal creature. Blobs of mirror metal orbit and melt
// into each other, gathering into one on every bar's first beat; the
// spectrum ripples its skin, it flinches on the kick, and a drop blows it
// apart. It reflects a studio lit in the cover's colors, and the cover.
//
// The blobs move in 3D, but motion.rs sees them through the camera once a
// frame and hands over where each shows on the picture and how big
// (`uBlobs`). Here each pixel finds how far it is from each blob's disc
// and melts the five together (a smooth minimum), keeping which way is out
// and how big the blob it is in is. Inside is metal: how deep in, and which
// way is out, make the normal of a rounded surface, which reflects the
// room. A few sums a blob, where marching the shape in 3D took up to thirty
// steps against all five.

uniform vec3 uBlobs[5]; // centre on the picture (`centered()` units), radius
uniform float uMelt;    // how far blobs melt into each other, the same units
uniform vec3 uCamera[4]; // where the camera is, then its right, up, forward

// Chrome's lens (motion.rs, `FOCAL`).
const float FOCAL = 1.6;

// The studio the metal reflects: a dark room, bands of colored light, and a
// floor glowing on the beat.
vec3 studio(vec3 dir) {
  float up = dir.y * 0.5 + 0.5;
  vec3 color = mix(uColorC * 0.04, uColorB * 0.2, up);
  float a = atan(dir.z, dir.x);
  float strips = pow(max(0.0, sin(a * 3.0 + uDrive * 0.2)), 40.0) * smoothstep(0.1, 0.5, dir.y);
  color += palette(a / TAU + uTime * 0.02) * strips * (1.5 + 2.0 * uBeatPulse);
  color += uColorA * pow(max(dir.y, 0.0), 12.0) * 3.0;
  // (The floor once took palette(0.66): uColorC to a thousandth.)
  color += uColorC * smoothstep(-0.2, -0.9, dir.y) * (0.15 + 0.8 * uBeatPulse);
  return color;
}

void main() {
  highp vec2 p = centered();

  // How far out of the metal (negative inside), which way is out, and how
  // big the blob here is, each melted across the blobs. Kept highp: the
  // edge is found to a fraction of a pixel.
  highp float away = 1e3;
  highp vec2 way = vec2(0.0);
  highp float size = 0.0;
  for (int i = 0; i < 5; i++) {
    highp vec2 d = p - uBlobs[i].xy;
    highp float len = max(length(d), 1e-4);
    highp float disc = len - uBlobs[i].z;
    // The smooth minimum, and the same blend for the rest: its slope is
    // exactly the two slopes blended so.
    highp float h = clamp(0.5 + 0.5 * (away - disc) / uMelt, 0.0, 1.0);
    away = mix(away, disc, h) - uMelt * h * (1.0 - h);
    way = mix(way, d / len, h);
    size = mix(size, uBlobs[i].z, h);
  }
  vec2 outward = normalize(vec2(way) + vec2(0.0, 1e-4));

  // Ripples on the skin, each way from the middle its own band. Right in
  // the middle every way is near, so they calm there instead of spiking.
  float middle = length(vec2(p));
  vec2 around = vec2(p) / max(middle, 1e-3);
  float band = mix(uLevels[3], uLevels[7], around.y * 0.5 + 0.5);
  float wave = sin(around.x * 9.0 + uDrive * 1.3) * sin(around.y * 7.0 + uBeats * PI);
  wave *= smoothstep(0.0, 0.25, middle);
  away -= wave * (0.015 + 0.05 * band * uBands.w) * FOCAL / 2.5;

  // The edge is smoothed over a pixel.
  float solid = clamp(0.5 - away * uRes.y, 0.0, 1.0);

  // The ray through this pixel, the camera's way: x right, y up, z back
  // toward the viewer.
  highp vec3 view = normalize(vec3(p, -FOCAL));
  vec3 color = vec3(0.0);
  if (solid < 1.0) {
    highp vec3 world = uCamera[3] * FOCAL + uCamera[1] * p.x + uCamera[2] * p.y;
    color = studio(normalize(vec3(world))) * 0.35;
    // A halo around the metal in the cover's colors: a thin bright rim
    // that fades quickly, by how far the metal is (in the scene's units,
    // about the middle's distance away).
    float near = max(float(away) * 2.5 / FOCAL, 0.0002);
    float glow = min(0.024 * inversesqrt(near), 0.6) * exp(-near * 16.0);
    color += palette(uTime * 0.03) * glow * (0.6 + 1.5 * uEnergy);
  }
  if (solid > 0.0) {
    // How far from the middle toward the edge, 0 to 1: a ball's normal.
    float edge = clamp(1.0 + float(away) / max(float(size), 1e-3), 0.0, 1.0);
    vec3 n = vec3(outward * edge, sqrt(1.0 - edge * edge));
    vec3 reflected = reflect(vec3(view), n);
    float fresnel = pow(1.0 - max(dot(-vec3(view), n), 0.0), 3.0);
    // The studio turns with the camera.
    vec3 room = studio(uCamera[1] * reflected.x + uCamera[2] * reflected.y - uCamera[3] * reflected.z);
    // The cover, as if it hung round the room: across the ball by which
    // way the light bounces (smooth even where the metal turns away), its
    // darks pushed down so the metal keeps its contrast.
    if (uHasCover > 0.5) {
      vec3 seen = saturate3(cover(reflected.xy * 0.45 + 0.5), 1.3);
      room += seen * seen * (0.6 + 0.6 * fresnel);
    }
    // A hard light above and to the left, flaring on the beat.
    float light = max(dot(reflected, vec3(-0.36, 0.62, 0.7)), 0.0);
    room += mix(vec3(1.0), uColorA, 0.3) * pow(light, 24.0) * (1.2 + 1.5 * uBeatPulse);
    vec3 metal = room * mix(vec3(0.75), palette(n.y * 0.3 + 0.1), 0.35);
    // (The rim once took palette(0.33): uColorB to a thousandth.)
    metal = metal * (0.55 + 0.7 * fresnel) + uColorB * fresnel * (0.2 + 0.8 * uAccent);
    color = mix(color, metal, solid);
  }
  fragColor = vec4(color, 1.0);
}
