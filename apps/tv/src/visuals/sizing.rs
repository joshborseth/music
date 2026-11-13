//! How large each scene is drawn, so frames keep coming on time.
//!
//! Each scene has its own size, because Silk costs a fraction of what
//! Halo does. A scene whose frames come late shrinks within a second or
//! two. A scene that keeps time grows a step after a while, but it never
//! goes straight back to a size that already failed: that size is tried
//! again only after minutes of clean frames, and each failure doubles the
//! wait. So a TV settles on the largest size each scene can hold, instead
//! of climbing back into a stutter every few seconds.
//!
//! Under the smallest size there is one more step: the scene is drawn every
//! other frame (30 a second) while the screen and the app's words keep 60.
//!
//! Frames are only counted while a scene shows alone; see `Renderer::pace`.

/// Sizes to step through, from full down.
pub const SCALES: [f32; 7] = [1.0, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35];
/// The last step: the smallest size, drawn every other frame.
const HALF_RATE: usize = SCALES.len();
/// Where every scene starts.
const START: usize = 1;
/// A frame that took longer than a frame and a half at 60 Hz: a stutter.
pub const LATE: f32 = 1.5 / 60.0;
/// Frames are judged a second at a time.
const WINDOW: f32 = 1.0;
/// A second with at least this many late frames, and this share of them,
/// is bad. Two bad seconds in a row shrink the scene a step.
const BAD_LATE: u32 = 3;
const BAD_SHARE: f32 = 0.05;
const BAD_RUN: u32 = 2;
/// A second where this share came late shrinks it at once...
const VERY_BAD_SHARE: f32 = 0.25;
/// ...and two steps when most frames came late.
const MOSTLY_LATE: f32 = 0.6;
/// Seconds a new size is left to settle before it is judged: a resize
/// itself costs a frame or two.
const SETTLE: f32 = 1.5;
/// Clean seconds before a scene tries a size that never failed...
const GROW_AFTER: f32 = 10.0;
/// ...and before it tries again one that did, the first time. Each failure
/// doubles the wait, up to the longest.
const RETRY_AFTER: f32 = 180.0;
const RETRY_LONGEST: f32 = 1800.0;

/// What changed after a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Shrank,
    Grew,
}

/// One scene's size.
#[derive(Debug, Clone)]
pub struct Sizing {
    /// An index into `SCALES`, or `HALF_RATE`.
    step: usize,
    /// Clean seconds each step needs before it is tried again; 0 for a
    /// step that never failed.
    wait: [f32; HALF_RATE + 1],
    /// Clean seconds at this step.
    clean: f32,
    settle: f32,
    window: f32,
    frames: u32,
    late: u32,
    bad_run: u32,
    /// Whether the scene has shown at all, for the report.
    shown: bool,
}

impl Default for Sizing {
    fn default() -> Self {
        Self {
            step: START,
            wait: [0.0; HALF_RATE + 1],
            clean: 0.0,
            settle: 0.0,
            window: 0.0,
            frames: 0,
            late: 0,
            bad_run: 0,
            shown: false,
        }
    }
}

impl Sizing {
    /// The scene's size, as a share of the full size.
    pub fn scale(&self) -> f32 {
        SCALES[self.step.min(SCALES.len() - 1)]
    }

    /// True when the scene is drawn every other frame.
    pub fn half_rate(&self) -> bool {
        self.step == HALF_RATE
    }

    pub fn shown(&self) -> bool {
        self.shown
    }

    /// Count a frame of this scene alone that took `dt` seconds.
    pub fn frame(&mut self, dt: f32) -> Option<Change> {
        self.shown = true;
        if self.settle > 0.0 {
            self.settle -= dt;
            return None;
        }
        self.window += dt;
        self.frames += 1;
        if dt > LATE {
            self.late += 1;
        }
        if self.window < WINDOW {
            return None;
        }
        let seconds = self.window;
        let share = self.late as f32 / self.frames.max(1) as f32;
        let bad = self.late >= BAD_LATE && share >= BAD_SHARE;
        self.window = 0.0;
        self.frames = 0;
        self.late = 0;
        if bad {
            self.clean = 0.0;
            self.bad_run += 1;
            if share >= VERY_BAD_SHARE || self.bad_run >= BAD_RUN {
                return self.shrink(if share >= MOSTLY_LATE { 2 } else { 1 });
            }
            return None;
        }
        self.bad_run = 0;
        self.clean += seconds;
        let up = self.step.checked_sub(1)?;
        let need = if self.wait[up] > 0.0 {
            self.wait[up]
        } else {
            GROW_AFTER
        };
        if self.clean < need {
            return None;
        }
        self.step = up;
        self.settled();
        Some(Change::Grew)
    }

    fn shrink(&mut self, steps: usize) -> Option<Change> {
        // The size that failed waits longer before it is tried again.
        let wait = &mut self.wait[self.step];
        *wait = if *wait > 0.0 {
            (*wait * 2.0).min(RETRY_LONGEST)
        } else {
            RETRY_AFTER
        };
        let from = self.step;
        self.step = (self.step + steps).min(HALF_RATE);
        self.settled();
        (self.step != from).then_some(Change::Shrank)
    }

    fn settled(&mut self) {
        self.settle = SETTLE;
        self.clean = 0.0;
        self.bad_run = 0;
        self.window = 0.0;
        self.frames = 0;
        self.late = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON_TIME: f32 = 1.0 / 60.0;
    const DROPPED: f32 = 2.0 / 60.0;

    /// Run `seconds` of frames, `late_every`-th one late (0: none).
    fn run(sizing: &mut Sizing, seconds: f32, late_every: u32) -> Vec<Change> {
        let mut changes = Vec::new();
        let mut time = 0.0;
        let mut count = 0;
        while time < seconds {
            count += 1;
            let dt = if late_every > 0 && count % late_every == 0 {
                DROPPED
            } else {
                ON_TIME
            };
            time += dt;
            changes.extend(sizing.frame(dt));
        }
        changes
    }

    /// A made-up TV that holds 60 at `holds` (a step) and smaller, and
    /// drops every other frame at bigger sizes. Returns each step it
    /// visited, one per second.
    fn on_tv(sizing: &mut Sizing, holds: usize, seconds: u32) -> Vec<usize> {
        let mut steps = Vec::new();
        for _ in 0..seconds {
            let late_every = if sizing.step < holds { 2 } else { 0 };
            run(sizing, 1.0, late_every);
            steps.push(sizing.step);
        }
        steps
    }

    #[test]
    fn late_frames_shrink_the_scene_quickly() {
        let mut sizing = Sizing::default();
        let changes = run(&mut sizing, 2.5, 2);
        assert_eq!(changes.first(), Some(&Change::Shrank));
        assert!(sizing.scale() < SCALES[START]);
    }

    #[test]
    fn a_lone_hitch_changes_nothing() {
        let mut sizing = Sizing::default();
        let mut changes = run(&mut sizing, 5.0, 0);
        changes.extend(sizing.frame(0.1));
        changes.extend(run(&mut sizing, 3.0, 0));
        assert!(changes.is_empty(), "{changes:?}");
        assert_eq!(sizing.step, START);
    }

    #[test]
    fn a_scene_that_keeps_time_grows() {
        let mut sizing = Sizing::default();
        assert_eq!(run(&mut sizing, 12.0, 0), vec![Change::Grew]);
        assert_eq!(sizing.scale(), 1.0);
    }

    #[test]
    fn it_settles_instead_of_climbing_back_into_a_stutter() {
        // This TV holds step 3; bigger sizes drop half the frames.
        let mut sizing = Sizing::default();
        let steps = on_tv(&mut sizing, 3, 600);
        // It finds step 3 within a few seconds...
        let found = steps.iter().position(|step| *step == 3).expect("settles");
        assert!(found < 10, "{steps:?}");
        // ...and over ten minutes tries a bigger size again only a few
        // times, waiting longer each time.
        let tries = steps.windows(2).filter(|pair| pair[1] < pair[0]).count();
        assert!(tries <= 3, "tried {tries} times: {steps:?}");
        let at_three = steps[found..].iter().filter(|step| **step == 3).count();
        assert!(at_three as f32 > (steps.len() - found) as f32 * 0.97);
    }

    #[test]
    fn it_still_grows_into_sizes_that_never_failed() {
        let mut sizing = Sizing::default();
        // Very slow at first: it drops two steps at once...
        run(&mut sizing, 1.2, 1);
        assert_eq!(sizing.step, START + 2);
        // ...then holds time, so it grows back into the untried size between.
        run(&mut sizing, 13.0, 0);
        assert_eq!(sizing.step, START + 1);
        // The size that failed waits minutes, not seconds.
        run(&mut sizing, 60.0, 0);
        assert_eq!(sizing.step, START + 1);
        run(&mut sizing, 125.0, 0);
        assert_eq!(sizing.step, START);
    }

    #[test]
    fn the_last_resort_is_half_rate() {
        let mut sizing = Sizing::default();
        run(&mut sizing, 30.0, 1);
        assert!(sizing.half_rate());
        assert_eq!(sizing.scale(), SCALES[SCALES.len() - 1]);
    }
}
