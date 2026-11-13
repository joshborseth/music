//! Draws the visuals with OpenGL ES 3, under the app's own UI.
//!
//! Slint paints the UI with Skia on the same OpenGL context and calls us
//! just before it does (the rendering notifier), with the screen cleared.
//! Skia remembers what it last bound and is not told about our calls, so
//! every piece of GL state we touch is saved first and put back after.
//!
//! The passes, each a fragment shader from `shaders/`:
//! 1. Each scene showing draws into its own pair of textures at a reduced
//!    size, reading its last frame from the other (trails, ink, echoes).
//!    While one scene dissolves into the next, the two take turns, one a
//!    frame, so a change of scene costs no more than one scene. Terrain
//!    draws its land on top, as a mesh over the sky.
//! 2. The bright parts are cut out at a quarter size and blurred (bloom).
//! 3. `final.glsl` dissolves one scene into the next and adds the glow and
//!    the camera tricks, into a picture the scenes' size.
//! 4. `present.glsl` stretches the picture to the screen, under the shade
//!    the app's words need. It is the only pass at the screen's size, and
//!    reads one pixel for each it draws: a full-size pass costs as much as
//!    a whole scene on a small TV GPU.
//!
//! Each scene's size follows the TV (`sizing.rs`): it shrinks when its
//! frames come late, and settles on the largest size it can hold.
//!
//! Every pass covers its whole target, and says so before it draws
//! (`begin_pass`): a tiled GPU like the TV's Mali then skips loading the
//! target's old pixels from memory, a full read of it each time.

use std::collections::HashMap;
use std::sync::Arc;

use glow::HasContext;

use super::director::{SCENES, Shot, Showing};
use super::look::{COVER_SIDE, Cover, DEFAULT_COLORS};
use super::motion::{Motion, hash, unit};
use super::music::{BANDS, HISTORY_ROWS, LEVELS, Listener, Music, WAVE};
use super::sizing::{Change, Sizing};
use super::timing::{Part, Timer};

const COMMON: &str = include_str!("shaders/common.glsl");
const FRAGMENT: &str = include_str!("shaders/fragment.glsl");
const HELPERS: &str = include_str!("shaders/helpers.glsl");
const FULLSCREEN: &str = include_str!("shaders/fullscreen.vert");

/// Each scene's shader, in the order of `director::SCENES`.
const SCENE_SHADERS: [(&str, &str); SCENES.len()] = [
    ("silk.glsl", include_str!("shaders/silk.glsl")),
    ("ink.glsl", include_str!("shaders/ink.glsl")),
    ("terrain.glsl", include_str!("shaders/terrain.glsl")),
    ("halo.glsl", include_str!("shaders/halo.glsl")),
    ("tunnel.glsl", include_str!("shaders/tunnel.glsl")),
];
/// The scene whose land is drawn as a mesh on top of its sky.
const TERRAIN: usize = 2;
/// Terrain's mesh (`terrain.vert`, which works out the same): a column on
/// each band of the history, the road's middle and edge, and five far
/// columns (`FAR_COLUMNS`), each side; a row for each history row and the
/// far edge. One triangle strip a pair of rows, joined by empty triangles.
const LAND_COLUMNS: i32 = 2 * (1 + BANDS as i32 + 5) + 1;
const LAND_VERTICES: i32 = HISTORY_ROWS as i32 * (2 * LAND_COLUMNS + 2) - 2;

/// The scenes' height at full size; the screen's own if it is smaller.
const BASE_HEIGHT: u32 = 720;
/// Frames a scene must show alone before its frames are counted: the
/// first ones after a change of scene still carry the change's cost.
const STEADY_AFTER: u32 = 3;

type Gl = glow::Context;

/// A program and its uniforms by name.
struct Program {
    program: glow::Program,
    uniforms: HashMap<String, glow::UniformLocation>,
}

/// A texture to draw into.
struct Target {
    texture: glow::Texture,
    framebuffer: glow::Framebuffer,
    width: i32,
    height: i32,
}

/// A scene's pair of textures: it reads one and draws into the other.
struct Slot {
    scene: Option<usize>,
    seed: f32,
    targets: [Target; 2],
    /// False until the scene has drawn into it since it was cleared.
    drawn: bool,
}

/// How much of each shade the app's words need shows, 0 to 1: see
/// `present.glsl`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Shade {
    /// The band behind the lyrics on the right.
    pub side: f32,
    /// The pool behind the song alone in the middle.
    pub centre: f32,
}

/// What happened when the renderer started, for the server's log.
pub struct Report {
    pub renderer: String,
    pub version: String,
    pub errors: Vec<String>,
}

pub struct Renderer {
    vao: glow::VertexArray,
    scenes: Vec<Option<Program>>,
    land: Option<Program>,
    bright: Program,
    blur: Program,
    final_pass: Program,
    present: Program,
    slots: [Slot; 2],
    /// The finished picture, the scenes' size, before `present` stretches it.
    picture: Target,
    /// False until `final` has drawn into the picture since it was resized.
    picture_drawn: bool,
    bloom: [Target; 2],
    spectrum: glow::Texture,
    history: glow::Texture,
    wave: glow::Texture,
    noise: glow::Texture,
    fbm: glow::Texture,
    cover: glow::Texture,
    /// The cover uploaded, held so its identity can't be reused.
    cover_shown: Option<Arc<Cover>>,
    colors: [[f32; 3]; 3],
    has_cover: bool,
    /// Each scene's size, in the order of `SCENES`.
    sizing: [Sizing; SCENES.len()],
    /// Frames drawn, for taking turns.
    frame: u64,
    /// The scene the last frame drew alone, and how many frames in a row.
    alone: Option<usize>,
    steady: u32,
    /// GPU time for each part of a frame, where the GPU can tell.
    timer: Option<Timer>,
}

impl Renderer {
    /// Compile everything. A scene that fails to compile is left out; the
    /// passes every frame needs must compile or there are no visuals.
    pub fn new(gl: &Gl) -> Result<(Self, Report), Report> {
        let report = |errors| Report {
            renderer: unsafe { gl.get_parameter_string(glow::RENDERER) },
            version: unsafe { gl.get_parameter_string(glow::VERSION) },
            errors,
        };
        let mut errors = Vec::new();
        if gl.version().major < 3 {
            errors.push("OpenGL ES 3 is needed".to_owned());
            return Err(report(errors));
        }
        let saved = Saved::save(gl);
        let built = unsafe { Self::build(gl, &mut errors) };
        saved.restore(gl);
        match built {
            Some(renderer) => Ok((renderer, report(errors))),
            None => Err(report(errors)),
        }
    }

    unsafe fn build(gl: &Gl, errors: &mut Vec<String>) -> Option<Self> {
        unsafe {
            let fragment = |body: &str| {
                format!("#version 300 es\n{COMMON}\n{FRAGMENT}\n{HELPERS}\n#line 1\n{body}")
            };
            let vertex = format!("#version 300 es\n{FULLSCREEN}");
            let mut compile = |name: &str, vertex: &str, fragment: &str| {
                program(gl, vertex, fragment)
                    .map_err(|error| errors.push(format!("{name}: {error}")))
                    .ok()
            };
            let scenes = SCENE_SHADERS
                .iter()
                .map(|(name, body)| compile(name, &vertex, &fragment(body)))
                .collect();
            let terrain = SCENE_SHADERS[TERRAIN].1;
            let land = compile(
                "terrain.vert",
                &format!(
                    "#version 300 es\n#define TERRAIN_LAND\n{COMMON}\n{HELPERS}\n#line 1\n{terrain}\n#line 1\n{}",
                    include_str!("shaders/terrain.vert")
                ),
                &format!(
                    "#version 300 es\n{COMMON}\n#line 1\n{}",
                    include_str!("shaders/terrain.frag")
                ),
            );
            let bright = compile(
                "bright.glsl",
                &vertex,
                &fragment(include_str!("shaders/bright.glsl")),
            );
            let blur = compile(
                "blur.glsl",
                &vertex,
                &fragment(include_str!("shaders/blur.glsl")),
            );
            let final_pass = compile(
                "final.glsl",
                &vertex,
                &fragment(include_str!("shaders/final.glsl")),
            );
            let present = compile(
                "present.glsl",
                &vertex,
                &fragment(include_str!("shaders/present.glsl")),
            );
            let (Some(bright), Some(blur), Some(final_pass), Some(present)) =
                (bright, blur, final_pass, present)
            else {
                return None;
            };

            let vao = gl.create_vertex_array().ok()?;
            let spectrum = data_texture(gl, BANDS as i32, 1, glow::R8, false)?;
            let history = data_texture(gl, BANDS as i32, HISTORY_ROWS as i32, glow::R8, false)?;
            let wave = data_texture(gl, WAVE as i32, 1, glow::R8, false)?;
            let noise = data_texture(gl, 256, 256, glow::RGBA8, true)?;
            upload(gl, noise, 256, 256, glow::RGBA, &noise_pixels());
            let side = FBM_SIDE as i32;
            let fbm = data_texture(gl, side, side, glow::RGBA8, true)?;
            upload(gl, fbm, side, side, glow::RGBA, &fbm_pixels());
            let cover = data_texture(gl, COVER_SIDE as i32, COVER_SIDE as i32, glow::RGBA8, false)?;
            let (width, height) = (16, 16);
            let slot = || -> Option<Slot> {
                Some(Slot {
                    scene: None,
                    seed: 0.0,
                    targets: [target(gl, width, height)?, target(gl, width, height)?],
                    drawn: false,
                })
            };
            let slots = [slot()?, slot()?];
            let bloom = [target(gl, 4, 4)?, target(gl, 4, 4)?];
            let picture = target(gl, width, height)?;
            Some(Self {
                vao,
                scenes,
                land,
                bright,
                blur,
                final_pass,
                present,
                slots,
                picture,
                picture_drawn: false,
                bloom,
                spectrum,
                history,
                wave,
                noise,
                fbm,
                cover,
                cover_shown: None,
                colors: DEFAULT_COLORS,
                has_cover: false,
                sizing: Default::default(),
                frame: 0,
                alone: None,
                steady: 0,
                timer: Timer::new(gl),
            })
        }
    }

    /// Whether `scene` compiled.
    pub fn can_draw(&self, scene: usize) -> bool {
        self.scenes.get(scene).is_some_and(Option::is_some)
            && (scene != TERRAIN || self.land.is_some())
    }

    /// Each scene shown so far and its size, for the server's log:
    /// "Silk 100%, Halo 60%, Terrain 35% at 30 fps".
    pub fn sizes(&self) -> String {
        let sizes: Vec<String> = self
            .sizing
            .iter()
            .zip(SCENES.iter())
            .filter(|(sizing, _)| sizing.shown())
            .map(|(sizing, spec)| {
                let rate = if sizing.half_rate() { " at 30 fps" } else { "" };
                format!("{} {:.0}%{rate}", spec.name, sizing.scale() * 100.0)
            })
            .collect();
        if sizes.is_empty() {
            "none shown yet".to_owned()
        } else {
            sizes.join(", ")
        }
    }

    /// The GPU time each part of a frame took since the last call, for the
    /// server's log; `None` where the GPU can't tell.
    pub fn timings(&mut self) -> Option<String> {
        self.timer
            .as_mut()
            .map(|timer| timer.report(|scene| SCENES[scene].name))
    }

    /// Show `cover` (or none) from now on.
    pub fn set_cover(&mut self, gl: &Gl, cover: Option<&Arc<Cover>>) {
        let same = match (cover, &self.cover_shown) {
            (Some(new), Some(old)) => Arc::ptr_eq(new, old),
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.cover_shown = cover.cloned();
        self.has_cover = cover.is_some();
        self.colors = cover.map_or(DEFAULT_COLORS, |cover| cover.colors);
        if let Some(cover) = cover {
            let saved = Saved::save(gl);
            unsafe {
                upload(
                    gl,
                    self.cover,
                    COVER_SIDE as i32,
                    COVER_SIDE as i32,
                    glow::RGBA,
                    &cover.rgba,
                );
            }
            saved.restore(gl);
        }
    }

    /// The last frame took `dt` seconds: keep the size of the scene it drew
    /// in step. Only frames that drew one scene alone, a few in a row,
    /// count, so a change of scene never sizes either one.
    pub fn pace(&mut self, dt: f32) {
        let Some(scene) = self.alone else {
            return;
        };
        if self.steady < STEADY_AFTER {
            return;
        }
        let sizing = &mut self.sizing[scene];
        let name = SCENES[scene].name;
        match sizing.frame(dt) {
            Some(Change::Shrank) if sizing.half_rate() => {
                log::info!("visuals: {name} frames are slow, drawing it at 30 fps");
            }
            Some(Change::Shrank) => {
                log::info!(
                    "visuals: {name} frames are slow, drawing it at {}",
                    sizing.scale()
                );
            }
            Some(Change::Grew) => {
                log::info!(
                    "visuals: {name} has room to grow, drawing it at {}",
                    sizing.scale()
                );
            }
            None => {}
        }
    }

    /// Draw one frame onto the screen, `width` × `height` pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &mut self,
        gl: &Gl,
        music: &Music,
        listener: &mut Listener,
        shot: &Shot,
        fade: f32,
        shade: Shade,
        (width, height): (u32, u32),
    ) {
        if width == 0 || height == 0 {
            return;
        }
        self.frame = self.frame.wrapping_add(1);
        let saved = Saved::save(gl);
        unsafe {
            gl.bind_vertex_array(Some(self.vao));
            gl.disable(glow::BLEND);
            gl.disable(glow::SCISSOR_TEST);
            gl.disable(glow::DEPTH_TEST);
            gl.disable(glow::STENCIL_TEST);
            gl.disable(glow::CULL_FACE);
            gl.disable(glow::DITHER);
            gl.color_mask(true, true, true, true);
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, 0);
            gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, None);
            for unit in 0..8 {
                gl.bind_sampler(unit, None);
            }

            upload(
                gl,
                self.spectrum,
                BANDS as i32,
                1,
                glow::RED,
                &listener.spectrum,
            );
            upload(gl, self.wave, WAVE as i32, 1, glow::RED, &listener.wave);
            if listener.take_history_changed() {
                upload(
                    gl,
                    self.history,
                    BANDS as i32,
                    HISTORY_ROWS as i32,
                    glow::RED,
                    &listener.history,
                );
            }

            let screen = (width, height);
            let next = shot.next.map(|(next, _)| next.scene);
            let a = self.ensure_slot(gl, shot.current, next, screen);
            let b = shot
                .next
                .map(|(next, _)| self.ensure_slot(gl, next, Some(shot.current.scene), screen));
            let mix = shot.next.map_or(0.0, |(_, progress)| progress);

            // Which scenes move this frame.
            let even = self.frame.is_multiple_of(2);
            let (draw_a, draw_b) = match b {
                // During a change of scene the two take turns, so each moves
                // at 30 a second for that moment and the frame costs no more
                // than one scene. A scene draws first as soon as it comes in.
                Some(b) if !self.slots[b].drawn => (false, true),
                Some(_) if !self.slots[a].drawn => (true, false),
                Some(_) => (even, !even),
                // A scene too heavy for this TV even at its smallest moves
                // every other frame; the screen still shows every frame.
                None => (
                    !self.sizing[shot.current.scene].half_rate()
                        || even
                        || !self.slots[a].drawn
                        || !self.picture_drawn,
                    false,
                ),
            };
            let alone = b.is_none().then_some(shot.current.scene);
            self.steady = if alone.is_some() && alone == self.alone {
                self.steady.saturating_add(1)
            } else {
                0
            };
            self.alone = alone;
            if let Some(timer) = &mut self.timer {
                timer.frame(gl, alone.filter(|_| draw_a));
                timer.begin(gl, Part::Scenes);
            }

            if draw_a {
                self.draw_scene(gl, a, shot.current, music, listener);
            }
            if draw_b && let (Some(b), Some((next, _))) = (b, shot.next) {
                self.draw_scene(gl, b, next, music, listener);
            }
            if let Some(timer) = &mut self.timer {
                timer.end(gl);
                timer.begin(gl, Part::Effects);
            }
            if draw_a || draw_b {
                self.compose(gl, a, b, shot.current, mix, fade, music, listener);
            }
            if let Some(timer) = &mut self.timer {
                timer.end(gl);
                timer.begin(gl, Part::Screen);
            }

            // The screen. Skia cleared it and has moved on to our passes,
            // so a tiled GPU would load it back from memory before this
            // draw: clearing it again says the picture covers it all.
            gl.bind_framebuffer(glow::FRAMEBUFFER, saved.framebuffer);
            gl.viewport(0, 0, width as i32, height as i32);
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            gl.use_program(Some(self.present.program));
            set_vec2(gl, &self.present, "uRes", width as f32, height as f32);
            set_f32(gl, &self.present, "uTime", music.time);
            set_f32(gl, &self.present, "uSide", shade.side);
            set_f32(gl, &self.present, "uCentre", shade.centre);
            bind_texture(gl, &self.present, "uPicture", 0, self.picture.texture);
            fullscreen(gl);
            if let Some(timer) = &mut self.timer {
                timer.end(gl);
            }
        }
        saved.restore(gl);
    }

    /// Bloom, then the picture: the scenes in slots `a` and `b` (if any)
    /// put together at the larger one's size.
    #[allow(clippy::too_many_arguments)]
    unsafe fn compose(
        &mut self,
        gl: &Gl,
        a: usize,
        b: Option<usize>,
        current: Showing,
        mix: f32,
        fade: f32,
        music: &Music,
        listener: &Listener,
    ) {
        unsafe {
            let out_a = &self.slots[a].targets[0];
            let out_b = &self.slots[b.unwrap_or(a)].targets[0];
            let wide = out_a.width.max(out_b.width);
            let tall = out_a.height.max(out_b.height);
            if (self.picture.width, self.picture.height) != (wide, tall) {
                resize(gl, &mut self.picture, wide, tall);
                for target in &mut self.bloom {
                    resize(gl, target, (wide / 4).max(1), (tall / 4).max(1));
                }
                self.picture_drawn = false;
            }
            let out_a = &self.slots[a].targets[0];
            let out_b = &self.slots[b.unwrap_or(a)].targets[0];

            // Bloom: bright parts at a quarter size, blurred across and down.
            let [bloom_a, bloom_b] = &self.bloom;
            begin_pass(gl, bloom_a);
            gl.use_program(Some(self.bright.program));
            self.set_music(
                gl,
                &self.bright,
                music,
                (bloom_a.width, bloom_a.height),
                None,
                listener,
            );
            bind_texture(gl, &self.bright, "uSceneA", 0, out_a.texture);
            bind_texture(gl, &self.bright, "uSceneB", 1, out_b.texture);
            set_f32(gl, &self.bright, "uMix", mix);
            set_vec2(
                gl,
                &self.bright,
                "uTexel",
                1.0 / out_a.width as f32,
                1.0 / out_a.height as f32,
            );
            fullscreen(gl);
            for (from, to, across) in [(bloom_a, bloom_b, true), (bloom_b, bloom_a, false)] {
                begin_pass(gl, to);
                gl.use_program(Some(self.blur.program));
                bind_texture(gl, &self.blur, "uSource", 0, from.texture);
                let (x, y) = if across {
                    (1.0 / from.width as f32, 0.0)
                } else {
                    (0.0, 1.0 / from.height as f32)
                };
                set_vec2(gl, &self.blur, "uDirection", x, y);
                fullscreen(gl);
            }

            // The picture, the scenes' size.
            begin_pass(gl, &self.picture);
            gl.use_program(Some(self.final_pass.program));
            self.set_music(
                gl,
                &self.final_pass,
                music,
                (self.picture.width, self.picture.height),
                Some(current),
                listener,
            );
            bind_texture(gl, &self.final_pass, "uSceneA", 0, out_a.texture);
            bind_texture(gl, &self.final_pass, "uSceneB", 1, out_b.texture);
            bind_texture(gl, &self.final_pass, "uBloom", 2, bloom_a.texture);
            bind_texture(gl, &self.final_pass, "uNoise", 3, self.noise);
            set_f32(gl, &self.final_pass, "uMix", mix);
            set_f32(gl, &self.final_pass, "uFade", fade);
            fullscreen(gl);
            self.picture_drawn = true;
        }
    }

    /// The size `scene` draws at on a `width` × `height` screen.
    fn scene_size(&self, scene: usize, (width, height): (u32, u32)) -> (i32, i32) {
        let tall = (BASE_HEIGHT.min(height) as f32 * self.sizing[scene].scale())
            .round()
            .max(90.0);
        let wide = (tall * width as f32 / height as f32).round();
        (wide as i32, tall as i32)
    }

    /// The slot holding `showing`, at its size, giving it one (cleared) if
    /// it has none, never the one holding `keep`.
    unsafe fn ensure_slot(
        &mut self,
        gl: &Gl,
        showing: Showing,
        keep: Option<usize>,
        screen: (u32, u32),
    ) -> usize {
        unsafe {
            let (wide, tall) = self.scene_size(showing.scene, screen);
            let held = self
                .slots
                .iter()
                .position(|slot| slot.scene == Some(showing.scene));
            let index = held.unwrap_or_else(|| {
                // Take a slot no scene on screen is using.
                self.slots
                    .iter()
                    .position(|slot| slot.scene.is_none())
                    .unwrap_or_else(|| usize::from(keep.is_some() && self.slots[0].scene == keep))
            });
            let slot = &mut self.slots[index];
            slot.seed = showing.seed;
            let sized = slot.targets[0].width == wide && slot.targets[0].height == tall;
            if held.is_some() && sized {
                return index;
            }
            // A new scene, or a new size: it starts over from black.
            slot.scene = Some(showing.scene);
            slot.drawn = false;
            for target in &mut slot.targets {
                if sized {
                    bind_target(gl, target);
                    gl.clear_color(0.0, 0.0, 0.0, 0.0);
                    gl.clear(glow::COLOR_BUFFER_BIT);
                } else {
                    resize(gl, target, wide, tall);
                }
            }
            index
        }
    }

    /// Free the slots no shot uses, so the next scene to come gets a clean one.
    pub fn release_unused(&mut self, shot: &Shot) {
        let used = |scene: Option<usize>| {
            scene == Some(shot.current.scene)
                || shot.next.is_some_and(|(next, _)| scene == Some(next.scene))
        };
        for slot in &mut self.slots {
            if !used(slot.scene) {
                slot.scene = None;
            }
        }
    }

    unsafe fn draw_scene(
        &mut self,
        gl: &Gl,
        slot: usize,
        showing: Showing,
        music: &Music,
        listener: &Listener,
    ) {
        unsafe {
            let scene = showing.scene;
            let [read, write] = &self.slots[slot].targets;
            begin_pass(gl, write);
            if let Some(Some(program)) = self.scenes.get(scene) {
                gl.use_program(Some(program.program));
                self.set_music(
                    gl,
                    program,
                    music,
                    (write.width, write.height),
                    Some(showing),
                    listener,
                );
                self.bind_inputs(gl, program, Some(read.texture));
                fullscreen(gl);
            }
            if scene == TERRAIN
                && let Some(land) = &self.land
            {
                gl.use_program(Some(land.program));
                self.set_music(
                    gl,
                    land,
                    music,
                    (write.width, write.height),
                    Some(showing),
                    listener,
                );
                self.bind_inputs(gl, land, None);
                gl.draw_arrays(glow::TRIANGLE_STRIP, 0, LAND_VERTICES);
            }
            let slot = &mut self.slots[slot];
            slot.targets.swap(0, 1);
            slot.drawn = true;
        }
    }

    unsafe fn bind_inputs(&self, gl: &Gl, program: &Program, prev: Option<glow::Texture>) {
        unsafe {
            bind_texture(gl, program, "uCover", 0, self.cover);
            bind_texture(gl, program, "uSpectrum", 1, self.spectrum);
            bind_texture(gl, program, "uHistory", 2, self.history);
            bind_texture(gl, program, "uWave", 3, self.wave);
            if let Some(prev) = prev {
                bind_texture(gl, program, "uPrev", 4, prev);
            }
            bind_texture(gl, program, "uNoise", 5, self.noise);
            bind_texture(gl, program, "uFbm", 6, self.fbm);
        }
    }

    unsafe fn set_music(
        &self,
        gl: &Gl,
        program: &Program,
        music: &Music,
        (width, height): (i32, i32),
        showing: Option<Showing>,
        listener: &Listener,
    ) {
        unsafe {
            let f = |name: &str, value: f32| set_f32(gl, program, name, value);
            let seed = showing.map_or(0.0, |showing| showing.seed);
            set_vec2(gl, program, "uRes", width as f32, height as f32);
            f("uTime", music.time);
            f("uSceneTime", showing.map_or(0.0, |showing| showing.age));
            f("uDrive", music.drive);
            f("uBeats", music.beats);
            f("uBar", music.bar);
            f("uBeatPulse", music.beat_pulse);
            f("uBarPulse", music.bar_pulse);
            f("uKick", music.kick);
            f("uAccent", music.accent);
            f("uEnergy", music.energy);
            f("uTension", music.tension);
            f("uDrop", music.drop);
            f("uIntensity", music.intensity);
            f("uSeed", seed);
            f("uHasCover", if self.has_cover { 1.0 } else { 0.0 });
            f("uHistoryAge", listener.history_age);
            if let Some(at) = program.uniforms.get("uBands") {
                let [bass, mid, treble, level] = music.bands;
                gl.uniform_4_f32(Some(at), bass, mid, treble, level);
            }
            if let Some(at) = program.uniforms.get("uLevels") {
                let levels: [f32; LEVELS] = music.levels;
                gl.uniform_1_f32_slice(Some(at), &levels);
            }
            for (name, color) in ["uColorA", "uColorB", "uColorC"].iter().zip(self.colors) {
                if let Some(at) = program.uniforms.get(*name) {
                    gl.uniform_3_f32(Some(at), color[0], color[1], color[2]);
                }
            }

            let motion = Motion::new(music, seed);
            if let Some(at) = program.uniforms.get("uPour") {
                gl.uniform_4_f32_slice(Some(at), motion.pour.as_flattened());
            }
            for (name, [x, y, z, w]) in [("uTurn", motion.turn), ("uFlight", motion.flight)] {
                if let Some(at) = program.uniforms.get(name) {
                    gl.uniform_4_f32(Some(at), x, y, z, w);
                }
            }
            let [x, y] = motion.shake;
            set_vec2(gl, program, "uShake", x, y);
        }
    }

    /// Read the screen as it is now (after the UI is drawn on top): RGBA,
    /// top row first.
    pub fn read_screen(gl: &Gl, (width, height): (u32, u32)) -> Vec<u8> {
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let saved = Saved::save(gl);
        unsafe {
            gl.pixel_store_i32(glow::PACK_ALIGNMENT, 1);
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            gl.read_pixels(
                0,
                0,
                width as i32,
                height as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut pixels)),
            );
        }
        saved.restore(gl);
        // GL's rows run bottom up.
        let row = width as usize * 4;
        let mut flipped = Vec::with_capacity(pixels.len());
        for line in pixels.chunks_exact(row).rev() {
            flipped.extend_from_slice(line);
        }
        flipped
    }

    /// Free every GL object.
    pub fn delete(self, gl: &Gl) {
        unsafe {
            let programs = self.scenes.into_iter().flatten().chain(self.land).chain([
                self.bright,
                self.blur,
                self.final_pass,
                self.present,
            ]);
            for program in programs {
                gl.delete_program(program.program);
            }
            for target in self
                .slots
                .into_iter()
                .flat_map(|slot| slot.targets)
                .chain(self.bloom)
                .chain([self.picture])
            {
                gl.delete_framebuffer(target.framebuffer);
                gl.delete_texture(target.texture);
            }
            for texture in [
                self.spectrum,
                self.history,
                self.wave,
                self.noise,
                self.fbm,
                self.cover,
            ] {
                gl.delete_texture(texture);
            }
            gl.delete_vertex_array(self.vao);
            if let Some(timer) = self.timer {
                timer.delete(gl);
            }
        }
    }
}

/// The GL state Skia may rely on, saved before we draw and put back after.
struct Saved {
    framebuffer: Option<glow::Framebuffer>,
    viewport: [i32; 4],
    program: Option<glow::Program>,
    vao: Option<glow::VertexArray>,
    array_buffer: Option<glow::Buffer>,
    unpack_buffer: Option<glow::Buffer>,
    pack_buffer: Option<glow::Buffer>,
    active_texture: u32,
    textures: [Option<glow::Texture>; 8],
    samplers: [Option<glow::Sampler>; 8],
    blend: bool,
    blend_func: [u32; 4],
    blend_equation: [u32; 2],
    scissor: bool,
    depth: bool,
    stencil: bool,
    cull: bool,
    dither: bool,
    color_mask: [bool; 4],
    clear_color: [f32; 4],
    unpack_alignment: i32,
    unpack_row_length: i32,
    pack_alignment: i32,
}

impl Saved {
    fn save(gl: &Gl) -> Self {
        unsafe {
            let mut viewport = [0; 4];
            gl.get_parameter_i32_slice(glow::VIEWPORT, &mut viewport);
            let active_texture = gl.get_parameter_i32(glow::ACTIVE_TEXTURE) as u32;
            let mut textures = [None; 8];
            let mut samplers = [None; 8];
            for unit in 0..8 {
                gl.active_texture(glow::TEXTURE0 + unit as u32);
                textures[unit] = gl.get_parameter_texture(glow::TEXTURE_BINDING_2D);
                samplers[unit] = gl.get_parameter_sampler(glow::SAMPLER_BINDING);
            }
            gl.active_texture(active_texture);
            let mut clear_color = [0.0; 4];
            gl.get_parameter_f32_slice(glow::COLOR_CLEAR_VALUE, &mut clear_color);
            let enum_of = |name| gl.get_parameter_i32(name) as u32;
            Self {
                framebuffer: gl.get_parameter_framebuffer(glow::DRAW_FRAMEBUFFER_BINDING),
                viewport,
                program: gl.get_parameter_program(glow::CURRENT_PROGRAM),
                vao: gl.get_parameter_vertex_array(glow::VERTEX_ARRAY_BINDING),
                array_buffer: gl.get_parameter_buffer(glow::ARRAY_BUFFER_BINDING),
                unpack_buffer: gl.get_parameter_buffer(glow::PIXEL_UNPACK_BUFFER_BINDING),
                pack_buffer: gl.get_parameter_buffer(glow::PIXEL_PACK_BUFFER_BINDING),
                active_texture,
                textures,
                samplers,
                blend: gl.is_enabled(glow::BLEND),
                blend_func: [
                    enum_of(glow::BLEND_SRC_RGB),
                    enum_of(glow::BLEND_DST_RGB),
                    enum_of(glow::BLEND_SRC_ALPHA),
                    enum_of(glow::BLEND_DST_ALPHA),
                ],
                blend_equation: [
                    enum_of(glow::BLEND_EQUATION_RGB),
                    enum_of(glow::BLEND_EQUATION_ALPHA),
                ],
                scissor: gl.is_enabled(glow::SCISSOR_TEST),
                depth: gl.is_enabled(glow::DEPTH_TEST),
                stencil: gl.is_enabled(glow::STENCIL_TEST),
                cull: gl.is_enabled(glow::CULL_FACE),
                dither: gl.is_enabled(glow::DITHER),
                color_mask: gl.get_parameter_bool_array::<4>(glow::COLOR_WRITEMASK),
                clear_color,
                unpack_alignment: gl.get_parameter_i32(glow::UNPACK_ALIGNMENT),
                unpack_row_length: gl.get_parameter_i32(glow::UNPACK_ROW_LENGTH),
                pack_alignment: gl.get_parameter_i32(glow::PACK_ALIGNMENT),
            }
        }
    }

    fn restore(&self, gl: &Gl) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, self.framebuffer);
            let [x, y, width, height] = self.viewport;
            gl.viewport(x, y, width, height);
            gl.use_program(self.program);
            gl.bind_vertex_array(self.vao);
            gl.bind_buffer(glow::ARRAY_BUFFER, self.array_buffer);
            gl.bind_buffer(glow::PIXEL_UNPACK_BUFFER, self.unpack_buffer);
            gl.bind_buffer(glow::PIXEL_PACK_BUFFER, self.pack_buffer);
            for unit in 0..8 {
                gl.active_texture(glow::TEXTURE0 + unit as u32);
                gl.bind_texture(glow::TEXTURE_2D, self.textures[unit]);
                gl.bind_sampler(unit as u32, self.samplers[unit]);
            }
            gl.active_texture(self.active_texture);
            let toggle = |capability, on: bool| {
                if on {
                    gl.enable(capability);
                } else {
                    gl.disable(capability);
                }
            };
            toggle(glow::BLEND, self.blend);
            toggle(glow::SCISSOR_TEST, self.scissor);
            toggle(glow::DEPTH_TEST, self.depth);
            toggle(glow::STENCIL_TEST, self.stencil);
            toggle(glow::CULL_FACE, self.cull);
            toggle(glow::DITHER, self.dither);
            let [src_rgb, dst_rgb, src_alpha, dst_alpha] = self.blend_func;
            gl.blend_func_separate(src_rgb, dst_rgb, src_alpha, dst_alpha);
            gl.blend_equation_separate(self.blend_equation[0], self.blend_equation[1]);
            let [r, g, b, a] = self.color_mask;
            gl.color_mask(r, g, b, a);
            let [r, g, b, a] = self.clear_color;
            gl.clear_color(r, g, b, a);
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, self.unpack_alignment);
            gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, self.unpack_row_length);
            gl.pixel_store_i32(glow::PACK_ALIGNMENT, self.pack_alignment);
        }
    }
}

unsafe fn program(gl: &Gl, vertex: &str, fragment: &str) -> Result<Program, String> {
    unsafe {
        let shader = |kind, source: &str| {
            let shader = gl.create_shader(kind)?;
            gl.shader_source(shader, source);
            gl.compile_shader(shader);
            if gl.get_shader_compile_status(shader) {
                Ok(shader)
            } else {
                let log = gl.get_shader_info_log(shader);
                gl.delete_shader(shader);
                Err(log)
            }
        };
        let vertex = shader(glow::VERTEX_SHADER, vertex)?;
        let fragment = match shader(glow::FRAGMENT_SHADER, fragment) {
            Ok(fragment) => fragment,
            Err(error) => {
                gl.delete_shader(vertex);
                return Err(error);
            }
        };
        let program = gl.create_program()?;
        gl.attach_shader(program, vertex);
        gl.attach_shader(program, fragment);
        gl.link_program(program);
        gl.delete_shader(vertex);
        gl.delete_shader(fragment);
        if !gl.get_program_link_status(program) {
            let log = gl.get_program_info_log(program);
            gl.delete_program(program);
            return Err(log);
        }
        let mut uniforms = HashMap::new();
        for index in 0..gl.get_active_uniforms(program) {
            if let Some(active) = gl.get_active_uniform(program, index)
                && let Some(location) = gl.get_uniform_location(program, &active.name)
            {
                let name = active.name.trim_end_matches("[0]").to_owned();
                uniforms.insert(name, location);
            }
        }
        Ok(Program { program, uniforms })
    }
}

unsafe fn data_texture(
    gl: &Gl,
    width: i32,
    height: i32,
    format: u32,
    repeat: bool,
) -> Option<glow::Texture> {
    unsafe {
        let texture = gl.create_texture().ok()?;
        gl.bind_texture(glow::TEXTURE_2D, Some(texture));
        let pixel = if format == glow::R8 {
            glow::RED
        } else {
            glow::RGBA
        };
        gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            format as i32,
            width,
            height,
            0,
            pixel,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(None),
        );
        let wrap = if repeat {
            glow::REPEAT
        } else {
            glow::CLAMP_TO_EDGE
        };
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MIN_FILTER,
            glow::LINEAR as i32,
        );
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MAG_FILTER,
            glow::LINEAR as i32,
        );
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, wrap as i32);
        gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, wrap as i32);
        Some(texture)
    }
}

unsafe fn upload(
    gl: &Gl,
    texture: glow::Texture,
    width: i32,
    height: i32,
    format: u32,
    pixels: &[u8],
) {
    unsafe {
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
        gl.bind_texture(glow::TEXTURE_2D, Some(texture));
        gl.tex_sub_image_2d(
            glow::TEXTURE_2D,
            0,
            0,
            0,
            width,
            height,
            format,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(Some(pixels)),
        );
    }
}

unsafe fn target(gl: &Gl, width: i32, height: i32) -> Option<Target> {
    unsafe {
        let texture = data_texture(gl, width, height, glow::RGBA8, false)?;
        let framebuffer = gl.create_framebuffer().ok()?;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
        gl.framebuffer_texture_2d(
            glow::FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::TEXTURE_2D,
            Some(texture),
            0,
        );
        Some(Target {
            texture,
            framebuffer,
            width,
            height,
        })
    }
}

unsafe fn resize(gl: &Gl, target: &mut Target, width: i32, height: i32) {
    unsafe {
        gl.bind_texture(glow::TEXTURE_2D, Some(target.texture));
        gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            glow::RGBA8 as i32,
            width,
            height,
            0,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(None),
        );
        target.width = width;
        target.height = height;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
        gl.viewport(0, 0, width, height);
        gl.clear_color(0.0, 0.0, 0.0, 0.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
    }
}

unsafe fn bind_target(gl: &Gl, target: &Target) {
    unsafe {
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
        gl.viewport(0, 0, target.width, target.height);
    }
}

/// Draw into `target`, all of it: what it held is not needed.
unsafe fn begin_pass(gl: &Gl, target: &Target) {
    unsafe {
        bind_target(gl, target);
        gl.invalidate_framebuffer(glow::FRAMEBUFFER, &[glow::COLOR_ATTACHMENT0]);
    }
}

unsafe fn bind_texture(gl: &Gl, program: &Program, name: &str, unit: u32, texture: glow::Texture) {
    unsafe {
        if let Some(at) = program.uniforms.get(name) {
            gl.active_texture(glow::TEXTURE0 + unit);
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            gl.uniform_1_i32(Some(at), unit as i32);
        }
    }
}

unsafe fn set_f32(gl: &Gl, program: &Program, name: &str, value: f32) {
    unsafe {
        if let Some(at) = program.uniforms.get(name) {
            gl.uniform_1_f32(Some(at), value);
        }
    }
}

unsafe fn set_vec2(gl: &Gl, program: &Program, name: &str, x: f32, y: f32) {
    unsafe {
        if let Some(at) = program.uniforms.get(name) {
            gl.uniform_2_f32(Some(at), x, y);
        }
    }
}

unsafe fn fullscreen(gl: &Gl) {
    unsafe {
        gl.draw_arrays(glow::TRIANGLES, 0, 3);
    }
}

/// 256 × 256 random values; green is red moved by (37, 17), for `noise3`.
/// The same numbers as the lab's `noisePixels`.
pub fn noise_pixels() -> Vec<u8> {
    const SIDE: usize = 256;
    let mut state: u32 = 0x2545_f491;
    let red: Vec<u8> = (0..SIDE * SIDE)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect();
    let mut pixels = vec![0u8; SIDE * SIDE * 4];
    for y in 0..SIDE {
        for x in 0..SIDE {
            let at = (y * SIDE + x) * 4;
            pixels[at] = red[y * SIDE + x];
            pixels[at + 1] = red[((y + 17) % SIDE) * SIDE + (x + 37) % SIDE];
            pixels[at + 3] = 255;
        }
    }
    pixels
}

/// The side of the fractal noise texture (`uFbm`), and the units it spans.
/// Its first octave has a random value at each whole unit.
const FBM_SIDE: usize = 256;
const FBM_UNITS: usize = 8;

/// Fractal noise worked out ahead, so a scene reads in one go what took it
/// four reads and a loop: red is the value (0 to 1), green and blue its
/// slope across and up (0.5 is flat, ±8 at the ends), and alpha a second
/// value: the same noise turned a quarter and moved, so one read gives two
/// that don't follow each other (`fbm2`). Four octaves of smooth noise,
/// each finer and turned from the last, as `fbm` used to make them at
/// every pixel: 2.24 times finer and 26.6° round, then twice as fine and a
/// quarter turn, twice. The turns have whole numbers in them, so every
/// octave still repeats with the texture and it tiles without seams. The
/// same numbers as the lab's `fbmPixels`.
pub fn fbm_pixels() -> Vec<u8> {
    let per_unit = (FBM_SIDE / FBM_UNITS) as f64;
    let byte = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    let mut pixels = vec![0u8; FBM_SIDE * FBM_SIDE * 4];
    for row in 0..FBM_SIDE {
        for column in 0..FBM_SIDE {
            let x = (column as f64 + 0.5) / per_unit;
            let y = (row as f64 + 0.5) / per_unit;
            let (value, across, up) = fbm_at(x, y);
            // A quarter turn (x, y → −y, x), moved; the 8 keeps it positive
            // and changes nothing, as the noise repeats every 8.
            let (turned, _, _) = fbm_at(8.0 - y + 3.3, x + 1.9);
            let at = (row * FBM_SIDE + column) * 4;
            pixels[at] = byte(value);
            pixels[at + 1] = byte(0.5 + across / 8.0);
            pixels[at + 2] = byte(0.5 + up / 8.0);
            pixels[at + 3] = byte(turned);
        }
    }
    pixels
}

/// `fbm_pixels`' noise at (x, y), 0 to 1, and its slope across and up.
fn fbm_at(x: f64, y: f64) -> (f64, f64, f64) {
    // Each octave's turn from the first, as rows: (2 −1; 1 2), then
    // (0 −2; 2 0) times the one before, twice.
    const TURNS: [[[f64; 2]; 2]; 4] = [
        [[1.0, 0.0], [0.0, 1.0]],
        [[2.0, -1.0], [1.0, 2.0]],
        [[-2.0, -4.0], [4.0, -2.0]],
        [[-8.0, 4.0], [-4.0, -8.0]],
    ];
    const TOTAL: f64 = 0.5 + 0.25 + 0.125 + 0.0625;
    let (mut value, mut across, mut up) = (0.0, 0.0, 0.0);
    let mut amplitude = 0.5;
    for (octave, [[a, b], [c, d]]) in TURNS.into_iter().enumerate() {
        // A different offset each octave, so their grids don't line up.
        let shift = octave as f64 * 0.37;
        let (n, nx, ny) = smooth_noise(
            octave as u32,
            a * x + b * y + shift,
            c * x + d * y + shift * 1.7,
        );
        value += amplitude * n;
        across += amplitude * (a * nx + c * ny);
        up += amplitude * (b * nx + d * ny);
        amplitude *= 0.5;
    }
    (value / TOTAL, across / TOTAL, up / TOTAL)
}

/// Smooth value noise for `fbm_pixels`, repeating every `FBM_UNITS`: the
/// value at (x, y) and its slope across and up.
fn smooth_noise(octave: u32, x: f64, y: f64) -> (f64, f64, f64) {
    let cells = FBM_UNITS as i64;
    let lattice = |cx: f64, cy: f64| {
        let cx = (cx as i64).rem_euclid(cells) as u32;
        let cy = (cy as i64).rem_euclid(cells) as u32;
        unit(hash(hash(octave).wrapping_add(cy)).wrapping_add(cx))
    };
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (dx, dy) = (6.0 * fx * (1.0 - fx), 6.0 * fy * (1.0 - fy));
    let a = lattice(ix, iy);
    let b = lattice(ix + 1.0, iy);
    let c = lattice(ix, iy + 1.0);
    let d = lattice(ix + 1.0, iy + 1.0);
    let twist = a - b - c + d;
    (
        a + (b - a) * ux + (c - a) * uy + twist * ux * uy,
        dx * ((b - a) + twist * uy),
        dy * ((c - a) + twist * ux),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scene_has_a_shader() {
        assert_eq!(SCENE_SHADERS.len(), SCENES.len());
        for ((file, _), spec) in SCENE_SHADERS.iter().zip(SCENES.iter()) {
            assert!(
                file.starts_with(&spec.name.to_lowercase()),
                "{file} vs {}",
                spec.name
            );
        }
    }

    #[test]
    fn the_noise_matches_the_lab() {
        let pixels = noise_pixels();
        // Spot values the lab's generator gives for the same seed.
        assert_eq!(pixels.len(), 256 * 256 * 4);
        assert_eq!(pixels[3], 255);
        assert_eq!(pixels[1], pixels[(17 * 256 + 37) * 4]);
    }

    #[test]
    fn the_fractal_noise_matches_the_lab() {
        let pixels = fbm_pixels();
        assert_eq!(pixels.len(), FBM_SIDE * FBM_SIDE * 4);
        // Spot values the lab's `fbmPixels` gives.
        assert_eq!(&pixels[..4], &[56, 147, 119, 95]);
        let middle = (128 * FBM_SIDE + 77) * 4;
        assert_eq!(&pixels[middle..middle + 4], &[182, 104, 150, 149]);
    }

    #[test]
    fn the_fractal_noise_tiles_and_its_slope_is_right() {
        let pixels = fbm_pixels();
        let value = |column: usize, row: usize| f32::from(pixels[(row * FBM_SIDE + column) * 4]);
        // Across the seam the values run on as smoothly as anywhere else.
        let mut steepest_inside: f32 = 0.0;
        let mut steepest_seam: f32 = 0.0;
        for row in 0..FBM_SIDE {
            for column in 0..FBM_SIDE - 1 {
                steepest_inside =
                    steepest_inside.max((value(column + 1, row) - value(column, row)).abs());
            }
            steepest_seam = steepest_seam.max((value(0, row) - value(FBM_SIDE - 1, row)).abs());
        }
        assert!(
            steepest_seam <= steepest_inside,
            "{steepest_seam} > {steepest_inside}"
        );
        // The stored slope agrees with how the value changes, everywhere.
        let texel = 1.0 / (FBM_SIDE / FBM_UNITS) as f32;
        let mut worst: f32 = 0.0;
        for row in (8..FBM_SIDE - 8).step_by(7) {
            for column in (8..FBM_SIDE - 8).step_by(5) {
                let stored = |channel: usize| {
                    (f32::from(pixels[(row * FBM_SIDE + column) * 4 + channel]) / 255.0 - 0.5) * 8.0
                };
                let across =
                    (value(column + 1, row) - value(column - 1, row)) / 255.0 / (2.0 * texel);
                let up = (value(column, row + 1) - value(column, row - 1)) / 255.0 / (2.0 * texel);
                worst = worst
                    .max((across - stored(1)).abs())
                    .max((up - stored(2)).abs());
            }
        }
        assert!(worst < 0.6, "slopes off by {worst}");
    }
}
