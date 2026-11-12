//! The TV's wall clock, for the top bar and greeting.
//!
//! The server sends the house's UTC offset, read from its own up-to-date
//! time zone rules; Android's can be older (it still turns British Columbia's
//! clock back an hour from 2026-11-01). The TV's own time zone is only used
//! until the server has said.

use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub hour: u32,
    pub minute: u32,
}

impl LocalTime {
    pub fn now(utc_offset_minutes: Option<i32>) -> Self {
        match utc_offset_minutes {
            Some(offset) => {
                let seconds = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_secs() as i64);
                Self::at(seconds, offset)
            }
            None => Self::from_android(),
        }
    }

    /// The wall time `utc_offset_minutes` from UTC at epoch `seconds`.
    fn at(seconds: i64, utc_offset_minutes: i32) -> Self {
        let minute_of_day =
            (seconds.div_euclid(60) + i64::from(utc_offset_minutes)).rem_euclid(24 * 60);
        Self {
            hour: (minute_of_day / 60) as u32,
            minute: (minute_of_day % 60) as u32,
        }
    }

    fn from_android() -> Self {
        let mut seconds: libc::time_t = 0;
        // SAFETY: `time` and `localtime_r` only write to the pointers given;
        // `tm` is zeroed plain data.
        let tm = unsafe {
            libc::time(&mut seconds);
            let mut tm: libc::tm = std::mem::zeroed();
            libc::localtime_r(&seconds, &mut tm);
            tm
        };
        Self {
            hour: tm.tm_hour.clamp(0, 23) as u32,
            minute: tm.tm_min.clamp(0, 59) as u32,
        }
    }

    /// "9:41 PM".
    pub fn clock(self) -> String {
        let hour = match self.hour % 12 {
            0 => 12,
            hour => hour,
        };
        let half = if self.hour < 12 { "AM" } else { "PM" };
        format!("{hour}:{:02} {half}", self.minute)
    }

    pub fn greeting(self) -> &'static str {
        match self.hour {
            5..=11 => "Good morning",
            12..=16 => "Good afternoon",
            17..=22 => "Good evening",
            _ => "Up late?",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_the_servers_offset() {
        // 2026-11-12 21:23:04 UTC is 2:23 PM at UTC-7.
        assert_eq!(
            LocalTime::at(1_794_518_584, -420),
            LocalTime {
                hour: 14,
                minute: 23
            }
        );
        // Crosses midnight both ways.
        assert_eq!(
            LocalTime::at(1_794_528_000 - 60, 60),
            LocalTime {
                hour: 0,
                minute: 59
            }
        );
        assert_eq!(
            LocalTime::at(1_794_528_000 + 60, -480),
            LocalTime {
                hour: 16,
                minute: 1
            }
        );
    }

    #[test]
    fn formats_twelve_hour_time() {
        assert_eq!(LocalTime { hour: 0, minute: 5 }.clock(), "12:05 AM");
        assert_eq!(
            LocalTime {
                hour: 12,
                minute: 0
            }
            .clock(),
            "12:00 PM"
        );
        assert_eq!(
            LocalTime {
                hour: 21,
                minute: 41
            }
            .clock(),
            "9:41 PM"
        );
        assert_eq!(
            LocalTime {
                hour: 19,
                minute: 0
            }
            .greeting(),
            "Good evening"
        );
    }
}
