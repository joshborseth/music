//! The Diorama scene's own parts: the cover's depth, as the server works
//! it out (`GET /tv/depth`), the camera that drifts round the relief, and
//! the shatter on a drop. The shaders are `shaders/diorama.*`; the lab
//! (`apps/tv/visuals-lab/diorama.ts`) works out the same camera and
//! shatter; keep the two in step.

use std::f32::consts::TAU;

use super::look::COVER_SIDE;
use super::music::Music;

/// The relief's grid (`diorama.vert`): squares across and down, over the
/// cover and past its edges.
const COLUMNS: i32 = 66 + 2 * 32;
const ROWS: i32 = 66 + 2 * 12;
/// Whole, it is drawn as a triangle strip a row, joined by empty
/// triangles; shattering, as two triangles a square, three points each.
const STRIP_POINTS: i32 = ROWS * (2 * (COLUMNS + 1) + 2) - 2;
const SHARD_POINTS: i32 = COLUMNS * ROWS * 6;

/// How to draw the relief with the shatter at `shatter` (`Shatter::now`):
/// the primitive and the points, as `diorama.vert` reads them. Only a
/// shattering relief leaves gaps for the backdrop to show through.
pub fn relief_draw(shatter: [f32; 2]) -> (u32, i32) {
    if shatter[1] > 0.0 {
        (glow::TRIANGLES, SHARD_POINTS)
    } else {
        (glow::TRIANGLE_STRIP, STRIP_POINTS)
    }
}
/// How far the nearest part of the cover stands out (`RELIEF`), the cover
/// being 2 across.
const RELIEF: f32 = 0.62;
/// The shatter lasts this many beats: two bars.
const SHATTER_BEATS: f32 = 8.0;
/// The share of the cover, by depth, that counts as its nearest subject.
const NEAREST_SHARE: f32 = 0.08;

/// A cover's depth: `COVER_SIDE` × `COVER_SIDE` bytes, row by row from
/// the top like the cover's pixels, near bright.
pub struct Depth {
    pub pixels: Vec<u8>,
    /// The nearest subject: across and up the cover (0 to 1, y up), and
    /// how near (0 to 1). The camera closes on it as a drop builds.
    pub focus: [f32; 3],
}

impl Depth {
    /// The server's PNG, decoded (off the UI thread), at the cover's size.
    pub fn decode(png: &[u8]) -> Option<Self> {
        let image = image::load_from_memory(png).ok()?;
        let side = COVER_SIDE as u32;
        let image = if image.width() == side && image.height() == side {
            image
        } else {
            image.resize_exact(side, side, image::imageops::FilterType::Triangle)
        };
        Some(Self::new(image.to_luma8().into_raw()))
    }

    pub fn new(pixels: Vec<u8>) -> Self {
        let focus = nearest_subject(&pixels);
        Self { pixels, focus }
    }
}

/// The middle of the nearest `NEAREST_SHARE` of the cover, each pixel
/// weighed by the square of how much nearer it is than the rest (so a small
/// near figure outweighs a wide plain behind it), and its depth. Pixels
/// near the cover's edges count less, and not at all at the very edge:
/// what stands nearest there is mostly the ground or a body cut off by
/// the frame, while the face the camera should close on is further in.
fn nearest_subject(pixels: &[u8]) -> [f32; 3] {
    let side = COVER_SIDE;
    if pixels.len() != side * side {
        return [0.5, 0.5, 0.5];
    }
    let mut counts = [0usize; 256];
    for &value in pixels {
        counts[usize::from(value)] += 1;
    }
    let wanted = (pixels.len() as f32 * NEAREST_SHARE) as usize;
    let mut seen = 0;
    let mut threshold = 255;
    for value in (0..256).rev() {
        seen += counts[value];
        if seen >= wanted {
            threshold = value;
            break;
        }
    }
    let (mut x, mut y, mut depth, mut sum) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for (index, &value) in pixels.iter().enumerate() {
        if usize::from(value) < threshold {
            continue;
        }
        let across = ((index % side) as f32 + 0.5) / side as f32;
        let down = ((index / side) as f32 + 0.5) / side as f32;
        let middle = 1.0 - smoothstep(0.25, 0.48, (across - 0.5).abs().max((down - 0.5).abs()));
        let weight = (1.0 + f32::from(value) - threshold as f32).powi(2) * middle;
        x += weight * across;
        y += weight * down;
        depth += weight * f32::from(value);
        sum += weight;
    }
    if sum <= 1e-3 {
        return [0.5, 0.5, 0.5];
    }
    [x / sum, 1.0 - y / sum, depth / sum / 255.0]
}

fn smoothstep(from: f32, to: f32, x: f32) -> f32 {
    let t = ((x - from) / (to - from)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The shatter on a drop: when the last one landed, and how hard.
#[derive(Debug, Default, Clone, Copy)]
pub struct Shatter {
    landed: Option<(f32, f32)>,
}

impl Shatter {
    /// Note this frame's music: a drop landing while Diorama shows alone
    /// (`alone`) starts a shatter, as hard as the drop (a calm song's
    /// barely loosens the picture). A drop that changes the scene is the
    /// change's to shatter: Diorama coming in on it starts whole, and one
    /// leaving is frozen.
    pub fn hear(&mut self, music: &Music, alone: bool) {
        if music.drop_landed && alone {
            self.landed = Some((music.beats, music.drop.clamp(0.0, 1.0)));
        }
    }

    /// The shatter now (`uDioramaShatter`): how far through it, 0 to 1 over
    /// two bars, and how hard; none outside it, or after a seek back.
    pub fn now(&self, music: &Music) -> [f32; 2] {
        match self.landed {
            Some((at, strength)) => {
                let through = (music.beats - at) / SHATTER_BEATS;
                if (0.0..1.0).contains(&through) {
                    [through, strength]
                } else {
                    [0.0, 0.0]
                }
            }
            None => [0.0, 0.0],
        }
    }
}

/// The camera, worked out once a frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    /// The projection and view, column by column (`uDioramaView`).
    pub view: [f32; 16],
    /// The eye, and how far it has swung round, in radians (`uDioramaEye`).
    pub eye: [f32; 4],
}

impl Camera {
    /// Orbiting slowly with the bars (round and back over eight), drifting
    /// on top; pushing in a little on each beat; closing on the nearest
    /// subject as a drop builds; and on the snare, wiggling between two
    /// eyes, a wigglegram, so the depth shows at once. It swings round a
    /// point inside the relief, so the near and far parts slide against
    /// each other.
    pub fn new(music: &Music, seed: f32, focus: [f32; 3], aspect: f32, hit: f32) -> Self {
        let bars = music.beats / 4.0;
        let snare = music.parts.snare;
        let yaw = 0.22 * (TAU * bars / 8.0 + seed * TAU).sin()
            + 0.08 * (music.time * 0.07).sin()
            + 0.07 * snare * (snare * 18.0).sin();
        let pitch = -0.05 + 0.1 * (TAU * bars / 12.0 + seed * 5.0).sin();
        let tension = music.tension.clamp(0.0, 1.0);
        let home = [0.0, 0.0, RELIEF * 0.35];
        let subject = [
            focus[0] * 2.0 - 1.0,
            focus[1] * 2.0 - 1.0,
            RELIEF * focus[2],
        ];
        let toward = 0.15 + 0.7 * tension;
        let at = [0, 1, 2].map(|axis| home[axis] + (subject[axis] - home[axis]) * toward);
        let distance = 2.25 * (1.0 - 0.07 * hit) - 0.9 * tension * tension.sqrt();
        let eye = [
            at[0] + distance * yaw.sin() * pitch.cos(),
            at[1] + distance * pitch.sin(),
            at[2] + distance * yaw.cos() * pitch.cos(),
        ];
        Self {
            view: view_matrix(eye, at, aspect),
            eye: [eye[0], eye[1], eye[2], yaw],
        }
    }
}

/// The lens: how far a point one unit off the middle of the view, one unit
/// ahead, lands from the middle of the picture (its height being 2).
const FOCAL: f32 = 2.3;
const NEAR: f32 = 0.05;
const FAR: f32 = 12.0;

/// Projection times view, looking from `eye` at `at`, up being up, column
/// by column as GL takes it.
fn view_matrix(eye: [f32; 3], at: [f32; 3], aspect: f32) -> [f32; 16] {
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f32; 3], b: [f32; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let normalize = |a: [f32; 3]| {
        let length = dot(a, a).sqrt().max(1e-6);
        [a[0] / length, a[1] / length, a[2] / length]
    };
    let forward = normalize(sub(at, eye));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let x_scale = FOCAL / aspect.max(1e-3);
    let depth_scale = (FAR + NEAR) / (FAR - NEAR);
    let depth_shift = -2.0 * FAR * NEAR / (FAR - NEAR);
    // Rows of the product: x, y, depth, and w (the distance ahead).
    let rows = [
        (
            right.map(|value| value * x_scale),
            -dot(right, eye) * x_scale,
            0.0,
        ),
        (up.map(|value| value * FOCAL), -dot(up, eye) * FOCAL, 0.0),
        (
            forward.map(|value| value * depth_scale),
            -dot(forward, eye) * depth_scale,
            depth_shift,
        ),
        (forward, -dot(forward, eye), 0.0),
    ];
    let mut columns = [0.0; 16];
    for (row, (axes, shift, extra)) in rows.into_iter().enumerate() {
        for column in 0..3 {
            columns[column * 4 + row] = axes[column];
        }
        columns[12 + row] = shift + extra;
    }
    columns
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(view: &[f32; 16], point: [f32; 3]) -> [f32; 4] {
        let mut out = [0.0; 4];
        for (row, value) in out.iter_mut().enumerate() {
            *value = view[row] * point[0]
                + view[4 + row] * point[1]
                + view[8 + row] * point[2]
                + view[12 + row];
        }
        out
    }

    #[test]
    fn a_png_from_the_server_decodes_at_the_cover_size() {
        // A ramp, dark at the top, at half the size: it comes out full size.
        let image = image::GrayImage::from_fn(128, 128, |_, y| image::Luma([(y * 2) as u8]));
        let mut png = Vec::new();
        image::DynamicImage::ImageLuma8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let depth = Depth::decode(&png).unwrap();
        assert_eq!(depth.pixels.len(), COVER_SIDE * COVER_SIDE);
        assert!(depth.pixels[0] < 4);
        assert!(depth.pixels[COVER_SIDE * COVER_SIDE - 1] > 248);
        // The nearest part is low down, across the middle: the very bottom
        // edge counts for nothing.
        let [x, y, near] = depth.focus;
        assert!((x - 0.5).abs() < 0.02, "{:?}", depth.focus);
        assert!(y > 0.02 && y < 0.25 && near > 0.75, "{:?}", depth.focus);
        assert!(Depth::decode(b"not a png").is_none());
    }

    #[test]
    fn the_focus_finds_a_near_figure() {
        // Far everywhere, but a near square in the upper left quarter.
        let mut pixels = vec![30u8; COVER_SIDE * COVER_SIDE];
        for y in 40..80 {
            for x in 50..90 {
                pixels[y * COVER_SIDE + x] = 230;
            }
        }
        let [x, y, near] = Depth::new(pixels).focus;
        assert!((x - 70.0 / 256.0).abs() < 0.01);
        assert!((y - (1.0 - 60.0 / 256.0)).abs() < 0.01);
        assert!((near - 230.0 / 255.0).abs() < 0.01);
    }

    fn music_at(beats: f32) -> Music {
        let mut music = super::super::music::Listener::new().hear(1.0 / 60.0, None);
        music.beats = beats;
        music
    }

    #[test]
    fn a_drop_shatters_the_picture_for_two_bars() {
        let mut shatter = Shatter::default();
        let mut music = music_at(100.0);
        assert_eq!(shatter.now(&music), [0.0, 0.0]);
        music.drop_landed = true;
        music.drop = 0.9;
        // Coming in on the drop, it starts whole.
        shatter.hear(&music, false);
        assert_eq!(shatter.now(&music), [0.0, 0.0]);
        shatter.hear(&music, true);
        assert_eq!(shatter.now(&music), [0.0, 0.9]);
        let later = music_at(104.0);
        assert_eq!(shatter.now(&later), [0.5, 0.9]);
        assert_eq!(shatter.now(&music_at(108.5)), [0.0, 0.0]);
        // Seeking back before it ends it too.
        assert_eq!(shatter.now(&music_at(90.0)), [0.0, 0.0]);
    }

    #[test]
    fn the_camera_frames_the_cover_and_closes_in_as_a_drop_builds() {
        let focus = [0.7, 0.6, 0.9];
        let mut music = music_at(0.0);
        let calm = Camera::new(&music, 0.0, focus, 16.0 / 9.0, 0.0);
        // The cover's middle is in view, ahead of the eye.
        let middle = project(&calm.view, [0.0, 0.0, 0.2]);
        assert!(middle[3] > 1.0);
        assert!((middle[0] / middle[3]).abs() < 0.5 && (middle[1] / middle[3]).abs() < 0.5);
        // Its corners reach near the picture's top and bottom.
        let top = project(&calm.view, [0.0, 1.0, 0.0]);
        assert!(top[1] / top[3] > 0.6, "{top:?}");
        // Inside the depth range.
        assert!((-1.0..1.0).contains(&(middle[2] / middle[3])));
        music.tension = 1.0;
        let built = Camera::new(&music, 0.0, focus, 16.0 / 9.0, 0.0);
        let subject = [0.4, 0.2, 0.62 * 0.9];
        let distance = |camera: &Camera| {
            let [x, y, z, _] = camera.eye;
            ((x - subject[0]).powi(2) + (y - subject[1]).powi(2) + (z - subject[2]).powi(2)).sqrt()
        };
        assert!(distance(&built) < distance(&calm) - 0.6);
        // And the subject sits near the middle of the picture.
        let seen = project(&built.view, subject);
        assert!((seen[0] / seen[3]).abs() < 0.2 && (seen[1] / seen[3]).abs() < 0.2);
    }
}
