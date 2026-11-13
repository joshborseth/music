// THE SCREEN, last of all: the finished picture, drawn smaller by
// `final.glsl`, stretched to the TV's size. One read a pixel, because on a
// small TV GPU every full-size pass costs as much as a whole scene.
//
// It also lays down the shade the app's words need, which the UI would
// otherwise paint as three more full-screen layers on top: a light shade
// everywhere, then either a band behind the lyrics on the right (`uSide`)
// or a pool behind the song in the middle (`uCentre`). The stops match
// the Slint gradients they replace (`ui/app.slint`, NOW PLAYING).

uniform sampler2D uPicture;
uniform float uSide;
uniform float uCentre;

// The lyrics band's opacity across the screen, left to right.
float sideShade(float x) {
  if (x < 0.30) return mix(0.40, 0.078, x / 0.30);
  if (x < 0.46) return mix(0.078, 0.50, (x - 0.30) / 0.16);
  return mix(0.50, 0.60, (x - 0.46) / 0.54);
}

void main() {
  vec3 color = texture(uPicture, vUv).rgb;
  // Each shade covers what is under it, as the UI's layers did.
  float keep = 1.0 - 0.227;
  keep *= 1.0 - uSide * sideShade(vUv.x);
  // Slint's radial gradient reaches half the diagonal.
  float r = length(gl_FragCoord.xy - 0.5 * uRes) / (0.5 * length(uRes));
  keep *= 1.0 - uCentre * 0.50 * max(0.0, 1.0 - r / 0.6);
  color *= keep;
  // Fine grain at full size, so dark gradients never band.
  color += (hash12(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.012;
  fragColor = vec4(color, 1.0);
}
