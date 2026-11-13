//! Lines for the server's log (`POST /tv-log`), which is where anything the
//! TV has to say ends up, since no debugger is attached to it.

/// Where to post a line for the server's log at `level`: the server logs
/// it at that level (`tvLogLevel` in `apps/server/src/tvApp.ts`). A line
/// posted without one, as a crash is (`crash_report.rs`), lands as an
/// error.
pub fn url(server: &str, level: log::Level) -> String {
    let level = match level {
        log::Level::Error => "error",
        log::Level::Warn => "warning",
        log::Level::Info | log::Level::Debug | log::Level::Trace => "info",
    };
    format!("{server}/tv-log?level={level}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_level_the_server_reads() {
        let server = "http://192.168.1.10:4310";
        assert_eq!(
            url(server, log::Level::Info),
            "http://192.168.1.10:4310/tv-log?level=info"
        );
        assert_eq!(
            url(server, log::Level::Warn),
            "http://192.168.1.10:4310/tv-log?level=warning"
        );
        assert_eq!(
            url(server, log::Level::Error),
            "http://192.168.1.10:4310/tv-log?level=error"
        );
    }
}
