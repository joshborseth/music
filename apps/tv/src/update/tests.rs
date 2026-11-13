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
fn describes_a_build() {
    assert_eq!(
        describe_build("f3a82b03-202611120412"),
        "f3a82b03 (12 Nov 2026)"
    );
    assert_eq!(
        describe_build("f3a82b03-202601310000"),
        "f3a82b03 (31 Jan 2026)"
    );
    assert_eq!(describe_build("dev"), "dev");
    assert_eq!(describe_build("old-1"), "old-1");
    assert_eq!(
        describe_build("f3a82b03-202613120412"),
        "f3a82b03-202613120412"
    );
}

#[test]
fn recognizes_an_apk() {
    assert!(looks_like_apk(b"PK\x03\x04rest"));
    assert!(!looks_like_apk(b"<html>"));
    assert!(!looks_like_apk(b"PK"));
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

    fn install(&self, apk: &Path) -> Result<(), String> {
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

/// Quick retries; the timed check is left to tests that set it.
fn fast() -> Timing {
    Timing {
        permission_recheck: Duration::from_millis(50),
        retry_first: Duration::from_millis(20),
        retry_max: Duration::from_millis(20),
        check_every: Duration::from_secs(60),
    }
}

fn start(
    server: &FakeServer,
    installed: &str,
    android: &Arc<FakeAndroid>,
) -> (Updater, UnboundedReceiver<UpdateStatus>) {
    start_with(server, installed, android, fast())
}

fn start_with(
    server: &FakeServer,
    installed: &str,
    android: &Arc<FakeAndroid>,
    timing: Timing,
) -> (Updater, UnboundedReceiver<UpdateStatus>) {
    let (status, statuses) = unbounded_channel();
    let updater = Updater::spawn_with(
        server.url.clone(),
        installed.into(),
        &tokio::runtime::Handle::current(),
        status,
        android.clone(),
        timing,
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

fn count(server: &FakeServer, request: &str) -> usize {
    server.requests().iter().filter(|r| *r == request).count()
}

fn serve_build(server: &FakeServer, build: &str) {
    *server.version.lock().unwrap() = serde_json::json!({ "build": build }).to_string();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn downloads_then_installs_only_when_asked() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("happy", false);
    let (updater, mut statuses) = start(&server, "old-1", &android);

    let seen = until(&mut statuses, &UpdateStatus::Ready).await;
    assert_eq!(
        seen.first(),
        Some(&UpdateStatus::Downloading { percent: 0 })
    );
    assert!(seen.contains(&UpdateStatus::Downloading { percent: 100 }));
    // Nobody asked: nothing installs.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);

    updater.install_now();
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
    assert_eq!(*android.installs.lock().unwrap(), vec![APK.to_vec()]);
    // Checked again before installing; the download was kept.
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
async fn a_newer_deploy_before_the_press_is_what_installs() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("newer", false);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::Ready).await;
    serve_build(&server, "newer-3");
    updater.install_now();
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
    assert_eq!(count(&server, "GET /tv.apk"), 2);
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 1);
    let cached = android
        .cache
        .join(DOWNLOADS_DIR)
        .join("music-tv-newer-3.apk");
    assert!(is_apk(&cached));
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
async fn a_check_by_hand_reports_itself() {
    let server = FakeServer::start(Some("same-1"), APK);
    let android = FakeAndroid::new("same", false);
    let (updater, mut statuses) = start(&server, "same-1", &android);
    // The check at start stays quiet.
    assert_eq!(
        until(&mut statuses, &UpdateStatus::UpToDate).await,
        [UpdateStatus::UpToDate]
    );
    // One asked for says it is checking, then answers again.
    updater.check_now();
    assert_eq!(
        until(&mut statuses, &UpdateStatus::UpToDate).await,
        [UpdateStatus::Checking, UpdateStatus::UpToDate]
    );
    assert_eq!(server.requests(), ["GET /tv/version", "GET /tv/version"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_later_deploy_is_found_by_the_timed_check_and_waits() {
    let server = FakeServer::start(Some("same-1"), APK);
    let android = FakeAndroid::new("later", false);
    let timing = Timing {
        check_every: Duration::from_millis(100),
        ..fast()
    };
    let (_updater, mut statuses) = start_with(&server, "same-1", &android, timing);
    until(&mut statuses, &UpdateStatus::UpToDate).await;
    serve_build(&server, "new-2");
    until(&mut statuses, &UpdateStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);
    // Later checks find the same download and stay ready.
    assert_eq!(count(&server, "GET /tv.apk"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_press_with_nothing_to_install_is_not_kept() {
    let server = FakeServer::start(Some("same-1"), APK);
    let android = FakeAndroid::new("spent", false);
    let (updater, mut statuses) = start(&server, "same-1", &android);
    until(&mut statuses, &UpdateStatus::UpToDate).await;
    updater.install_now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    serve_build(&server, "new-2");
    updater.check_now();
    until(&mut statuses, &UpdateStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asks_for_permission_before_downloading() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("permission", false);
    android.can_install.store(false, Ordering::SeqCst);
    let (_updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::NeedsPermission).await;
    assert_eq!(count(&server, "GET /tv.apk"), 0);
    // Granted in Settings: the next look goes ahead.
    android.can_install.store(true, Ordering::SeqCst);
    until(&mut statuses, &UpdateStatus::Ready).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_install_waits_for_another_press() {
    let server = FakeServer::start(Some("broken-2"), APK);
    let android = FakeAndroid::new("broken", true);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::Ready).await;
    updater.install_now();
    until(
        &mut statuses,
        &UpdateStatus::Failed("INSTALL_FAILED_INVALID_APK".into()),
    )
    .await;
    // The retry finds the download again and only offers it.
    until(&mut statuses, &UpdateStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(android.install_calls.load(Ordering::SeqCst), 1);
    // The failure reached the server's log, and the announcement was taken
    // back, so the server never reopens (or turns on) a TV whose app never
    // closed.
    assert_eq!(count(&server, "POST /tv-log?level=warning"), 1);
    assert_eq!(count(&server, "POST /tv/updating"), 1);
    assert_eq!(count(&server, "DELETE /tv/updating"), 1);
    // Downloaded once, kept for the next press.
    assert_eq!(count(&server, "GET /tv.apk"), 1);
    updater.install_now();
    installed(&android, 2).await;
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
async fn installs_off_screen_without_asking_to_reopen() {
    let server = FakeServer::start(Some("new-2"), APK);
    let android = FakeAndroid::new("background", false);
    android.foreground.store(false, Ordering::SeqCst);
    let (updater, mut statuses) = start(&server, "old-1", &android);
    until(&mut statuses, &UpdateStatus::Ready).await;
    updater.install_now();
    until(&mut statuses, &UpdateStatus::Installing).await;
    installed(&android, 1).await;
    assert_eq!(count(&server, "POST /tv/updating"), 0);
}
