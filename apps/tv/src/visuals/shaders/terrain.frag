// TERRAIN (land): each pixel of the mesh adds only the grid lines; the
// rest was worked out at its points (terrain.vert). No reads.

precision mediump float;

in highp vec2 vCell;
in vec3 vBase;
in vec3 vLine;
in float vWidth;
out vec4 fragColor;

void main() {
  vec2 g = abs(fract(vCell) - 0.5);
  float line = 1.0 - smoothstep(0.0, vWidth, min(g.x, g.y));
  fragColor = vec4(vBase + vLine * line, 1.0);
}
