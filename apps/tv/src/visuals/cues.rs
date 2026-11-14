//! The song's choreography (`catalog::Choreography`, planned by the server)
//! in one frame: how far into a build, how long until it lands, how long
//! since the last landing, whether this is the climax or a bar to strobe,
//! and how the section playing now came in.
//!
//! The server knows the whole song, so a landing's time is known before it
//! comes: the screen keys its build-up off the seconds left until it, not
//! off how loud the music is getting, and lands on the frame.

use crate::catalog::{Choreography, TransitionKind};

/// "No landing coming" or "none yet", in seconds: far enough that every
/// ramp keyed off it has settled.
pub const FAR: f32 = 99.0;

/// The choreography's cues in one frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cues {
    /// Seconds until the landing of the build under way, `FAR` when none
    /// is (`uCueIn`).
    pub until: f32,
    /// How far through that build, 0 to 1; 0 outside one (`uCueBuild`).
    pub build: f32,
    /// How big the coming landing is, or the latest one when none is
    /// coming, 0 to 1.
    pub strength: f32,
    /// Seconds since the latest landing (a build's, or the music coming
    /// back after a breath), `FAR` before any.
    pub since: f32,
    /// How big that latest landing was, 0 to 1.
    pub landed: f32,
    /// 1 through the climax, from where it lands (`uCueClimax`).
    pub climax: f32,
    /// True in the bars where hard strobing fits.
    pub strobe: bool,
    /// How the section playing now came in, and over how many beats, when
    /// the plan says.
    pub transition: Option<(TransitionKind, f32)>,
}

impl Default for Cues {
    fn default() -> Self {
        Self {
            until: FAR,
            build: 0.0,
            strength: 0.0,
            since: FAR,
            landed: 0.0,
            climax: 0.0,
            strobe: false,
            transition: None,
        }
    }
}

/// Two moments this close, in seconds, are the same one.
const SAME: f64 = 0.2;
/// Landings closer than this, in seconds, land as one: bright flashes
/// come no faster than three a second.
const FLASH_GAP: f64 = 0.4;

impl Cues {
    /// The cues at `t` seconds into the song, the section playing having
    /// started at `section_start`.
    pub fn at(plan: &Choreography, t: f64, section_start: Option<f64>) -> Self {
        let mut cues = Self::default();
        let far = f64::from(FAR);
        if let Some(build) = plan
            .builds
            .iter()
            .find(|build| build.start_seconds <= t && t < build.land_seconds)
        {
            let length = (build.land_seconds - build.start_seconds).max(0.01);
            cues.until = (build.land_seconds - t).min(far) as f32;
            cues.build = ((t - build.start_seconds) / length).clamp(0.0, 1.0) as f32;
            cues.strength = build.strength;
        }
        // The latest landing: a build's, or the music coming back after a
        // breath, which lands like a drop.
        let built = plan
            .builds
            .iter()
            .rev()
            .find(|build| build.land_seconds <= t)
            .map(|build| (build.land_seconds, build.strength));
        // A return this near a build's landing is the same hit: two flashes
        // so close would come faster than comfort allows.
        let breathed = plan
            .breaths
            .iter()
            .rev()
            .filter(|breath| {
                !plan
                    .builds
                    .iter()
                    .any(|build| (build.land_seconds - breath.end_seconds).abs() < FLASH_GAP)
            })
            .find(|breath| breath.end_seconds <= t)
            .map(|breath| (breath.end_seconds, 1.0));
        let latest = match (built, breathed) {
            (Some(a), Some(b)) => Some(if b.0 > a.0 { b } else { a }),
            (a, b) => a.or(b),
        };
        if let Some((at, strength)) = latest {
            cues.since = (t - at).min(far) as f32;
            cues.landed = strength;
            if cues.until >= FAR {
                cues.strength = strength;
            }
        }
        if let Some(climax) = plan.climax
            && climax.land_seconds <= t
            && t < climax.end_seconds
        {
            cues.climax = 1.0;
        }
        cues.strobe = plan
            .strobes
            .iter()
            .any(|span| span.start_seconds <= t && t < span.end_seconds);
        cues.transition = section_start.and_then(|start| {
            plan.transitions
                .iter()
                .find(|transition| (transition.at_seconds - start).abs() < SAME)
                .map(|transition| (transition.kind, transition.beats))
        });
        cues
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{Build, Climax, Span, Transition};

    fn plan() -> Choreography {
        Choreography {
            climax: Some(Climax {
                start_seconds: 16.0,
                end_seconds: 32.0,
                land_seconds: 16.0,
            }),
            builds: vec![Build {
                start_seconds: 8.0,
                land_seconds: 16.0,
                strength: 1.0,
            }],
            breaths: vec![Span {
                start_seconds: 20.0,
                end_seconds: 20.5,
            }],
            strobes: vec![Span {
                start_seconds: 16.0,
                end_seconds: 20.0,
            }],
            transitions: vec![Transition {
                at_seconds: 16.0,
                kind: TransitionKind::Shatter,
                beats: 2.0,
            }],
        }
    }

    #[test]
    fn a_build_counts_down_to_its_landing() {
        let plan = plan();
        let before = Cues::at(&plan, 4.0, Some(0.0));
        assert_eq!(before.until, FAR);
        assert_eq!(before.build, 0.0);
        assert_eq!(before.since, FAR);
        assert_eq!(before.transition, None);
        let half = Cues::at(&plan, 12.0, Some(0.0));
        assert!((half.until - 4.0).abs() < 1e-5);
        assert!((half.build - 0.5).abs() < 1e-5);
        assert_eq!(half.strength, 1.0);
        let landed = Cues::at(&plan, 16.25, Some(16.0));
        assert_eq!(landed.until, FAR);
        assert!((landed.since - 0.25).abs() < 1e-5);
        assert_eq!(landed.climax, 1.0);
        assert!(landed.strobe);
        assert_eq!(landed.transition, Some((TransitionKind::Shatter, 2.0)));
    }

    #[test]
    fn a_breath_ending_on_a_landing_lands_once() {
        let mut plan = plan();
        plan.breaths.push(Span {
            start_seconds: 15.0,
            end_seconds: 15.8,
        });
        let landed = Cues::at(&plan, 16.1, Some(16.0));
        assert!((landed.since - 0.1).abs() < 1e-5);
        assert!((Cues::at(&plan, 15.9, Some(0.0)).since - 0.1).abs() > 1.0);
    }

    #[test]
    fn the_music_coming_back_after_a_breath_lands() {
        let plan = plan();
        let held = Cues::at(&plan, 20.2, Some(16.0));
        assert!(held.since > 4.0);
        assert!(!held.strobe);
        let back = Cues::at(&plan, 20.6, Some(16.0));
        assert!((back.since - 0.1).abs() < 1e-5);
        assert_eq!(back.landed, 1.0);
        let after = Cues::at(&plan, 40.0, Some(32.0));
        assert_eq!(after.climax, 0.0);
    }
}
