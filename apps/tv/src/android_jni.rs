//! Calling Android's Java APIs from Rust over JNI (there is no Java in this
//! app). The updater and the volume control share these.
//!
//! Every call's pending Java exception is caught, cleared, logged, and
//! returned as an `Err`.

use jni::errors::Error as JniError;
use jni::objects::JObject;
use jni::{Env, JavaVM, jni_sig, jni_str};

/// A JNI failure, or a message of our own.
pub enum Failure {
    Jni(JniError),
    Message(String),
}

impl From<JniError> for Failure {
    fn from(error: JniError) -> Self {
        Self::Jni(error)
    }
}

pub type Java<T> = Result<T, Failure>;

/// Clear a pending Java exception, and describe it (or `error`).
pub fn take_exception(env: &mut Env<'_>, error: Failure) -> String {
    if env.exception_check() {
        // NOTE: exception_catch clears it and keeps its class and message.
        match env.exception_catch() {
            Err(JniError::CaughtJavaException {
                name, msg, stack, ..
            }) => {
                log::error!("java: {name}: {msg}\n{stack}");
                return format!("{name}: {msg}");
            }
            Err(other) => log::error!("java: could not read a Java exception: {other}"),
            Ok(()) => {}
        }
        if env.exception_check() {
            env.exception_describe();
            env.exception_clear();
        }
        return "a Java exception".into();
    }
    match error {
        Failure::Jni(error) => error.to_string(),
        Failure::Message(message) => message,
    }
}

/// How long the calling thread stays attached to the JavaVM.
#[derive(Clone, Copy)]
pub enum Attach {
    /// Detach again afterwards: for threads that call Java once in a while.
    ForScope,
    /// Stay attached until the thread ends: for a thread that calls Java
    /// every second or so, where attaching each time would cost more.
    Permanently,
}

/// Run `work` on this thread, attached to the JavaVM, with the app's
/// Activity (its Context). Never leaves an exception pending.
pub fn with_context<T>(
    what: &str,
    work: impl for<'j> FnOnce(&mut Env<'j>, &JObject<'j>) -> Java<T>,
) -> Result<T, String> {
    with_context_attached(what, Attach::ForScope, work)
}

/// [`with_context`], choosing how long the thread stays attached.
pub fn with_context_attached<T>(
    what: &str,
    attach: Attach,
    work: impl for<'j> FnOnce(&mut Env<'j>, &JObject<'j>) -> Java<T>,
) -> Result<T, String> {
    let android = ndk_context::android_context();
    if android.vm().is_null() || android.context().is_null() {
        return Err(format!("{what}: Android's context is not ready"));
    }
    // SAFETY: android-activity set both from the live VM and its Activity
    // (a global reference that lasts as long as the app).
    let vm = unsafe { JavaVM::from_raw(android.vm().cast()) };
    let run = |env: &mut Env<'_>| -> Result<Result<T, String>, JniError> {
        // SAFETY: see above; this borrows the global reference, never deletes it.
        let context = unsafe { JObject::from_raw(env, android.context() as jni::sys::jobject) };
        let result = work(env, &context);
        let pending = env.exception_check();
        Ok(match result {
            Ok(value) if !pending => Ok(value),
            Ok(_) => Err(take_exception(env, Failure::Message("an exception".into()))),
            Err(error) => Err(take_exception(env, error)),
        })
    };
    let outcome = match attach {
        Attach::ForScope => vm.attach_current_thread_for_scope(run),
        Attach::Permanently => vm.attach_current_thread(run),
    };
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(format!("{what}: {message}")),
        Err(error) => Err(format!("{what}: could not attach to Java: {error}")),
    }
}

/// `Build.VERSION.SDK_INT`: the Android API level.
pub fn sdk_int() -> Result<i32, String> {
    with_context("Build.VERSION.SDK_INT", |env, _| {
        Ok(env
            .get_static_field(
                jni_str!("android/os/Build$VERSION"),
                jni_str!("SDK_INT"),
                jni_sig!("I"),
            )?
            .i()?)
    })
}
