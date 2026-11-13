// THE SCREEN, last of all: the finished picture, drawn smaller by
// `final.glsl`, stretched to the TV's size, with a fine grain. It is the
// only pass at the screen's size, two million pixels, so it does as little
// as a pass can: one read and a few sums a pixel. Everything else, the
// shade the app's words need included, is in the picture already.

uniform sampler2D uPicture;

void main() {
  vec3 color = texture(uPicture, vUv).rgb;
  // Fine grain at full size, so dark gradients never band: interleaved
  // gradient noise, a few sums a pixel where a hash took a dozen.
  highp float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  fragColor = vec4(color + (float(grain) - 0.5) * 0.012, 1.0);
}
