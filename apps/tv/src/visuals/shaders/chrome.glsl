// CHROME: a liquid-metal creature. Blobs of mirror metal orbit and melt
// into each other, gathering into one on every bar's first beat; the
// spectrum ripples its skin, it flinches on the kick, and a drop blows it
// apart. It reflects a studio lit in the cover's colors.
//
// Worked out once a frame (motion.rs): each blob's centre and radius, how
// far they melt into each other, the camera (where it is, then its right,
// up, and forward), and how much bigger than each blob a ball must be to
// hold its share of the shape, its ripples, and its glow. A ray marches
// only from the first such ball it enters to the last it leaves, at most
// `STEPS`; the background around the creature takes no steps at all.
//
// Marching stays highp: positions run to about 3, where mediump only
// tells apart steps of 0.002, as large as the distance that counts as a
// hit, and the normals would come out as noise.

uniform vec4 uBlobs[5];
uniform float uMelt;
uniform vec3 uCamera[4];
uniform float uMargin;

const int STEPS = 30;

highp float blobs(highp vec3 p) {
  highp float d = 1e3;
  for (int i = 0; i < 5; i++) {
    highp float sphere = length(p - uBlobs[i].xyz) - uBlobs[i].w;
    // Melt together (smooth minimum).
    highp float h = clamp(0.5 + 0.5 * (sphere - d) / uMelt, 0.0, 1.0);
    d = mix(sphere, d, h) - uMelt * h * (1.0 - h);
  }
  return d;
}

// The most the skin ripples out, anywhere, this frame.
float rippleReach() {
  return 0.015 + 0.05 * max(uLevels[3], uLevels[7]) * uBands.w;
}

// Ripples on the skin, each direction its own band.
highp float ripple(highp vec3 p) {
  vec3 n = normalize(p + 1e-4);
  float band = mix(uLevels[3], uLevels[7], n.y * 0.5 + 0.5);
  float wave = sin(n.x * 9.0 + uDrive * 1.3) * sin(n.z * 9.0 - uDrive) * sin(n.y * 7.0 + uBeats * PI);
  return wave * (0.015 + 0.05 * band * uBands.w);
}

highp float shape(highp vec3 p) {
  return blobs(p) - ripple(p);
}

highp vec3 normalAt(highp vec3 p) {
  const vec2 e = vec2(0.002, -0.002);
  return normalize(
    e.xyy * shape(p + e.xyy) + e.yyx * shape(p + e.yyx) +
    e.yxy * shape(p + e.yxy) + e.xxx * shape(p + e.xxx)
  );
}

// The studio the metal reflects: a dark room, bands of colored light, and a
// floor glowing on the beat.
vec3 studio(vec3 dir) {
  float up = dir.y * 0.5 + 0.5;
  vec3 color = mix(uColorC * 0.04, uColorB * 0.2, up);
  float a = atan(dir.z, dir.x);
  float strips = pow(max(0.0, sin(a * 3.0 + uDrive * 0.2)), 40.0) * smoothstep(0.1, 0.5, dir.y);
  color += palette(a / TAU + uTime * 0.02) * strips * (1.5 + 2.0 * uBeatPulse);
  color += uColorA * pow(max(dir.y, 0.0), 12.0) * 3.0;
  color += palette(0.66) * smoothstep(-0.2, -0.9, dir.y) * (0.15 + 0.8 * uBeatPulse);
  return color;
}

void main() {
  highp vec2 p = centered();
  highp vec3 eye = uCamera[0];
  highp vec3 dir = normalize(uCamera[3] * 1.6 + uCamera[1] * p.x + uCamera[2] * p.y);

  // Where the ray first enters a blob's grown ball, and last leaves one.
  highp float enter = 1e3;
  highp float leave = -1.0;
  for (int i = 0; i < 5; i++) {
    highp vec3 from = eye - uBlobs[i].xyz;
    highp float grown = uBlobs[i].w + uMargin;
    highp float b = dot(from, dir);
    highp float inside = b * b - dot(from, from) + grown * grown;
    if (inside > 0.0) {
      highp float span = sqrt(inside);
      enter = min(enter, -b - span);
      leave = max(leave, -b + span);
    }
  }
  highp float d = 1.0;
  highp float t = 0.0;
  // How close the ray came to the metal, for its glow.
  highp float nearest = 1.0;
  if (leave > 0.0) {
    t = max(enter, 0.0);
    highp float end = leave;
    float reach = rippleReach();
    highp float last = 1e3;
    for (int i = 0; i < STEPS; i++) {
      highp vec3 at = eye + dir * t;
      d = blobs(at);
      // Away from the skin its ripples can't reach the ray: step past
      // them in one go. Close to it, follow the skin itself, a little
      // short of each step, as the shape is only roughly a distance.
      highp float advance = d - reach;
      if (advance < 0.04) {
        d -= ripple(at);
        advance = d * 0.9;
        // Between this step and the last, the ray came closer than either
        // (where it ran past the metal): estimate how close.
        highp float y = d * d / (2.0 * last);
        if (y < d) nearest = min(nearest, sqrt(d * d - y * y));
      }
      last = d;
      nearest = min(nearest, d);
      if (d < 0.002 || t > end) break;
      t += advance;
    }
  }

  vec3 color;
  if (d < 0.01) {
    highp vec3 at = eye + dir * t;
    vec3 n = normalAt(at);
    vec3 reflected = reflect(vec3(dir), n);
    float fresnel = pow(1.0 - max(dot(-vec3(dir), n), 0.0), 3.0);
    vec3 metal = studio(reflected) * mix(vec3(0.75), palette(n.y * 0.3 + 0.1), 0.35);
    color = metal * (0.65 + 0.6 * fresnel);
    color += palette(0.33) * fresnel * (0.2 + 0.8 * uAccent);
  } else {
    color = studio(vec3(dir)) * 0.35;
    // A halo around the metal in the cover's colors: a thin bright rim
    // that fades quickly, by how close the ray passed. (It used to add up
    // a little at every step, and steps crowd in where a ray grazes the
    // metal, about one over the square root of how close it came.)
    float near = max(nearest, 0.0002);
    float glow = min(0.024 * inversesqrt(near), 0.6) * exp(-near * 16.0);
    color += palette(uTime * 0.03) * glow * (0.6 + 1.5 * uEnergy);
  }
  fragColor = vec4(color, 1.0);
}
