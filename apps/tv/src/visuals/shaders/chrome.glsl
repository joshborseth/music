// CHROME: a liquid-metal creature. Blobs of mirror metal orbit and melt
// into each other, gathering into one on every bar's first beat; the
// spectrum ripples its skin, it flinches on the kick, and a drop blows it
// apart. It reflects a studio lit in the cover's colors.

float blobs(vec3 p) {
  float gather = pow(1.0 - fract(uBar), 2.0) * 0.6 + 0.4 - 0.4 * uDrop;
  float spread = (0.55 + 0.25 * uIntensity + 1.1 * uDrop) * (1.0 - 0.35 * gather);
  float d = 1e3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec3 orbit = vec3(
      sin(uDrive * (0.31 + fi * 0.07) + fi * 1.9),
      cos(uDrive * (0.27 + fi * 0.05) + fi * 2.7) * 0.7,
      sin(uDrive * (0.19 + fi * 0.09) + fi * 0.8)
    ) * spread;
    float level = uLevels[i];
    float radius = 0.27 + 0.16 * level + 0.05 * uKick;
    float sphere = length(p - orbit) - radius;
    // Melt together (smooth minimum).
    float k = 0.35 - 0.2 * uDrop;
    float h = clamp(0.5 + 0.5 * (sphere - d) / k, 0.0, 1.0);
    d = mix(sphere, d, h) - k * h * (1.0 - h);
  }
  return d;
}

float shape(vec3 p) {
  // Ripples on the skin, each direction its own band.
  vec3 n = normalize(p + 1e-4);
  float band = mix(uLevels[3], uLevels[7], n.y * 0.5 + 0.5);
  float ripple = sin(n.x * 9.0 + uDrive * 1.3) * sin(n.z * 9.0 - uDrive) * sin(n.y * 7.0 + uBeats * PI);
  return blobs(p) - ripple * (0.015 + 0.05 * band * uBands.w);
}

vec3 normalAt(vec3 p) {
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
  vec2 p = centered();
  float punch = 1.0 + 0.06 * uKick;
  vec3 eye = vec3(0.0, 0.0, -2.5 / punch);
  eye.xz = rot(uDrive * 0.07) * eye.xz;
  vec3 forward = normalize(-eye);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);
  vec3 dir = normalize(forward * 1.6 + right * p.x + up * p.y);

  float t = 0.0;
  float d = 1.0;
  float glow = 0.0;
  for (int i = 0; i < 56; i++) {
    d = shape(eye + dir * t);
    glow += exp(-d * 12.0) * 0.012;
    if (d < 0.002 || t > 7.0) break;
    t += d * 0.9;
  }

  vec3 color = studio(dir) * 0.35;
  // A halo around the metal in the cover's colors.
  color += palette(uTime * 0.03) * glow * (0.6 + 1.5 * uEnergy);
  if (d < 0.01) {
    vec3 at = eye + dir * t;
    vec3 n = normalAt(at);
    vec3 reflected = reflect(dir, n);
    float fresnel = pow(1.0 - max(dot(-dir, n), 0.0), 3.0);
    vec3 metal = studio(reflected) * mix(vec3(0.75), palette(n.y * 0.3 + 0.1), 0.35);
    color = metal * (0.65 + 0.6 * fresnel);
    color += palette(0.33) * fresnel * (0.2 + 0.8 * uAccent);
  }
  fragColor = vec4(color, 1.0);
}
