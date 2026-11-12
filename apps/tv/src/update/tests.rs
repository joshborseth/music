use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::AtomicU32;

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use super::*;

#[test]
fn updates_only_to_another_real_build() {
    assert_eq!(wants_update("a-1", Some("b-2")), Some("b-2".into()));
    assert_eq!(wants_update("a-1", Some(" b-2\n")), Some("b-2".into()));
    assert_eq!(wants_update("a-1", Some("a-1")), None);
    assert_eq!(wants_update("a-1", None), None);
    assert_eq!(wants_update("a-1", Some("  ")), None);
    assert_eq!(wants_update("dev", Some("b-2")), None);
}

#[test]
fn quiet_has_to_hold() {
    let start = Instant::now();
    let quiet_for = Duration::from_secs(30);
    assert_eq!(quiet_remaining(None, start, quiet_for), None);
    assert_eq!(
        quiet_remaining(Some(start), start + Duration::from_secs(10), quiet_for),
        Some(Duration::from_secs(20))
    );
    assert_eq!(
        quiet_remaining(Some(start), start + Duration::from_secs(45), quiet_for),
        Some(Duration::ZERO)
    );
}

#[test]
fn retries_back_off_to_a_limit() {
    let first = Duration::from_secs(60);
    let max = Duration::from_secs(3600);
    let delays: Vec<u64> = (1..=8)
        .map(|failures| retry_delay(failures, first, max).as_secs())
        .collect();
    assert_eq!(delays, [60, 120, 240, 480, 960, 1920, 3600, 3600]);
    assert_eq!(retry_delay(u32::MAX, first, max), max);
}

#[test]
fn reports_download_progress() {
    assert_eq!(percent(0, Some(200)), Some(0));
    assert_eq!(percent(100, Some(200)), Some(50));
    assert_eq!(percent(300, Some(200)), Some(100));
    assert_eq!(percent(100, None), None);
    assert_eq!(percent(100, Some(0)), None);
}

#[test]
fn recognizes_an_apk() {
    assert!(looks_like_apk(b"PK\x03\x04rest"));
    assert!(!looks_like_apk(b"<html>"));
    assert!(!looks_like_apk(b"PK"));
}

#[test]
fn counts_installs_per_build() {
    let mut attempts = Attempts::default();
    for _ in 0..MAX_INSTALL_ATTEMPTS {
        assert!(attempts.may_install("b"));
        attempts.record("b");
    }
    assert!(!attempts.may_install("b"));
    // A new build starts over.
    assert!(attempts.may_install("c"));
    let saved = Attempts::parse(&attempts.to_text());
    assert_eq!(saved, attempts);
    attempts.forgive("b");
    assert!(attempts.may_install("b"));
    assert_eq!(
        Attempts::parse("garbage"),
        Attempts {
            build: "garbage".into(),
            count: 0
        }
    );
}

// THE WHOLE LOOP, against a fake server and a fake Android

const APK: &[u8] = b"PK\x03\x04 a pretend APK, long enough to arrive in more than one piece";

/// Serves `/tv/version`, `/tv.apk`, `/tv/updating`, and `/tv-log`, and
/// records each request as "METHOD /path".
struct FakeServer {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    version: Arc<Mutex<String>>,
}

impl FakeServer {
    fn start(build: Option<&str>, apk: &'static [u8]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let version = Arc::new(Mutex::new(
            serde_json::json!({ "build": build }).to_string(),
        ));
        let served = version.clone();
        let log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request: Vec<&str> = line.split_whitespace().take(2).collect();
                let request = request.join(" ");
                log.lock().unwrap().push(request.clone());
                let version = served.lock().unwrap().clone();
                let (status, content): (&str, &[u8]) = match request.as_str() {
                    "GET /tv/version" => ("200 OK", version.as_bytes()),
                    "GET /tv.apk" => ("200 OK", apk),
                    _ => ("204 No Content", b""),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    content.len()
                );
                let _ = stream.write_all(content);
            }
        });
        Self {
            url,
            requests,
            version,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

struct FakeAndroid {
    cache: PathBuf,
    can_install: AtomicBool,
    foreground: AtomicBool,
    installs: Mutex<Vec<Vec<u8>>>,
    fail_installs: bool,
    install_calls: AtomicU32,
}

impl FakeAndroid {
    fn new(name: &str, fail_installs: bool) -> Arc<Self> {
        let cache = std::env::temp_dir().join(format!(
            "music-tv-update-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&cache);
        Arc::new(Self {
            cache,
            can_install: AtomicBool::new(true),
            foreground: AtomicBool::new(true),
            installs: Mutex::default(),
            fail_installs,
            install_calls: AtomicU32::new(0),
        })
    }
}

impl Drop for FakeAndroid {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.cache);
    }
}

impl Platform for FakeAndroid {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        Ok(self.cache.clone())
    }

    fn can_install(&self) -> Result<bool, String> {
        Ok(self.can_install.load(Ordering::SeqCst))
    }

    fn install(
        &self,
        apk: &Path,
        still_quiet: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), String> {
        assert!(still_quiet(), "installs only while quiet");
        let result = if self.fail_installs {
            Err("INSTALL_FAILED_INVALID_APK".into())
        } else {
            self.installs
                .lock()
                .unwrap()
                .push(std::fs::read(apk).unwrap());
            Ok(())
        };
        // NOTE: counted last, so a test that sees the count sees the install.
        self.install_calls.fetch_add(1, Ordering::SeqCst);
        result
    }

    fn in_foreground(&self) -> Result<bool, String> {
        Ok(self.foreground.load(Ordering::SeqCst))
    }

    fn clean_up(&self) -> Result<(), String> {
        Ok(())
    }

    fn open_permission_settings(&self) -> Result<(), String> {
        Ok(())
    }
}

fn fast() -> Timing {
    Timing {
        check_interval: Duration::from_secs(3600),
        permission_recheck: Duration::from_millis(50),
        retry_first: Duration::from_millis(20),
        retry_max: Duration::from_millis(20),
        quiet_for: Duration::from_millis(200),
    }
}

fn start(
    server: &FakeServer,
    installed: &str,
    android: &Arc<FakeAndroid>,
) -> (Updater, UnboundedReceiver<UpdateStatus>) {
    let (status, statuses) = unbounded_channel();
    let updater = Updater::spawn_with(
        server.url.clone(),
        installed.into(),
        &tokio::runtime::Handle::current(),
        status,
        android.clone(),
        fast(),
    );
    (updater, statuses)
}

/// Statuses until `last` (inclusive), failing after five seconds.
async fn until(
    statuses: &mut UnboundedReceiver<UpdateStatus>,
    last: &UpdateStatus,
) -> Vec<UpdateStatus> {
    let mut seen = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(status) = statuses.recv().await {
            seen.push(status.clone());
            if &status == last {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never reached {last:?}; saw {seen:?}"));
    seen
}

/// Wait (up to five seconds) for the install that follows `Installing`.
async fn installed(android: &FakeAndroid, calls: u32) {
    for _ in 0..500 {
        if android.install_calls.load(Ordering::SeqCst) >= calls {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never installed {calls} time(s)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn downloads_waits_for_quiet_announces_and_installs() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("happy", false);
    let (updater, mut statuses) = start(&server, "old-1", &android);

    let seen = until(&mut statuses, &UpdateStatus::WaitingForQuiet).await;
    assert_eq!(
        seen.first(),
        Some(&UpdateStatus::Downloading { percent: 0 })
    );
    assert!(seen.contains(&UpdateStatus::Downloading { percent: 100 }));
    // Something plays: nothing installs.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);

    let quiet_at = Instant::now();
    updater.set_quiet(true);
    until(&mut statuses, &UpdateStatus::Installing).await;
    assert!(quiet_at.elapsed() >= fast().quiet_for);
    installed(&android, 1).await;
    assert_eq!(*android.installs.lock().unwrap(), vec![APK.to_vec()]);
    assert_eq!(
        server.requests(),
        [
            "GET /tv/version",
            "GET /tv.apk",
            "GET /tv/version",
            "POST /tv/updating"
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newer_deploy_during_the_wait_replaces_the_download() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("newer", false);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::WaitingForQuiet).await;
    *server.version.lock().unwrap() = serde_json::json!({ "build": "newer-3" }).to_string();
    updater.set_quiet(true);
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
    let downloads = server
        .requests()
        .iter()
        .filter(|r| *r == "GET /tv.apk")
        .count();
    assert_eq!(downloads, 2);
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 1);
    let cached = android
        .cache
        .join(DOWNLOADS_DIR)
        .join("music-tv-newer-3.apk");
    assert!(is_apk(&cached));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn music_starting_again_restarts_the_quiet_wait() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("restart", false);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::WaitingForQuiet).await;
    // Quiet for less than `quiet_for`, then music again.
    updater.set_quiet(true);
    tokio::time::sleep(Duration::from_millis(100)).await;
    updater.set_quiet(false);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);
    updater.set_quiet(true);
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stays_put_on_the_same_build_and_on_dev() {
    let server = FakeServer::start(Some("same-1"), APK);
    let android = FakeAndroid::new("same", false);
    let (_updater, mut statuses) = start(&server, "same-1", &android);
    until(&mut statuses, &UpdateStatus::UpToDate).await;
    assert_eq!(server.requests(), ["GET /tv/version"]);

    let dev_server = FakeServer::start(Some("new-2"), APK);
    let (_dev, mut dev_statuses) = start(&dev_server, "dev", &android);
    until(&mut dev_statuses, &UpdateStatus::UpToDate).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(dev_server.requests().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asks_for_permission_before_downloading() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("permission", false);
    android.can_install.store(false, Ordering::SeqCst);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    updater.set_quiet(true);
    until(&mut statuses, &UpdateStatus::NeedsPermission).await;
    assert!(!server.requests().contains(&"GET /tv.apk".to_owned()));
    // Granted in Settings: the next look goes ahead.
    android.can_install.store(true, Ordering::SeqCst);
    until(&mut statuses, &UpdateStatus::Installing).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gives_up_on_a_build_that_never_installs() {
    let server = FakeServer::start(Some("broken-2"), APK);
    let android = FakeAndroid::new("broken", true);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    updater.set_quiet(true);
    let gave_up = UpdateStatus::Failed(format!(
        "Build broken-2 did not install after {MAX_INSTALL_ATTEMPTS} tries"
    ));
    until(&mut statuses, &gave_up).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        android.install_calls.load(Ordering::SeqCst),
        MAX_INSTALL_ATTEMPTS
    );
    // Downloaded once, kept for each try.
    let downloads = server
        .requests()
        .iter()
        .filter(|r| *r == "GET /tv.apk")
        .count();
    assert_eq!(downloads, 1);
    // Each failure reached the server's log once.
    assert!(server.requests().contains(&"POST /tv-log".to_owned()));
    // Each failed install took back its announcement, so the server never
    // reopens (or turns on) a TV whose app never closed.
    let announced = server
        .requests()
        .iter()
        .filter(|r| *r == "POST /tv/updating")
        .count();
    let cancelled = server
        .requests()
        .iter()
        .filter(|r| *r == "DELETE /tv/updating")
        .count();
    assert!(announced > 0);
    assert_eq!(announced, cancelled);
    // A restart remembers the tries.
    let (_again, mut again) = start(&server, "old-1", &android);
    until(&mut again, &gave_up).await;
    assert_eq!(
        android.install_calls.load(Ordering::SeqCst),
        MAX_INSTALL_ATTEMPTS
    );
    // Asking by hand tries once more.
    updater.check_now();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(android.install_calls.load(Ordering::SeqCst) > MAX_INSTALL_ATTEMPTS);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_a_download_that_is_not_an_apk() {
    let server = FakeServer::start(Some("new-2"), b"<html>not found</html>");
    let android = FakeAndroid::new("html", false);
    let (_updater, mut statuses) = start(&server, "old-1", &android);
    until(
        &mut statuses,
        &UpdateStatus::Failed("The server's tv.apk is not an APK".into()),
    )
    .await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installs_in_the_background_without_asking_to_reopen() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("background", false);
    android.foreground.store(false, Ordering::SeqCst);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    updater.set_quiet(true);
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
    assert!(!server.requests().contains(&"POST /tv/updating".to_owned()));
}
