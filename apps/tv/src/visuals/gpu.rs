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
//! 2. The bright parts are cut out at a quarter size and blurred (bloom).
//! 3. `final.glsl` dissolves one scene into the next, adds the glow and the
//!    camera tricks, and draws the result at the screen's size.
//!
//! The size of the scenes follows the TV: when frames come late, they get
//! smaller; when there is room again, they grow back.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use glow::HasContext;

use super::director::{Shot, Showing};
use super::look::{COVER_SIDE, Cover, DEFAULT_COLORS};
use super::music::{BANDS, HISTORY_ROWS, LEVELS, Listener, Music, WAVE};

const COMMON: &str = include_str!("shaders/common.glsl");
const FRAGMENT: &str = include_str!("shaders/fragment.glsl");
const FULLSCREEN: &str = include_str!("shaders/fullscreen.vert");

/// Each scene's shader, in the order of `director::SCENES`.
const SCENE_SHADERS: [(&str, &str); 8] = [
    ("liquid.glsl", include_str!("shaders/liquid.glsl")),
    ("ink.glsl", include_str!("shaders/ink.glsl")),
    ("kaleido.glsl", include_str!("shaders/kaleido.glsl")),
    ("terrain.glsl", include_str!("shaders/terrain.glsl")),
    ("chrome.glsl", include_str!("shaders/chrome.glsl")),
    ("tunnel.glsl", include_str!("shaders/tunnel.glsl")),
    ("halo.glsl", include_str!("shaders/halo.glsl")),
    ("particles.glsl", include_str!("shaders/particles.glsl")),
];
/// The scene whose grains are drawn as points on top of its shader.
const PARTICLES: usize = 7;
/// Grains along each side of the particle cover.
const GRID: i32 = 160;

/// The scenes' height at full size; the screen's own if it is smaller.
const BASE_HEIGHT: u32 = 720;
/// Sizes to step through when frames come late, from full down.
const SCALES: [f32; 6] = [1.0, 0.85, 0.72, 0.6, 0.5, 0.4];
/// Frames slower than this, on average, mean the TV is struggling.
const SLOW_FRAME: f32 = 1.0 / 50.0;
/// Frames faster than this mean there is room to grow.
const FAST_FRAME: f32 = 1.0 / 58.0;
const SHRINK_AFTER: Duration = Duration::from_secs(2);
const GROW_AFTER: Duration = Duration::from_secs(12);

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
    points: Option<Program>,
    bright: Program,
    blur: Program,
    final_pass: Program,
    slots: [Slot; 2],
    bloom: [Target; 2],
    spectrum: glow::Texture,
    history: glow::Texture,
    wave: glow::Texture,
    noise: glow::Texture,
    cover: glow::Texture,
    /// The cover uploaded, held so its identity can't be reused.
    cover_shown: Option<Arc<Cover>>,
    colors: [[f32; 3]; 3],
    has_cover: bool,
    scale: usize,
    screen_height: u32,
    frame_time: f32,
    slow_since: Option<Instant>,
    fast_since: Option<Instant>,
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
            let fragment =
                |body: &str| format!("#version 300 es\n{COMMON}\n{FRAGMENT}\n#line 1\n{body}");
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
            let points = compile(
                "particles.vert",
                &format!(
                    "#version 300 es\n{COMMON}\n#line 1\n{}",
                    include_str!("shaders/particles.vert")
                ),
                &format!(
                    "#version 300 es\n{COMMON}\n#line 1\n{}",
                    include_str!("shaders/particles.frag")
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
            let (Some(bright), Some(blur), Some(final_pass)) = (bright, blur, final_pass) else {
                return None;
            };

            let vao = gl.create_vertex_array().ok()?;
            let spectrum = data_texture(gl, BANDS as i32, 1, glow::R8, false)?;
            let history = data_texture(gl, BANDS as i32, HISTORY_ROWS as i32, glow::R8, false)?;
            let wave = data_texture(gl, WAVE as i32, 1, glow::R8, false)?;
            let noise = data_texture(gl, 256, 256, glow::RGBA8, true)?;
            upload(gl, noise, 256, 256, glow::RGBA, &noise_pixels());
            let cover = data_texture(gl, COVER_SIDE as i32, COVER_SIDE as i32, glow::RGBA8, false)?;
            let (width, height) = (16, 16);
            let slots = [
                Slot {
                    scene: None,
                    seed: 0.0,
                    targets: [target(gl, width, height)?, target(gl, width, height)?],
                },
                Slot {
                    scene: None,
                    seed: 0.0,
                    targets: [target(gl, width, height)?, target(gl, width, height)?],
                },
            ];
            let bloom = [target(gl, 4, 4)?, target(gl, 4, 4)?];
            Some(Self {
                vao,
                scenes,
                points,
                bright,
                blur,
                final_pass,
                slots,
                bloom,
                spectrum,
                history,
                wave,
                noise,
                cover,
                cover_shown: None,
                colors: DEFAULT_COLORS,
                has_cover: false,
                scale: 1,
                screen_height: 0,
                frame_time: 1.0 / 60.0,
                slow_since: None,
                fast_since: None,
            })
        }
    }

    /// Whether `scene` compiled.
    pub fn can_draw(&self, scene: usize) -> bool {
        self.scenes.get(scene).is_some_and(Option::is_some)
            && (scene != PARTICLES || self.points.is_some())
    }

    pub fn scale(&self) -> f32 {
        SCALES[self.scale]
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

    pub fn has_cover(&self) -> bool {
        self.has_cover
    }

    /// Keep the scenes' size in step with how fast frames come.
    pub fn pace(&mut self, dt: f32) {
        self.frame_time += (dt - self.frame_time) * 0.05;
        let now = Instant::now();
        if self.frame_time > SLOW_FRAME {
            self.fast_since = None;
            let since = *self.slow_since.get_or_insert(now);
            if now - since > SHRINK_AFTER && self.scale + 1 < SCALES.len() {
                self.scale += 1;
                self.slow_since = None;
                log::info!(
                    "visuals: frames are slow, drawing at {}",
                    SCALES[self.scale]
                );
            }
        } else if self.frame_time < FAST_FRAME {
            self.slow_since = None;
            let since = *self.fast_since.get_or_insert(now);
            if now - since > GROW_AFTER && self.scale > 0 {
                self.scale -= 1;
                self.fast_since = None;
                log::info!("visuals: room to grow, drawing at {}", SCALES[self.scale]);
            }
        } else {
            self.slow_since = None;
            self.fast_since = None;
        }
    }

    /// Draw one frame onto the screen, `width` × `height` pixels.
    pub fn draw(
        &mut self,
        gl: &Gl,
        music: &Music,
        listener: &mut Listener,
        shot: &Shot,
        fade: f32,
        (width, height): (u32, u32),
    ) {
        if width == 0 || height == 0 {
            return;
        }
        self.screen_height = height;
        let saved = Saved::save(gl);
        unsafe {
            self.prepare(gl, width, height);
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

            let next = shot.next.map(|(next, _)| next.scene);
            let a = self.ensure_slot(gl, shot.current, next);
            let b = shot
                .next
                .map(|(next, _)| self.ensure_slot(gl, next, Some(shot.current.scene)));
            let mix = shot.next.map_or(0.0, |(_, progress)| progress);
            self.draw_scene(gl, a, shot.current, music, listener);
            if let (Some(b), Some((next, _))) = (b, shot.next) {
                self.draw_scene(gl, b, next, music, listener);
            }
            let out_a = &self.slots[a].targets[0];
            let out_b = &self.slots[b.unwrap_or(a)].targets[0];

            // Bloom: bright parts at a quarter size, blurred across and down.
            let [bloom_a, bloom_b] = &self.bloom;
            bind_target(gl, bloom_a);
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
                bind_target(gl, to);
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

            // The screen.
            gl.bind_framebuffer(glow::FRAMEBUFFER, saved.framebuffer);
            gl.viewport(0, 0, width as i32, height as i32);
            gl.use_program(Some(self.final_pass.program));
            let showing = Some(shot.current);
            self.set_music(
                gl,
                &self.final_pass,
                music,
                (width as i32, height as i32),
                showing,
                listener,
            );
            bind_texture(gl, &self.final_pass, "uSceneA", 0, out_a.texture);
            bind_texture(gl, &self.final_pass, "uSceneB", 1, out_b.texture);
            bind_texture(gl, &self.final_pass, "uBloom", 2, bloom_a.texture);
            bind_texture(gl, &self.final_pass, "uNoise", 3, self.noise);
            set_f32(gl, &self.final_pass, "uMix", mix);
            set_f32(gl, &self.final_pass, "uFade", fade);
            fullscreen(gl);
        }
        saved.restore(gl);
    }

    /// Size the scenes' textures for the screen and the current scale.
    unsafe fn prepare(&mut self, gl: &Gl, width: u32, height: u32) {
        unsafe {
            let tall = (BASE_HEIGHT.min(height) as f32 * SCALES[self.scale])
                .round()
                .max(90.0);
            let wide = (tall * width as f32 / height as f32).round();
            let (wide, tall) = (wide as i32, tall as i32);
            let resized =
                self.slots[0].targets[0].width != wide || self.slots[0].targets[0].height != tall;
            if !resized {
                return;
            }
            for slot in &mut self.slots {
                for target in &mut slot.targets {
                    resize(gl, target, wide, tall);
                }
                // The scene starts over from black at the new size.
                slot.scene = None;
            }
            for target in &mut self.bloom {
                resize(gl, target, (wide / 4).max(1), (tall / 4).max(1));
            }
        }
    }

    /// The slot holding `showing`, giving it one (cleared) if it has none,
    /// never the one holding `keep`.
    unsafe fn ensure_slot(&mut self, gl: &Gl, showing: Showing, keep: Option<usize>) -> usize {
        unsafe {
            if let Some(index) = self
                .slots
                .iter()
                .position(|slot| slot.scene == Some(showing.scene))
            {
                self.slots[index].seed = showing.seed;
                return index;
            }
            // Take a slot no scene on screen is using.
            let index = self
                .slots
                .iter()
                .position(|slot| slot.scene.is_none())
                .unwrap_or_else(|| usize::from(keep.is_some() && self.slots[0].scene == keep));
            let slot = &mut self.slots[index];
            slot.scene = Some(showing.scene);
            slot.seed = showing.seed;
            for target in &slot.targets {
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
                gl.viewport(0, 0, target.width, target.height);
                gl.clear_color(0.0, 0.0, 0.0, 1.0);
                gl.clear(glow::COLOR_BUFFER_BIT);
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
            bind_target(gl, write);
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
            if scene == PARTICLES
                && let Some(points) = &self.points
            {
                gl.enable(glow::BLEND);
                gl.blend_equation(glow::FUNC_ADD);
                gl.blend_func(glow::ONE, glow::ONE);
                gl.use_program(Some(points.program));
                self.set_music(
                    gl,
                    points,
                    music,
                    (write.width, write.height),
                    Some(showing),
                    listener,
                );
                set_f32(gl, points, "uGrid", GRID as f32);
                self.bind_inputs(gl, points, None);
                gl.draw_arrays(glow::POINTS, 0, GRID * GRID);
                gl.disable(glow::BLEND);
            }
            self.slots[slot].targets.swap(0, 1);
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
            f("uSeed", showing.map_or(0.0, |showing| showing.seed));
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
            let programs = self.scenes.into_iter().flatten().chain(self.points).chain([
                self.bright,
                self.blur,
                self.final_pass,
            ]);
            for program in programs {
                gl.delete_program(program.program);
            }
            for target in self
                .slots
                .into_iter()
                .flat_map(|slot| slot.targets)
                .chain(self.bloom)
            {
                gl.delete_framebuffer(target.framebuffer);
                gl.delete_texture(target.texture);
            }
            for texture in [
                self.spectrum,
                self.history,
                self.wave,
                self.noise,
                self.cover,
            ] {
                gl.delete_texture(texture);
            }
            gl.delete_vertex_array(self.vao);
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
        gl.clear_color(0.0, 0.0, 0.0, 1.0);
        gl.clear(glow::COLOR_BUFFER_BIT);
    }
}

unsafe fn bind_target(gl: &Gl, target: &Target) {
    unsafe {
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
        gl.viewport(0, 0, target.width, target.height);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::visuals::director::SCENES;

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
}
