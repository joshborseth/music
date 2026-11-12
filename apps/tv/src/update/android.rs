//! Installs updates through Android's own installer, over JNI (no Java in
//! this app).
//!
//! Android 12+ (API 31): a `PackageInstaller` session with
//! `setRequireUserAction(USER_ACTION_NOT_REQUIRED)`. AOSP's
//! `PackageInstallerSession` (`computeUserActionRequirement` and
//! `checkUserActionRequirement`) installs that without a prompt when all of
//! these hold:
//!
//! - the installer holds `UPDATE_PACKAGES_WITHOUT_USER_ACTION` (a normal
//!   permission, granted at install from the manifest);
//! - it may install at all: `REQUEST_INSTALL_PACKAGES`, with "Install
//!   unknown apps" allowed for it (`canRequestPackageInstalls()`);
//! - the package is already installed and the installer is its installer of
//!   record, or it is updating itself (`targetPackageUid == installerUid`),
//!   which is our case: Downloader or Send Files installed the first copy;
//! - the new APK targets a recent enough API (29 on Android 12, rising
//!   with each release; this app targets 35);
//! - no other installer owns updates of the package (Android 14's update
//!   ownership), and the same package isn't updated silently more than once
//!   in about 30 seconds (`SilentUpdatePolicy`).
//!
//! Then the system replaces the app and ends this process. Its status goes to
//! a broadcast nobody receives (there is no Java to receive it), which is
//! fine: success ends the process, and anything else shows up below.
//!
//! When the session still exists [`SESSION_GRACE`] after the commit, Android
//! wanted a confirmation we can't show, so it is abandoned. That, or an
//! Android older than 12, falls back to Android's Install prompt: the APK is
//! copied into `MediaStore.Downloads` (API 29+), whose `content://` URI the
//! system installer can read without a FileProvider, and opened with
//! `ACTION_VIEW`.
//!
//! Every JNI call's pending Java exception is caught, cleared, logged, and
//! returned as an `Err`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use jni::objects::{JObject, JString, JValue};
use jni::{Env, jni_sig, jni_str};

use super::Platform;
use crate::android_jni::{Failure, Java, sdk_int, take_exception, with_context};

/// How long a committed session may take to replace the app before we
/// assume it is waiting for a confirmation.
const SESSION_GRACE: Duration = Duration::from_secs(45);
const APK_MIME: &str = "application/vnd.android.package-archive";
/// What the session's status broadcast is called. Nothing receives it.
const STATUS_ACTION: &str = "app.music.tv.INSTALL_STATUS";
/// MediaStore entries this app made start with this.
const DOWNLOAD_PREFIX: &str = "music-tv-";
const WRITE_CHUNK: usize = 256 * 1024;

// android.content.pm.PackageInstaller.SessionParams
const MODE_FULL_INSTALL: i32 = 1;
const USER_ACTION_NOT_REQUIRED: i32 = 2;
// android.app.PendingIntent
const FLAG_MUTABLE: i32 = 0x0200_0000;
const FLAG_UPDATE_CURRENT: i32 = 0x0800_0000;
// android.app.ActivityManager.RunningAppProcessInfo
const IMPORTANCE_FOREGROUND: i32 = 100;
// android.content.Intent
const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

pub struct Android;

impl Platform for Android {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        with_context("getCacheDir", |env, context| {
            let dir = env
                .call_method(
                    context,
                    jni_str!("getCacheDir"),
                    jni_sig!("()Ljava/io/File;"),
                    &[],
                )?
                .l()?;
            let path = env
                .call_method(
                    &dir,
                    jni_str!("getAbsolutePath"),
                    jni_sig!("()Ljava/lang/String;"),
                    &[],
                )?
                .l()?;
            Ok(PathBuf::from(rust_string(env, path)?))
        })
    }

    fn can_install(&self) -> Result<bool, String> {
        with_context("canRequestPackageInstalls", |env, context| {
            let manager = package_manager(env, context)?;
            Ok(env
                .call_method(
                    &manager,
                    jni_str!("canRequestPackageInstalls"),
                    jni_sig!("()Z"),
                    &[],
                )?
                .z()?)
        })
    }

    fn install(
        &self,
        apk: &Path,
        still_quiet: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), String> {
        let sdk = sdk_int()?;
        log::info!("update: installing on API {sdk}");
        if sdk >= 31 {
            if !still_quiet() {
                return Err("Music started playing, so the update waits".into());
            }
            let session = with_context("the install session", |env, context| {
                commit_session(env, context, apk)
            })?;
            log::info!("update: committed install session {session}; waiting for Android");
            // NOTE: on success Android ends this process during this sleep.
            std::thread::sleep(SESSION_GRACE);
            let waiting = with_context("checking the install session", |env, context| {
                abandon_if_waiting(env, context, session)
            })?;
            if !waiting {
                return Err(
                    "Android did not install the update (the install session failed)".into(),
                );
            }
            log::warn!("update: Android wants a confirmation; showing its installer instead");
        }
        if sdk < 29 {
            return Err(format!(
                "This TV (API {sdk}) can't update by itself. Install /tv.apk by hand."
            ));
        }
        if !still_quiet() {
            return Err("Music started playing, so the update waits".into());
        }
        with_context("opening Android's installer", |env, context| {
            show_install_prompt(env, context, apk)
        })
    }

    fn in_foreground(&self) -> Result<bool, String> {
        with_context("checking whether Joshify is on screen", |env, context| {
            let info = env.new_object(
                jni_str!("android/app/ActivityManager$RunningAppProcessInfo"),
                jni_sig!("()V"),
                &[],
            )?;
            env.call_static_method(
                jni_str!("android/app/ActivityManager"),
                jni_str!("getMyMemoryState"),
                jni_sig!("(Landroid/app/ActivityManager$RunningAppProcessInfo;)V"),
                &[JValue::Object(&info)],
            )?;
            let importance = env
                .get_field(&info, jni_str!("importance"), jni_sig!("I"))?
                .i()?;
            let service = env.new_string("power")?;
            let power = env
                .call_method(
                    context,
                    jni_str!("getSystemService"),
                    jni_sig!("(Ljava/lang/String;)Ljava/lang/Object;"),
                    &[JValue::Object(&service)],
                )?
                .l()?;
            if power.is_null() {
                return Err(Failure::Message("no PowerManager".into()));
            }
            let screen_on = env
                .call_method(&power, jni_str!("isInteractive"), jni_sig!("()Z"), &[])?
                .z()?;
            Ok(importance <= IMPORTANCE_FOREGROUND && screen_on)
        })
    }

    fn clean_up(&self) -> Result<(), String> {
        if sdk_int()? < 29 {
            return Ok(());
        }
        with_context("removing old downloads", |env, context| {
            let resolver = content_resolver(env, context)?;
            delete_our_downloads(env, &resolver)
        })
    }

    fn open_permission_settings(&self) -> Result<(), String> {
        with_context("opening the settings", |env, context| {
            let package = package_name(env, context)?;
            let package = rust_string(env, package)?;
            let uri = parse_uri(env, &format!("package:{package}"))?;
            let action = env.new_string("android.settings.MANAGE_UNKNOWN_APP_SOURCES")?;
            let intent = env.new_object(
                jni_str!("android/content/Intent"),
                jni_sig!("(Ljava/lang/String;Landroid/net/Uri;)V"),
                &[JValue::Object(&action), JValue::Object(&uri)],
            )?;
            add_flags(env, &intent, FLAG_ACTIVITY_NEW_TASK)?;
            start_activity(env, context, &intent)
        })
    }
}

// SMALL CALLS

fn rust_string<'j>(env: &mut Env<'j>, object: JObject<'j>) -> Java<String> {
    if object.is_null() {
        return Err(Failure::Message("Java returned null".into()));
    }
    let string = env.cast_local::<JString>(object)?;
    Ok(string.try_to_string(env)?)
}

fn package_name<'j>(env: &mut Env<'j>, context: &JObject<'j>) -> Java<JObject<'j>> {
    Ok(env
        .call_method(
            context,
            jni_str!("getPackageName"),
            jni_sig!("()Ljava/lang/String;"),
            &[],
        )?
        .l()?)
}

fn package_manager<'j>(env: &mut Env<'j>, context: &JObject<'j>) -> Java<JObject<'j>> {
    Ok(env
        .call_method(
            context,
            jni_str!("getPackageManager"),
            jni_sig!("()Landroid/content/pm/PackageManager;"),
            &[],
        )?
        .l()?)
}

fn content_resolver<'j>(env: &mut Env<'j>, context: &JObject<'j>) -> Java<JObject<'j>> {
    Ok(env
        .call_method(
            context,
            jni_str!("getContentResolver"),
            jni_sig!("()Landroid/content/ContentResolver;"),
            &[],
        )?
        .l()?)
}

fn parse_uri<'j>(env: &mut Env<'j>, text: &str) -> Java<JObject<'j>> {
    let text = env.new_string(text)?;
    Ok(env
        .call_static_method(
            jni_str!("android/net/Uri"),
            jni_str!("parse"),
            jni_sig!("(Ljava/lang/String;)Landroid/net/Uri;"),
            &[JValue::Object(&text)],
        )?
        .l()?)
}

fn add_flags<'j>(env: &mut Env<'j>, intent: &JObject<'j>, flags: i32) -> Java<()> {
    env.call_method(
        intent,
        jni_str!("addFlags"),
        jni_sig!("(I)Landroid/content/Intent;"),
        &[JValue::Int(flags)],
    )?;
    Ok(())
}

fn start_activity<'j>(env: &mut Env<'j>, context: &JObject<'j>, intent: &JObject<'j>) -> Java<()> {
    env.call_method(
        context,
        jni_str!("startActivity"),
        jni_sig!("(Landroid/content/Intent;)V"),
        &[JValue::Object(intent)],
    )?;
    Ok(())
}

fn close<'j>(env: &mut Env<'j>, closeable: &JObject<'j>) -> Java<()> {
    env.call_method(closeable, jni_str!("close"), jni_sig!("()V"), &[])?;
    Ok(())
}

/// Copy the file at `path` into a `java.io.OutputStream`.
fn write_file<'j>(env: &mut Env<'j>, out: &JObject<'j>, path: &Path) -> Java<()> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| Failure::Message(format!("could not read the APK: {error}")))?;
    let mut buffer = vec![0u8; WRITE_CHUNK];
    let array = env.new_byte_array(WRITE_CHUNK)?;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| Failure::Message(format!("could not read the APK: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        // SAFETY: u8 and i8 (jbyte) have the same size and alignment.
        let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<i8>(), read) };
        array.set_region(env, 0, bytes)?;
        env.call_method(
            out,
            jni_str!("write"),
            jni_sig!("([BII)V"),
            &[
                JValue::Object(&array),
                JValue::Int(0),
                JValue::Int(read as i32),
            ],
        )?;
    }
}

fn apk_length(apk: &Path) -> Java<i64> {
    std::fs::metadata(apk)
        .map(|metadata| metadata.len() as i64)
        .map_err(|error| Failure::Message(format!("could not read the APK: {error}")))
}

// ANDROID 12+: A PACKAGEINSTALLER SESSION

/// Write the APK into a new session and commit it. Returns the session id.
fn commit_session<'j>(env: &mut Env<'j>, context: &JObject<'j>, apk: &Path) -> Java<i32> {
    let length = apk_length(apk)?;
    let manager = package_manager(env, context)?;
    let installer = env
        .call_method(
            &manager,
            jni_str!("getPackageInstaller"),
            jni_sig!("()Landroid/content/pm/PackageInstaller;"),
            &[],
        )?
        .l()?;
    let package = package_name(env, context)?;
    let params = env.new_object(
        jni_str!("android/content/pm/PackageInstaller$SessionParams"),
        jni_sig!("(I)V"),
        &[JValue::Int(MODE_FULL_INSTALL)],
    )?;
    env.call_method(
        &params,
        jni_str!("setAppPackageName"),
        jni_sig!("(Ljava/lang/String;)V"),
        &[JValue::Object(&package)],
    )?;
    env.call_method(
        &params,
        jni_str!("setRequireUserAction"),
        jni_sig!("(I)V"),
        &[JValue::Int(USER_ACTION_NOT_REQUIRED)],
    )?;
    env.call_method(
        &params,
        jni_str!("setSize"),
        jni_sig!("(J)V"),
        &[JValue::Long(length)],
    )?;
    let id = env
        .call_method(
            &installer,
            jni_str!("createSession"),
            jni_sig!("(Landroid/content/pm/PackageInstaller$SessionParams;)I"),
            &[JValue::Object(&params)],
        )?
        .i()?;
    let session = env
        .call_method(
            &installer,
            jni_str!("openSession"),
            jni_sig!("(I)Landroid/content/pm/PackageInstaller$Session;"),
            &[JValue::Int(id)],
        )?
        .l()?;
    let written = write_and_commit(env, context, &session, &package, apk, length);
    if let Err(error) = written {
        // Leave no half-written session behind.
        let message = take_exception(env, error);
        let _ = env.call_method(&session, jni_str!("abandon"), jni_sig!("()V"), &[]);
        let _ = take_exception(env, Failure::Message(String::new()));
        return Err(Failure::Message(message));
    }
    Ok(id)
}

fn write_and_commit<'j>(
    env: &mut Env<'j>,
    context: &JObject<'j>,
    session: &JObject<'j>,
    package: &JObject<'j>,
    apk: &Path,
    length: i64,
) -> Java<()> {
    let name = env.new_string("music-tv.apk")?;
    let out = env
        .call_method(
            session,
            jni_str!("openWrite"),
            jni_sig!("(Ljava/lang/String;JJ)Ljava/io/OutputStream;"),
            &[JValue::Object(&name), JValue::Long(0), JValue::Long(length)],
        )?
        .l()?;
    write_file(env, &out, apk)?;
    env.call_method(
        session,
        jni_str!("fsync"),
        jni_sig!("(Ljava/io/OutputStream;)V"),
        &[JValue::Object(&out)],
    )?;
    close(env, &out)?;

    let action = env.new_string(STATUS_ACTION)?;
    let intent = env.new_object(
        jni_str!("android/content/Intent"),
        jni_sig!("(Ljava/lang/String;)V"),
        &[JValue::Object(&action)],
    )?;
    env.call_method(
        &intent,
        jni_str!("setPackage"),
        jni_sig!("(Ljava/lang/String;)Landroid/content/Intent;"),
        &[JValue::Object(package)],
    )?;
    // NOTE: mutable, so the installer can add its status; explicit (setPackage),
    // which Android 14 requires of a mutable PendingIntent.
    let pending = env
        .call_static_method(
            jni_str!("android/app/PendingIntent"),
            jni_str!("getBroadcast"),
            jni_sig!(
                "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;"
            ),
            &[
                JValue::Object(context),
                JValue::Int(0),
                JValue::Object(&intent),
                JValue::Int(FLAG_MUTABLE | FLAG_UPDATE_CURRENT),
            ],
        )?
        .l()?;
    let sender = env
        .call_method(
            &pending,
            jni_str!("getIntentSender"),
            jni_sig!("()Landroid/content/IntentSender;"),
            &[],
        )?
        .l()?;
    env.call_method(
        session,
        jni_str!("commit"),
        jni_sig!("(Landroid/content/IntentSender;)V"),
        &[JValue::Object(&sender)],
    )?;
    close(env, session)
}

/// A session that still exists after the commit waits for a confirmation:
/// abandon it and say so. A failed one is already gone.
fn abandon_if_waiting<'j>(env: &mut Env<'j>, context: &JObject<'j>, id: i32) -> Java<bool> {
    let manager = package_manager(env, context)?;
    let installer = env
        .call_method(
            &manager,
            jni_str!("getPackageInstaller"),
            jni_sig!("()Landroid/content/pm/PackageInstaller;"),
            &[],
        )?
        .l()?;
    let info = env
        .call_method(
            &installer,
            jni_str!("getSessionInfo"),
            jni_sig!("(I)Landroid/content/pm/PackageInstaller$SessionInfo;"),
            &[JValue::Int(id)],
        )?
        .l()?;
    if info.is_null() {
        return Ok(false);
    }
    env.call_method(
        &installer,
        jni_str!("abandonSession"),
        jni_sig!("(I)V"),
        &[JValue::Int(id)],
    )?;
    Ok(true)
}

// THE INSTALL PROMPT (ANDROID 10+)

fn downloads_uri<'j>(env: &mut Env<'j>) -> Java<JObject<'j>> {
    Ok(env
        .get_static_field(
            jni_str!("android/provider/MediaStore$Downloads"),
            jni_str!("EXTERNAL_CONTENT_URI"),
            jni_sig!("Landroid/net/Uri;"),
        )?
        .l()?)
}

/// Delete the downloads this app made for earlier updates. Scoped storage
/// shows an app only its own entries, so nothing else matches.
fn delete_our_downloads<'j>(env: &mut Env<'j>, resolver: &JObject<'j>) -> Java<()> {
    let collection = downloads_uri(env)?;
    let selection = env.new_string("_display_name LIKE ?")?;
    let pattern = env.new_string(format!("{DOWNLOAD_PREFIX}%"))?;
    let arguments = env.new_object_array(1, jni_str!("java/lang/String"), &pattern)?;
    let deleted = env
        .call_method(
            resolver,
            jni_str!("delete"),
            jni_sig!("(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I"),
            &[
                JValue::Object(&collection),
                JValue::Object(&selection),
                JValue::Object(&arguments),
            ],
        )?
        .i()?;
    if deleted > 0 {
        log::info!("update: removed {deleted} old update download(s)");
    }
    Ok(())
}

fn put_string<'j>(env: &mut Env<'j>, values: &JObject<'j>, key: &str, value: &str) -> Java<()> {
    let key = env.new_string(key)?;
    let value = env.new_string(value)?;
    env.call_method(
        values,
        jni_str!("put"),
        jni_sig!("(Ljava/lang/String;Ljava/lang/String;)V"),
        &[JValue::Object(&key), JValue::Object(&value)],
    )?;
    Ok(())
}

fn put_int<'j>(env: &mut Env<'j>, values: &JObject<'j>, key: &str, value: i32) -> Java<()> {
    let key = env.new_string(key)?;
    let boxed = env
        .call_static_method(
            jni_str!("java/lang/Integer"),
            jni_str!("valueOf"),
            jni_sig!("(I)Ljava/lang/Integer;"),
            &[JValue::Int(value)],
        )?
        .l()?;
    env.call_method(
        values,
        jni_str!("put"),
        jni_sig!("(Ljava/lang/String;Ljava/lang/Integer;)V"),
        &[JValue::Object(&key), JValue::Object(&boxed)],
    )?;
    Ok(())
}

fn content_values<'j>(env: &mut Env<'j>) -> Java<JObject<'j>> {
    Ok(env.new_object(
        jni_str!("android/content/ContentValues"),
        jni_sig!("()V"),
        &[],
    )?)
}

/// Copy the APK into Downloads and open it with Android's installer.
fn show_install_prompt<'j>(env: &mut Env<'j>, context: &JObject<'j>, apk: &Path) -> Java<()> {
    let resolver = content_resolver(env, context)?;
    delete_our_downloads(env, &resolver)?;
    let collection = downloads_uri(env)?;
    let values = content_values(env)?;
    let name = apk
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with(DOWNLOAD_PREFIX))
        .unwrap_or("music-tv-update.apk");
    put_string(env, &values, "_display_name", name)?;
    put_string(env, &values, "mime_type", APK_MIME)?;
    put_int(env, &values, "is_pending", 1)?;
    let uri = env
        .call_method(
            &resolver,
            jni_str!("insert"),
            jni_sig!("(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;"),
            &[JValue::Object(&collection), JValue::Object(&values)],
        )?
        .l()?;
    if uri.is_null() {
        return Err(Failure::Message("Downloads refused the APK".into()));
    }
    let copied = copy_and_open(env, context, &resolver, &uri, apk);
    if let Err(error) = copied {
        let message = take_exception(env, error);
        let _ = env.call_method(
            &resolver,
            jni_str!("delete"),
            jni_sig!("(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I"),
            &[
                JValue::Object(&uri),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
            ],
        );
        let _ = take_exception(env, Failure::Message(String::new()));
        return Err(Failure::Message(message));
    }
    Ok(())
}

fn copy_and_open<'j>(
    env: &mut Env<'j>,
    context: &JObject<'j>,
    resolver: &JObject<'j>,
    uri: &JObject<'j>,
    apk: &Path,
) -> Java<()> {
    let out = env
        .call_method(
            resolver,
            jni_str!("openOutputStream"),
            jni_sig!("(Landroid/net/Uri;)Ljava/io/OutputStream;"),
            &[JValue::Object(uri)],
        )?
        .l()?;
    if out.is_null() {
        return Err(Failure::Message("could not write to Downloads".into()));
    }
    write_file(env, &out, apk)?;
    close(env, &out)?;
    let done = content_values(env)?;
    put_int(env, &done, "is_pending", 0)?;
    env.call_method(
        resolver,
        jni_str!("update"),
        jni_sig!("(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I"),
        &[
            JValue::Object(uri),
            JValue::Object(&done),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
        ],
    )?;

    let action = env.new_string("android.intent.action.VIEW")?;
    let intent = env.new_object(
        jni_str!("android/content/Intent"),
        jni_sig!("(Ljava/lang/String;)V"),
        &[JValue::Object(&action)],
    )?;
    let mime = env.new_string(APK_MIME)?;
    env.call_method(
        &intent,
        jni_str!("setDataAndType"),
        jni_sig!("(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;"),
        &[JValue::Object(uri), JValue::Object(&mime)],
    )?;
    add_flags(
        env,
        &intent,
        FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
    )?;
    start_activity(env, context, &intent)
}
