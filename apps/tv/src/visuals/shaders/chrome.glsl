// CHROME: a liquid-metal creature. Blobs of mirror metal orbit and melt
// into each other, gathering into one on every bar's first beat; the
// spectrum ripples its skin, it flinches on the kick, and a drop blows it
// apart. It mirrors a studio lit in the cover's colors: a bright sky over a
// horizon, a dark floor, and a hard light that flares on the beat.
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

// The studio the metal mirrors, by direction (y up): a sky that glows in
// the cover's color at the horizon and darkens above, with wide soft
// lights drifting across it; a sharp bright horizon; a dark floor that
// glows on the beat. Only smooth light, so the metal shows its shape, not
// a picture. No reads.
vec3 studio(vec3 dir) {
  float y = dir.y;
  vec3 sky = mix(uColorA * 0.85, uColorC * 0.1, smoothstep(0.0, 0.7, y));
  float soft = 0.5 + 0.5 * sin(dir.x * 2.6 + dir.z * 1.7 + uDrive * 0.15);
  sky += mix(uColorA, vec3(1.0), 0.25) * (soft * soft * 0.45 * smoothstep(0.08, 0.5, y));
  vec3 ground = mix(uColorC * 0.1, uColorB * 0.4, smoothstep(-0.6, 0.0, y));
  ground += uColorC * (1.0 - smoothstep(-0.9, -0.3, y)) * 0.6 * uBeatPulse;
  vec3 color = mix(ground, sky, smoothstep(-0.015, 0.015, y));
  color += mix(uColorA, vec3(1.0), 0.4) * exp(-abs(y) * 45.0) * 0.7;
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
  // Which way is out, shorter where blobs meet and their ways cancel: the
  // surface there faces you instead of flipping over.
  vec2 outward = vec2(way);

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
    // Behind it, the dark room, lighter toward the top.
    color = mix(uColorC * 0.025, uColorB * 0.09, smoothstep(-0.5, 0.6, float(p.y)));
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
    vec2 tilt = outward * edge;
    vec3 n = vec3(tilt, sqrt(max(1.0 - dot(tilt, tilt), 0.0)));
    vec3 reflected = reflect(vec3(view), n);
    float grazing = 1.0 - max(dot(-vec3(view), n), 0.0);
    float fresnel = grazing * grazing * grazing;
    // The studio turns with the camera; the metal mirrors most of it, and
    // all of it where it turns away.
    vec3 room = studio(uCamera[1] * reflected.x + uCamera[2] * reflected.y - uCamera[3] * reflected.z);
    vec3 metal = room * mix(vec3(0.8), mix(vec3(1.0), uColorA, 0.25), fresnel);
    // A bright rim where the metal turns away, hotter on sharp hits.
    metal += mix(uColorA, vec3(1.0), 0.35) * fresnel * grazing * (0.7 + 0.9 * uAccent);
    // A hard light above and to the left: a crisp spot with a soft bloom
    // round it, flaring on the beat.
    float light = max(dot(reflected, vec3(-0.36, 0.62, 0.7)), 0.0);
    float glint = light * light;
    glint *= glint;
    float spot = glint * glint * glint * glint;
    spot *= spot;
    metal += mix(vec3(1.0), uColorA, 0.15) * (spot * spot * (2.5 + 3.5 * uBeatPulse) + glint * 0.12);
    color = mix(color, metal, solid);
  }
  fragColor = vec4(color, 1.0);
}
