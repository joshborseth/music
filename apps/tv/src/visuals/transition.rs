//! A change of scene as `final.glsl` draws it: the old scene's last frame,
//! frozen, destroyed one of several ways while the new scene shows through.
//!
//! Only the scene coming in draws, every frame; the one leaving keeps its
//! slot's last frame (`gpu.rs`, `ensure_slot`), so a change costs one scene
//! and a few reads in `final`, less than the dissolve it replaced, which
//! drew both scenes in turn.
//!
//! The lab's `TRANSITIONS` (`apps/tv/visuals-lab/moments.ts`) uses the same
//! codes; keep the two in step.

use crate::catalog::TransitionKind;

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
    /// The kind as `final.glsl`'s `uTransKind` reads it.
    pub fn code(&self) -> f32 {
        match self.kind {
            TransitionKind::Cut => 0.0,
            TransitionKind::Shatter => 1.0,
            TransitionKind::Melt => 2.0,
            TransitionKind::ZoomThrough => 3.0,
            TransitionKind::Datamosh => 4.0,
            TransitionKind::Wipe => 5.0,
        }
    }
}
