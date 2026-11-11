//! Sends panics to the server's log before the app aborts.
//!
//! Release builds abort on panic, and no debugger is attached to the TV, so
//! without this a crash leaves no trace anywhere we can read.

use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(2);

/// Log every panic, and post it to `{server}/tv-log`.
pub fn install(server: &'static str) {
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let report = format!(
            "panic in thread '{}': {info}\n{}",
            thread.name().unwrap_or("unnamed"),
            std::backtrace::Backtrace::force_capture()
        );
        log::error!("{report}");
        if let Err(error) = post(server, &report) {
            log::error!("could not send the crash report: {error}");
        }
    }));
}

/// A blocking HTTP POST: the process is about to abort, so no async runtime.
fn post(server: &str, body: &str) -> std::io::Result<()> {
    let host = server.trim_start_matches("http://").trim_end_matches('/');
    let address = host
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::other("no address for the server"))?;
    let mut stream = TcpStream::connect_timeout(&address, TIMEOUT)?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    write!(
        stream,
        "POST /tv-log HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}
