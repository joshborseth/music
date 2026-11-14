//! A change of scene as `final.glsl` draws it: the old scene's last frame,
//! frozen, destroyed one of several ways while the new scene shows through.
//!
//! Only the scene coming in draws, every frame; the one leaving keeps its
//! slot's last frame (`gpu.rs`, `ensure_slot`), so a change costs one scene
//! and a few reads in `final`. Each kind is its own build of `final.glsl`
//! (`TRANSITION` defined as its code), so the picture between changes
//! carries none of their code.
//!
//! The lab's `TRANSITIONS` (`apps/tv/visuals-lab/moments.ts`) uses the same
//! codes; keep the two in step.

use crate::catalog::TransitionKind;

/// How many codes there are, `Cut` (0, no change running) included.
pub const TRANSITIONS: usize = 6;

/// One frame of a change of scene.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SceneChange {
    pub kind: TransitionKind,
    /// How far, 0 to 1.
    pub progress: f32,
    /// The look of the scene coming in, which varies the way it comes.
    pub seed: f32,
}

impl SceneChange {
    /// The kind's code: `final.glsl`'s `TRANSITION`.
    pub fn code(&self) -> usize {
        match self.kind {
            TransitionKind::Cut => 0,
            TransitionKind::Shatter => 1,
            TransitionKind::Melt => 2,
            TransitionKind::ZoomThrough => 3,
            TransitionKind::Datamosh => 4,
            TransitionKind::Wipe => 5,
        }
    }
}
