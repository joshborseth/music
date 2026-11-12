//! Where the singing is in a song's timed lyrics, as rows for the lyrics
//! panel. Mirrors `apps/web/src/lyrics.ts`: a row is a sung line, or a break
//! where the singer rests (the intro, and the gaps LRC marks with an empty
//! line), drawn as dots that light up as the break runs out.

use crate::catalog::LyricLine;

/// A line lights up this early, so it is bright by the time it is sung.
pub const LEAD_SECONDS: f64 = 0.15;

/// Shorter rests than this are part of the singing and show no dots.
pub const MIN_BREAK_SECONDS: f64 = 3.0;

/// How many dots a break shows.
pub const BREAK_DOTS: usize = 3;

/// A song's lyrics, and the same lyrics timed line by line when known.
#[derive(Debug, Clone, PartialEq)]
pub struct SongLyrics {
    pub text: String,
    /// Empty when the lyrics are not timed.
    pub lines: Vec<LyricLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Past,
    Active,
    Next,
    /// A break that is not happening now; drawn with no height.
    Rest,
    /// A break happening now: the dots show.
    Break,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub text: String,
    pub kind: RowKind,
    /// How many of a break's dots are lit.
    pub lit: usize,
}

fn break_row(start: f64, end: f64, at: f64) -> Row {
    let length = end - start;
    let active = length >= MIN_BREAK_SECONDS && at >= start && at < end;
    let lit = if active {
        let progress = (at - start) / length;
        ((progress * (BREAK_DOTS + 1) as f64).floor() as usize).min(BREAK_DOTS)
    } else {
        0
    };
    Row {
        text: String::new(),
        kind: if active {
            RowKind::Break
        } else {
            RowKind::Rest
        },
        lit,
    }
}

/// Every row of the lyrics as they stand `position` seconds into the song.
pub fn rows(lines: &[LyricLine], position: f64) -> Vec<Row> {
    let at = position + LEAD_SECONDS;
    let active = lines.iter().rposition(|line| line.start_seconds <= at);
    let intro = lines
        .first()
        .filter(|first| first.start_seconds >= MIN_BREAK_SECONDS)
        .map(|first| break_row(0.0, first.start_seconds, at));
    let rows = lines.iter().enumerate().map(|(index, line)| {
        let end = lines
            .get(index + 1)
            .map_or(f64::INFINITY, |next| next.start_seconds);
        if line.text.is_empty() {
            let sung_after = lines[index + 1..].iter().any(|line| !line.text.is_empty());
            return break_row(
                line.start_seconds,
                if sung_after { end } else { line.start_seconds },
                at,
            );
        }
        let kind = match active {
            Some(active) if index < active => RowKind::Past,
            Some(active) if index == active => RowKind::Active,
            _ => RowKind::Next,
        };
        Row {
            text: line.text.clone(),
            kind,
            lit: 0,
        }
    });
    intro.into_iter().chain(rows).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_seconds: f64, text: &str) -> LyricLine {
        LyricLine {
            start_seconds,
            text: text.to_owned(),
            words: Vec::new(),
        }
    }

    fn lines() -> Vec<LyricLine> {
        vec![
            line(10.0, "One"),
            line(14.0, "Two"),
            line(18.0, ""),
            line(30.0, "Three"),
            line(40.0, ""),
        ]
    }

    fn kinds(position: f64) -> Vec<RowKind> {
        rows(&lines(), position)
            .iter()
            .map(|row| row.kind)
            .collect()
    }

    #[test]
    fn the_intro_breaks_until_the_first_line() {
        let rows = rows(&lines(), 6.0);
        assert_eq!(rows[0].kind, RowKind::Break);
        assert_eq!(rows[0].lit, 2);
        assert_eq!(rows[1].kind, RowKind::Next);
    }

    #[test]
    fn lines_before_the_active_one_are_past() {
        use RowKind::*;
        assert_eq!(kinds(15.0), vec![Rest, Past, Active, Rest, Next, Rest]);
    }

    #[test]
    fn a_long_rest_shows_dots_and_the_outro_never_does() {
        use RowKind::*;
        assert_eq!(kinds(20.0), vec![Rest, Past, Past, Break, Next, Rest]);
        assert_eq!(kinds(45.0), vec![Rest, Past, Past, Rest, Past, Rest]);
    }
}
