//! The TV's wall clock, in its own time zone, for the top bar and greeting.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub hour: u32,
    pub minute: u32,
}

impl LocalTime {
    pub fn now() -> Self {
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
