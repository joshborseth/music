//! A particle engine on the GPU: tens of thousands of particles whose
//! state never leaves it.
//!
//! Each particle is a texel of an integer texture (RGBA32UI, see
//! `shaders/particles.glsl`): its place, velocity, color, and heat. Each
//! frame a full-texture pass (`particles_update.glsl`) reads the state and
//! writes the next into the other of a pair, pulling each particle toward
//! its target and applying the music's forces; then one point a particle
//! (`particles.vert`, `particles.frag`) is added onto the scene's picture,
//! its vertex shader reading its texel by vertex number. No vertex buffers,
//! no float textures, no extensions: integer textures are color-renderable
//! in OpenGL ES 3.0 itself, points and additive blending are core.
//!
//! What shape the particles make is up to the scene. Its targets are
//! another texture the same size, a texel a particle: where it is pulled,
//! how hard, how large and how bright it draws, and the color it takes on.
//! A scene fills them with a formation program of its own, a fragment
//! shader built with [`formation_source`] that writes a `uvec4` for each
//! particle, and runs it with [`Particles::form`] before each
//! [`Particles::step`]. `swarm_targets.glsl` is one: the cover made of
//! light, a galaxy, rings, a grid. Any picture can become a formation the
//! same way: sample it for bright texels, write their places.

use glow::HasContext;

use super::gpu::{
    COMMON, FULLSCREEN, Gl, HELPERS, Program, Target, bind_texture, fullscreen, set_f32, set_vec4,
};

/// The engine's shared declarations and helpers (`shaders/particles.glsl`).
pub const PARTICLES: &str = include_str!("shaders/particles.glsl");

/// The texture units of a scene's own state (the contract's `uState` and
/// `uState2`), past the eight every scene reads.
pub const STATE_UNIT: u32 = 11;
pub const STATE2_UNIT: u32 = 12;

/// The particle texture's size: one particle a texel, 32 768 in all. The
/// lab's bench chose it: as many as cost no more than Tunnel on its own.
pub const SIDE: (i32, i32) = (256, 128);

/// A fragment shader that writes integer state (a formation, an update
/// step): it declares its own `out uvec4` and reads `uState`/`uState2`.
pub fn formation_source(body: &str) -> String {
    format!("#version 300 es\n{COMMON}\n{PARTICLES}\n{HELPERS}\n#line 1\n{body}")
}

/// An integer texture of state, and the framebuffer that draws into it.
pub struct State {
    pub texture: glow::Texture,
    pub framebuffer: glow::Framebuffer,
    pub width: i32,
    pub height: i32,
}

impl State {
    /// A `width` × `height` texture of `format` (`RGBA32UI` or `RG32UI`)
    /// to draw into, or `None` if this GPU can't draw into one.
    ///
    /// # Safety
    /// Needs the GL context current, with its state saved (`Saved`).
    pub unsafe fn new(gl: &Gl, width: i32, height: i32, format: u32) -> Option<Self> {
        unsafe {
            let texture = gl.create_texture().ok()?;
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            let pixel = if format == glow::RG32UI {
                glow::RG_INTEGER
            } else {
                glow::RGBA_INTEGER
            };
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                format as i32,
                width,
                height,
                0,
                pixel,
                glow::UNSIGNED_INT,
                glow::PixelUnpackData::Slice(None),
            );
            // An integer texture with a linear filter is incomplete, and
            // reads as nothing.
            for (name, value) in [
                (glow::TEXTURE_MIN_FILTER, glow::NEAREST),
                (glow::TEXTURE_MAG_FILTER, glow::NEAREST),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, name, value as i32);
            }
            let Ok(framebuffer) = gl.create_framebuffer() else {
                gl.delete_texture(texture);
                return None;
            };
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(framebuffer));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );
            if gl.check_framebuffer_status(glow::FRAMEBUFFER) != glow::FRAMEBUFFER_COMPLETE {
                gl.delete_framebuffer(framebuffer);
                gl.delete_texture(texture);
                return None;
            }
            Some(Self {
                texture,
                framebuffer,
                width,
                height,
            })
        }
    }

    /// Draw into all of it: what it held is not needed.
    ///
    /// # Safety
    /// Needs the GL context current.
    pub unsafe fn begin(&self, gl: &Gl) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.framebuffer));
            gl.viewport(0, 0, self.width, self.height);
            gl.invalidate_framebuffer(glow::FRAMEBUFFER, &[glow::COLOR_ATTACHMENT0]);
        }
    }

    pub fn delete(self, gl: &Gl) {
        unsafe {
            gl.delete_framebuffer(self.framebuffer);
            gl.delete_texture(self.texture);
        }
    }
}

/// How the music moves the particles in one step (the update shader's
/// uniforms).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Forces {
    /// How hard targets pull (a spring's stiffness), how hard the curl
    /// noise swirls, how fast motion dies away, and the step in seconds
    /// (`uSwarmForce`).
    pub force: [f32; 4],
    /// A blast: from (x, y), how hard, and how hot it leaves particles
    /// (`uSwarmBlast`).
    pub blast: [f32; 4],
    /// The stream: where along its path, its lift, strength, and reach
    /// (`uSwarmStream`).
    pub stream: [f32; 4],
}

/// Sets the music's uniforms and the scene's inputs on a program, as for
/// the scene being drawn (`Renderer::set_music`, `bind_inputs`).
pub type Prepare<'a> = dyn Fn(&Program) + 'a;

/// The engine: its state, its targets, and its two programs.
pub struct Particles {
    /// The state now, and the one the next step writes.
    states: [State; 2],
    targets: State,
    update: Program,
    draw: Program,
    /// Start over from the seed on the next step.
    reset: bool,
}

impl Particles {
    /// Compile the engine and make its textures, `side` particles. `None`
    /// when either fails: the scene using it is then left out.
    ///
    /// # Safety
    /// Needs the GL context current, with its state saved (`Saved`).
    pub unsafe fn new(
        gl: &Gl,
        compile: &mut dyn FnMut(&str, &str, &str) -> Option<Program>,
        side: (i32, i32),
    ) -> Option<Self> {
        unsafe {
            let vertex = format!("#version 300 es\n{FULLSCREEN}");
            let update = compile(
                "particles_update.glsl",
                &vertex,
                &formation_source(include_str!("shaders/particles_update.glsl")),
            )?;
            let draw = compile(
                "particles.vert",
                &format!(
                    "#version 300 es\n{COMMON}\n{PARTICLES}\n{HELPERS}\n#line 1\n{}",
                    include_str!("shaders/particles.vert")
                ),
                &format!(
                    "#version 300 es\n{COMMON}\n#line 1\n{}",
                    include_str!("shaders/particles.frag")
                ),
            );
            let Some(draw) = draw else {
                gl.delete_program(update.program);
                return None;
            };
            let made = [
                State::new(gl, side.0, side.1, glow::RGBA32UI),
                State::new(gl, side.0, side.1, glow::RGBA32UI),
                State::new(gl, side.0, side.1, glow::RGBA32UI),
            ];
            if made.iter().any(Option::is_none) {
                for state in made.into_iter().flatten() {
                    state.delete(gl);
                }
                gl.delete_program(update.program);
                gl.delete_program(draw.program);
                return None;
            }
            let [Some(a), Some(b), Some(targets)] = made else {
                return None;
            };
            Some(Self {
                states: [a, b],
                targets,
                update,
                draw,
                reset: true,
            })
        }
    }

    pub fn count(&self) -> i32 {
        self.states[0].width * self.states[0].height
    }

    /// Start over on the next step: every particle bursts out of the
    /// middle, each the same way for the same seed (`uSeed`).
    pub fn reset(&mut self) {
        self.reset = true;
    }

    /// Fill the targets with `formation`, a program built from
    /// [`formation_source`], after `prepare` gives it the music and the
    /// scene's inputs. The formation may read the particles' state
    /// (`uState`).
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn form(&self, gl: &Gl, formation: &Program, prepare: &Prepare<'_>) {
        unsafe {
            self.targets.begin(gl);
            gl.use_program(Some(formation.program));
            prepare(formation);
            bind_texture(gl, formation, "uState", STATE_UNIT, self.states[0].texture);
            // The targets are being drawn: nothing may read them now.
            gl.active_texture(glow::TEXTURE0 + STATE2_UNIT);
            gl.bind_texture(glow::TEXTURE_2D, None);
            fullscreen(gl);
        }
    }

    /// Move every particle one step toward its target, as `forces` say.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn step(&mut self, gl: &Gl, forces: &Forces, prepare: &Prepare<'_>) {
        unsafe {
            let [now, next] = &self.states;
            next.begin(gl);
            let program = &self.update;
            gl.use_program(Some(program.program));
            prepare(program);
            bind_texture(gl, program, "uState", STATE_UNIT, now.texture);
            bind_texture(gl, program, "uState2", STATE2_UNIT, self.targets.texture);
            set_vec4(gl, program, "uSwarmForce", forces.force);
            set_vec4(gl, program, "uSwarmBlast", forces.blast);
            set_vec4(gl, program, "uSwarmStream", forces.stream);
            set_f32(
                gl,
                program,
                "uSwarmReset",
                if self.reset { 1.0 } else { 0.0 },
            );
            fullscreen(gl);
            self.states.swap(0, 1);
            self.reset = false;
        }
    }

    /// Add every particle onto `target` as a point `size` pixels across at
    /// its target's size 1, `gain` bright. Leaves blending off.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state
    /// (it covers the blending this changes).
    pub unsafe fn draw(
        &self,
        gl: &Gl,
        target: &Target,
        size: f32,
        gain: f32,
        prepare: &Prepare<'_>,
    ) {
        unsafe {
            // The scene's pass has just drawn into `target`; the points go
            // on top of it, so it is not invalidated.
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(target.framebuffer));
            gl.viewport(0, 0, target.width, target.height);
            let program = &self.draw;
            gl.use_program(Some(program.program));
            prepare(program);
            bind_texture(gl, program, "uState", STATE_UNIT, self.states[0].texture);
            bind_texture(gl, program, "uState2", STATE2_UNIT, self.targets.texture);
            set_f32(gl, program, "uSwarmSize", size);
            set_f32(gl, program, "uSwarmGain", gain);
            gl.enable(glow::BLEND);
            gl.blend_equation(glow::FUNC_ADD);
            gl.blend_func(glow::ONE, glow::ONE);
            gl.draw_arrays(glow::POINTS, 0, self.count());
            gl.disable(glow::BLEND);
        }
    }

    pub fn delete(self, gl: &Gl) {
        unsafe {
            gl.delete_program(self.update.program);
            gl.delete_program(self.draw.program);
        }
        for state in self.states {
            state.delete(gl);
        }
        self.targets.delete(gl);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_particles_fit_a_small_gpu() {
        // Every particle is a vertex and a texel: a power of two each way,
        // within what any OpenGL ES 3 GPU can hold, and few enough that
        // their points cost no more than a heavy scene.
        let (wide, tall) = SIDE;
        assert!(wide.count_ones() == 1 && tall.count_ones() == 1);
        assert!(wide <= 2048 && tall <= 2048);
        assert!((16_384..=65_536).contains(&(wide * tall)));
    }

    #[test]
    fn state_passes_declare_what_they_read() {
        let source = formation_source("void main() {}");
        assert!(source.starts_with("#version 300 es\n"));
        assert!(source.contains("uniform usampler2D uState;"));
        assert!(source.contains("precision highp usampler2D;"));
        // Nothing from the color passes, whose `out vec4` would clash.
        assert!(!source.contains("out vec4 fragColor"));
    }
}
