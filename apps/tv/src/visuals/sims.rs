//! The scenes that simulate on the GPU before they draw: Swarm's particles
//! (`swarm.rs`) and Coral's reef (`coral.rs`). The renderer calls them
//! around a scene's own pass: `before` runs the simulation into its own
//! textures, `bind` hands the scene's program what it reads of it, and
//! `after` draws on top of the scene's picture.

use super::coral::Coral;
use super::director::scene_index;
use super::gpu::{Gl, Program, Target};
use super::music::Music;
use super::particles::Prepare;
use super::swarm::Swarm;

pub const SWARM: usize = scene_index("Swarm");
pub const CORAL: usize = scene_index("Coral");

#[derive(Default)]
pub struct Sims {
    swarm: Option<Swarm>,
    coral: Option<Coral>,
}

impl Sims {
    /// Build both; one that fails to compile, or whose textures this GPU
    /// can't draw into, is left out (and its scene with it).
    ///
    /// # Safety
    /// Needs the GL context current, with its state saved (`Saved`).
    pub unsafe fn new(
        gl: &Gl,
        compile: &mut dyn FnMut(&str, &str, &str) -> Option<Program>,
        fragment: &dyn Fn(&str) -> String,
        errors: &mut Vec<String>,
    ) -> Self {
        unsafe {
            let swarm = Swarm::new(gl, compile);
            if swarm.is_none() {
                errors.push("Swarm: no particles on this GPU".to_owned());
            }
            let coral = Coral::new(gl, compile, fragment);
            if coral.is_none() {
                errors.push("Coral: no reef on this GPU".to_owned());
            }
            Self { swarm, coral }
        }
    }

    /// Whether `scene`, if it simulates, has what it needs.
    pub fn ready(&self, scene: usize) -> bool {
        match scene {
            SWARM => self.swarm.is_some(),
            CORAL => self.coral.is_some(),
            _ => true,
        }
    }

    /// Step `scene`'s simulation, if it has one. `fresh` is its first
    /// frame since it came on, which starts it over, as a new `seed` does.
    /// Only the scene drawing calls this: one frozen while another takes
    /// over keeps its state, untouched.
    ///
    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn before(
        &mut self,
        gl: &Gl,
        scene: usize,
        music: &Music,
        seed: f32,
        fresh: bool,
        prepare: &Prepare<'_>,
    ) {
        unsafe {
            match scene {
                SWARM => {
                    if let Some(swarm) = &mut self.swarm {
                        swarm.before(gl, music, seed, fresh, prepare);
                    }
                }
                CORAL => {
                    if let Some(coral) = &mut self.coral {
                        coral.before(gl, music, seed, fresh, prepare);
                    }
                }
                _ => {}
            }
        }
    }

    /// # Safety
    /// Needs the GL context current, with `program` in use.
    pub unsafe fn bind(&self, gl: &Gl, scene: usize, program: &Program) {
        unsafe {
            match scene {
                SWARM => {
                    if let Some(swarm) = &self.swarm {
                        swarm.bind(gl, program);
                    }
                }
                CORAL => {
                    if let Some(coral) = &self.coral {
                        coral.bind(gl, program);
                    }
                }
                _ => {}
            }
        }
    }

    /// # Safety
    /// Needs the GL context current, inside the renderer's saved state.
    pub unsafe fn after(&self, gl: &Gl, scene: usize, target: &Target, prepare: &Prepare<'_>) {
        unsafe {
            if scene == SWARM
                && let Some(swarm) = &self.swarm
            {
                swarm.after(gl, target, prepare);
            }
        }
    }

    pub fn delete(self, gl: &Gl) {
        if let Some(swarm) = self.swarm {
            swarm.delete(gl);
        }
        if let Some(coral) = self.coral {
            coral.delete(gl);
        }
    }
}
