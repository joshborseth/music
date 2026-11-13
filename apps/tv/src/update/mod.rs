//! Updates the TV app itself after a deploy.
//!
//! `scripts/build-tv-apk.sh` compiles a build id into the app ([`BUILD`]) and
//! writes the same id next to the APK, which the server answers at
//! `GET /tv/version`. It asks when the app starts, every [`CHECK_EVERY`],
//! and when someone picks "Check for updates" ([`Updater::check_now`]). A
//! check that fails tries again until it gets an answer. When the two
//! differ, the updater downloads `GET /tv.apk` into the app's cache and
//! reports [`UpdateStatus::Ready`]. It installs only when someone picks
//! "Install update" ([`Updater::install_now`]), so an update never closes
//! the app, or stops the music, by itself. When the app is on screen, it
//! first tells the server (`POST /tv/updating`), which reopens the app
//! afterwards; otherwise it installs without that, and Joshify stays closed.
//!
//! The scheduling lives here and runs on the host in tests. Installing is
//! Android only (`android.rs`); elsewhere it fails. Every failure is logged,
//! shown as [`UpdateStatus::Failed`], and posted to the server's `/tv-log`,
//! since nobody can attach a debugger to the TV.

#[cfg(target_os = "android")]
mod android;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedSender;

use crate::catalog::Version;

/// This build's id, compiled in by `scripts/build-tv-apk.sh`. `"dev"` builds
/// never update.
pub const BUILD: &str = match option_env!("MUSIC_TV_BUILD") {
    Some(build) => build,
    None => "dev",
};
pub const DEV_BUILD: &str = "dev";

/// How often to look for a new build while the app runs.
pub const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// How often to look again while "Install unknown apps" is off.
const PERMISSION_RECHECK: Duration = Duration::from_secs(30);
/// The first retry after a failure; each further one waits twice as long.
const RETRY_FIRST: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateStatus {
    UpToDate,
    /// Someone asked for a check ([`Updater::check_now`]) and it is running.
    /// Checks on the timer don't report this, so the top bar stays quiet.
    Checking,
    Downloading {
        percent: u8,
    },
    /// Downloaded; installs when someone asks ([`Updater::install_now`]).
    Ready,
    Installing,
    /// "Install unknown apps" is off for Joshify. Show a button that calls
    /// [`Updater::open_permission_settings`].
    NeedsPermission,
    Failed(String),
}

/// What the updater needs from the device. Android's lives in `android.rs`;
/// tests use a fake.
pub(crate) trait Platform: Send + Sync + 'static {
    /// Where downloads go: the app's cache directory.
    fn cache_dir(&self) -> Result<PathBuf, String>;
    /// Whether Joshify may install apps ("Install unknown apps").
    fn can_install(&self) -> Result<bool, String>;
    /// Install the APK. Blocks; runs on its own thread. Returns `Ok` when the
    /// install is under way and Android did not end this process (it does
    /// when it replaces the app).
    fn install(&self, apk: &Path) -> Result<(), String>;
    /// Whether this app is on screen, with the screen on. Only then does the
    /// server reopen it after the update: otherwise reopening would turn on
    /// a TV in standby, or pull someone out of another app.
    fn in_foreground(&self) -> Result<bool, String>;
    /// Remove what earlier installs left outside the cache.
    fn clean_up(&self) -> Result<(), String>;
    fn open_permission_settings(&self) -> Result<(), String>;
}

/// The update to work toward, given this build and the server's.
pub(crate) fn wants_update(installed: &str, offered: Option<&str>) -> Option<String> {
    let offered = offered.map(str::trim).filter(|build| !build.is_empty())?;
    (installed != DEV_BUILD && offered != installed).then(|| offered.to_owned())
}

/// The wait before retrying after `failures` failures in a row.
pub(crate) fn retry_delay(failures: u32, first: Duration, max: Duration) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    first.saturating_mul(1 << doublings).min(max)
}

pub(crate) fn percent(done: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((done.min(total) * 100 / total) as u8)
}

/// A build id for people: `f3a82b03-202611120412` (commit, then UTC build
/// time, from `scripts/build-tv-apk.sh`) reads as `f3a82b03 (12 Nov 2026)`.
/// Anything else shows as it is.
pub fn describe_build(build: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let dated = build.rsplit_once('-').and_then(|(commit, time)| {
        if time.len() != 12 || !time.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let month: usize = time[4..6].parse().ok()?;
        let day: u32 = time[6..8].parse().ok()?;
        let month = MONTHS.get(month.checked_sub(1)?)?;
        Some(format!("{commit} ({day} {month} {})", &time[..4]))
    });
    dated.unwrap_or_else(|| build.to_owned())
}

/// Every APK is a zip file.
pub(crate) fn looks_like_apk(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04")
}

/// A build id as a file name.
fn file_stem(build: &str) -> String {
    build
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Timing {
    pub permission_recheck: Duration,
    pub retry_first: Duration,
    pub retry_max: Duration,
    pub check_every: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            permission_recheck: PERMISSION_RECHECK,
            retry_first: RETRY_FIRST,
            retry_max: RETRY_MAX,
            check_every: CHECK_EVERY,
        }
    }
}

struct Shared {
    check: Notify,
    /// Set by [`Updater::check_now`]: report the check.
    forced: AtomicBool,
    /// Set by [`Updater::install_now`]: install what the check finds.
    install: AtomicBool,
    platform: Arc<dyn Platform>,
    reporter: Reporter,
}

/// Keeps the app up to date with the server's build. Cheap to clone.
#[derive(Clone)]
pub struct Updater {
    shared: Arc<Shared>,
}

impl Updater {
    pub fn spawn(
        server: String,
        runtime: &tokio::runtime::Handle,
        status: UnboundedSender<UpdateStatus>,
    ) -> Self {
        Self::spawn_with(
            server,
            BUILD.to_owned(),
            runtime,
            status,
            default_platform(),
            Timing::default(),
        )
    }

    pub(crate) fn spawn_with(
        server: String,
        installed: String,
        runtime: &tokio::runtime::Handle,
        status: UnboundedSender<UpdateStatus>,
        platform: Arc<dyn Platform>,
        timing: Timing,
    ) -> Self {
        let server = server.trim_end_matches('/').to_owned();
        let client = reqwest::Client::new();
        let reporter = Reporter {
            server: server.clone(),
            client: client.clone(),
            runtime: runtime.clone(),
            status,
            last: Arc::default(),
        };
        let shared = Arc::new(Shared {
            check: Notify::new(),
            forced: AtomicBool::new(false),
            install: AtomicBool::new(false),
            platform: platform.clone(),
            reporter: reporter.clone(),
        });
        let worker = Worker {
            server,
            installed,
            client,
            platform,
            reporter,
            shared: shared.clone(),
            timing,
            cleaned_up: false,
        };
        runtime.spawn(worker.run());
        Self { shared }
    }

    /// Opens Android's "Install unknown apps" page for this app (shown with
    /// [`UpdateStatus::NeedsPermission`]). No-op off Android.
    pub fn open_permission_settings(&self) {
        let shared = self.shared.clone();
        // NOTE: callers are on the UI thread; JNI work never runs there.
        let spawned = std::thread::Builder::new()
            .name("music-update-settings".into())
            .spawn(move || {
                if let Err(error) = shared.platform.open_permission_settings() {
                    shared
                        .reporter
                        .fail(format!("Could not open the settings: {error}"));
                }
            });
        if let Err(error) = spawned {
            log::error!("could not start a thread for the settings: {error}");
        }
    }

    /// Check now, and say so ([`UpdateStatus::Checking`]).
    pub fn check_now(&self) {
        self.shared.forced.store(true, Ordering::SeqCst);
        self.shared.check.notify_one();
    }

    /// Install the newest build: "Install update", once an update is
    /// [`UpdateStatus::Ready`]. Checks first, so a newer deploy wins.
    pub fn install_now(&self) {
        self.shared.install.store(true, Ordering::SeqCst);
        self.shared.check.notify_one();
    }
}

#[cfg(target_os = "android")]
fn default_platform() -> Arc<dyn Platform> {
    Arc::new(android::Android)
}

#[cfg(not(target_os = "android"))]
fn default_platform() -> Arc<dyn Platform> {
    Arc::new(Host)
}

/// Off Android there is nothing to install into.
#[cfg(not(target_os = "android"))]
struct Host;

#[cfg(not(target_os = "android"))]
impl Platform for Host {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        Ok(std::env::temp_dir().join("music-tv"))
    }

    fn can_install(&self) -> Result<bool, String> {
        Ok(true)
    }

    fn install(&self, _: &Path) -> Result<(), String> {
        Err("updates only install on Android".into())
    }

    fn in_foreground(&self) -> Result<bool, String> {
        Ok(false)
    }

    fn clean_up(&self) -> Result<(), String> {
        Ok(())
    }

    fn open_permission_settings(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Sends status changes, and posts failures to the server's log.
#[derive(Clone)]
struct Reporter {
    server: String,
    client: reqwest::Client,
    runtime: tokio::runtime::Handle,
    status: UnboundedSender<UpdateStatus>,
    last: Arc<Mutex<Option<UpdateStatus>>>,
}

impl Reporter {
    fn set(&self, status: UpdateStatus) {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.as_ref() != Some(&status) {
            *last = Some(status.clone());
            let _ = self.status.send(status);
        }
    }

    fn fail(&self, message: String) {
        log::warn!("update: {message}");
        let repeated = self
            .last
            .lock()
            .is_ok_and(|last| last.as_ref() == Some(&UpdateStatus::Failed(message.clone())));
        if !repeated {
            let request = self
                .client
                .post(crate::server_log::url(&self.server, log::Level::Warn))
                .header("content-type", "text/plain; charset=utf-8")
                .body(format!("update (build {BUILD}): {message}"))
                .timeout(Duration::from_secs(10));
            self.runtime.spawn(async move {
                if let Err(error) = request.send().await {
                    log::warn!("could not send the update failure to the server: {error}");
                }
            });
        }
        self.set(UpdateStatus::Failed(message));
    }
}

/// When to look again after one check.
enum Next {
    /// After [`CHECK_EVERY`], or when someone asks.
    Later,
    /// Soon: waiting for "Install unknown apps".
    Soon,
}

struct Worker {
    server: String,
    installed: String,
    client: reqwest::Client,
    platform: Arc<dyn Platform>,
    reporter: Reporter,
    shared: Arc<Shared>,
    timing: Timing,
    cleaned_up: bool,
}

impl Worker {
    async fn run(mut self) {
        if self.installed == DEV_BUILD {
            log::info!("update: a dev build never updates");
            self.reporter.set(UpdateStatus::UpToDate);
            return;
        }
        let mut failures = 0;
        loop {
            let delay = match self.check().await {
                Ok(next) => {
                    failures = 0;
                    match next {
                        Next::Later => self.timing.check_every,
                        Next::Soon => self.timing.permission_recheck,
                    }
                }
                Err(error) => {
                    failures += 1;
                    self.reporter.fail(error);
                    retry_delay(failures, self.timing.retry_first, self.timing.retry_max)
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.shared.check.notified() => {}
            }
        }
    }

    async fn check(&mut self) -> Result<Next, String> {
        let asked = self.shared.forced.swap(false, Ordering::SeqCst);
        // NOTE: taken now, so a press that finds nothing to install is spent
        // and never installs a later build by itself.
        let install = self.shared.install.swap(false, Ordering::SeqCst);
        if asked {
            self.reporter.set(UpdateStatus::Checking);
        }
        let offered = self.fetch_version().await?;
        let Some(build) = wants_update(&self.installed, offered.as_deref()) else {
            self.reporter.set(UpdateStatus::UpToDate);
            if !self.cleaned_up {
                self.cleaned_up = true;
                self.clean_up().await;
            }
            return Ok(Next::Later);
        };
        let platform = self.platform.clone();
        if !on_own_thread(move || platform.can_install()).await? {
            self.reporter.set(UpdateStatus::NeedsPermission);
            return Ok(Next::Soon);
        }
        let cache = self.cache_dir().await?;
        let apk = self.download(&cache, &build).await?;
        if !install {
            self.reporter.set(UpdateStatus::Ready);
            return Ok(Next::Later);
        }
        let platform = self.platform.clone();
        let announced = match on_own_thread(move || platform.in_foreground()).await {
            Ok(true) => self.announce().await,
            Ok(false) => {
                log::info!("update: installing in the background; Joshify stays closed after");
                false
            }
            Err(error) => {
                log::warn!("update: could not tell whether Joshify is on screen: {error}");
                false
            }
        };
        self.reporter.set(UpdateStatus::Installing);
        log::info!("update: installing build {build}");
        let platform = self.platform.clone();
        let installed = on_own_thread(move || platform.install(&apk)).await;
        if installed.is_err() && announced {
            // The app stays up, so the server must not reopen it later.
            self.cancel_announce().await;
        }
        installed?;
        // Still running: Android is showing its installer, or will finish
        // the session later. The next check looks again.
        log::info!("update: the install of build {build} is under way");
        Ok(Next::Later)
    }

    async fn fetch_version(&self) -> Result<Option<String>, String> {
        let response = self
            .client
            .get(format!("{}/tv/version", self.server))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("Could not ask the server for updates: {error}"))?;
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("Could not read the server's version: {error}"))?;
        let version: Version = serde_json::from_slice(&body)
            .map_err(|error| format!("The server's version made no sense: {error}"))?;
        Ok(version.build)
    }

    async fn cache_dir(&self) -> Result<PathBuf, String> {
        let platform = self.platform.clone();
        on_own_thread(move || platform.cache_dir())
            .await
            .map_err(|error| format!("Could not find the cache directory: {error}"))
    }

    async fn clean_up(&self) {
        if let Ok(cache) = self.cache_dir().await {
            let _ = std::fs::remove_dir_all(cache.join(DOWNLOADS_DIR));
            // Left by builds that retried installs by themselves.
            let _ = std::fs::remove_file(cache.join("update-attempts"));
        }
        let platform = self.platform.clone();
        if let Err(error) = on_own_thread(move || platform.clean_up()).await {
            log::warn!("update: could not clean up after the last update: {error}");
        }
    }

    /// Download `build` into the cache, unless it is already there.
    async fn download(&self, cache: &Path, build: &str) -> Result<PathBuf, String> {
        let dir = cache.join(DOWNLOADS_DIR);
        let apk = dir.join(format!("music-tv-{}.apk", file_stem(build)));
        if is_apk(&apk) {
            return Ok(apk);
        }
        // Only one download is ever kept.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not make room for the update: {error}"))?;
        self.reporter.set(UpdateStatus::Downloading { percent: 0 });
        let partial = apk.with_extension("partial");
        let result = self.fetch_apk(&partial).await;
        if let Err(error) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        std::fs::rename(&partial, &apk)
            .map_err(|error| format!("Could not keep the downloaded update: {error}"))?;
        Ok(apk)
    }

    async fn fetch_apk(&self, path: &Path) -> Result<(), String> {
        let failed = |error: reqwest::Error| format!("Could not download the update: {error}");
        let mut response = self
            .client
            .get(format!("{}/tv.apk", self.server))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(failed)?;
        let total = response.content_length();
        let mut file = std::fs::File::create(path)
            .map_err(|error| format!("Could not save the update: {error}"))?;
        let mut done = 0u64;
        let mut head = Vec::with_capacity(4);
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            if head.len() < 4 {
                head.extend(chunk.iter().take(4 - head.len()));
            }
            file.write_all(&chunk)
                .map_err(|error| format!("Could not save the update: {error}"))?;
            done += chunk.len() as u64;
            if let Some(percent) = percent(done, total) {
                self.reporter.set(UpdateStatus::Downloading { percent });
            }
        }
        file.sync_all()
            .map_err(|error| format!("Could not save the update: {error}"))?;
        if total.is_some_and(|total| total != done) {
            return Err(format!(
                "The update download stopped early ({done} of {} bytes)",
                total.unwrap_or_default()
            ));
        }
        if !looks_like_apk(&head) {
            return Err("The server's tv.apk is not an APK".into());
        }
        Ok(())
    }

    /// Tell the server, so it reopens the app once the update has replaced
    /// it. Returns whether the server heard.
    async fn announce(&self) -> bool {
        let sent = self
            .client
            .post(format!("{}/tv/updating", self.server))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        if let Err(error) = &sent {
            // NOTE: install anyway; the app just stays closed afterwards.
            log::warn!("update: could not tell the server about the update: {error}");
        }
        sent.is_ok()
    }

    /// The install did not happen: the server should not reopen the app.
    async fn cancel_announce(&self) {
        let sent = self
            .client
            .delete(format!("{}/tv/updating", self.server))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        if let Err(error) = sent {
            log::warn!("update: could not cancel the server's reopen: {error}");
        }
    }
}

const DOWNLOADS_DIR: &str = "updates";

fn is_apk(path: &Path) -> bool {
    let mut head = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut head))
        .is_ok_and(|()| looks_like_apk(&head))
}

/// Run blocking (JNI) work on a thread of its own, never the UI thread or
/// the async runtime's.
async fn on_own_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (done, result) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("music-update".into())
        .spawn(move || {
            let _ = done.send(work());
        })
        .map_err(|error| format!("could not start a thread: {error}"))?;
    result
        .await
        .unwrap_or_else(|_| Err("the update thread stopped".into()))
}

#[cfg(test)]
mod tests;
