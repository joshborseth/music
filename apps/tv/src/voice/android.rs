//! Loads `VoiceSearch` (java/VoiceSearch.java, compiled to dex by build.rs)
//! from memory, and passes its reports on.

use std::ffi::c_void;
use std::sync::{Arc, Mutex, OnceLock};

use jni::objects::{JClass, JObject, JString, JValue};
use jni::refs::Global;
use jni::sys::jint;
use jni::{Env, EnvUnowned, NativeMethod, jni_sig, jni_str};

use super::{VoiceEvent, VoiceFailure};
use crate::android_jni::{Java, with_context};

const DEX: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/classes.dex"));

// VoiceSearch's event kinds.
const ASKING: jint = 0;
const READY: jint = 1;
const HEARD: jint = 2;
const ENDED: jint = 3;
const DONE: jint = 4;
const ERROR: jint = 5;
const DENIED: jint = 6;
const UNAVAILABLE: jint = 7;

type Report = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

static REPORT: OnceLock<Report> = OnceLock::new();
/// The `VoiceSearch` instance, made the first time voice search starts.
static HELPER: Mutex<Option<Global<JObject<'static>>>> = Mutex::new(None);

pub fn listen(report: Report) {
    let _ = REPORT.set(report);
}

/// Call `method` (`start`, `stop`, or `cancel`) on the helper, loading it first.
pub fn call(method: &'static str) -> Result<(), String> {
    let mut helper = HELPER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    with_context("voice search", |env, context| {
        if helper.is_none() {
            let made = load(env, context)?;
            *helper = Some(env.new_global_ref(made)?);
        }
        let Some(instance) = helper.as_ref() else {
            return Ok(());
        };
        let name = match method {
            "start" => jni_str!("start"),
            "stop" => jni_str!("stop"),
            _ => jni_str!("cancel"),
        };
        env.call_method(instance.as_ref(), name, jni_sig!("()V"), &[])?;
        Ok(())
    })
}

/// Load the dex, register `event`, and make a `VoiceSearch` for the Activity.
fn load<'j>(env: &mut Env<'j>, context: &JObject<'j>) -> Java<JObject<'j>> {
    let parent = env
        .call_method(
            context,
            jni_str!("getClassLoader"),
            jni_sig!("()Ljava/lang/ClassLoader;"),
            &[],
        )?
        .l()?;
    // SAFETY: DEX is 'static and the class loader only reads it.
    let buffer = unsafe { env.new_direct_byte_buffer(DEX.as_ptr().cast_mut(), DEX.len()) }?;
    let loader = env.new_object(
        jni_str!("dalvik/system/InMemoryDexClassLoader"),
        jni_sig!("(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V"),
        &[JValue::Object(&buffer), JValue::Object(&parent)],
    )?;
    let name = env.new_string("app.music.tv.VoiceSearch")?;
    let class = env
        .call_method(
            &loader,
            jni_str!("loadClass"),
            jni_sig!("(Ljava/lang/String;)Ljava/lang/Class;"),
            &[JValue::Object(&name)],
        )?
        .l()?;
    let class = env.cast_local::<JClass>(class)?;
    let methods = [
        // SAFETY: `event` has the JNI signature this names, for a static method.
        unsafe {
            NativeMethod::from_raw_parts(
                jni_str!("event"),
                jni_str!("(IILjava/lang/String;)V"),
                event as *mut c_void,
            )
        },
    ];
    // SAFETY: see above.
    unsafe { env.register_native_methods(&class, &methods) }?;
    Ok(env.new_object(
        &class,
        jni_sig!("(Landroid/app/Activity;)V"),
        &[JValue::Object(context)],
    )?)
}

/// `VoiceSearch.event`, on Android's main thread.
extern "system" fn event<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    kind: jint,
    code: jint,
    text: JString<'local>,
) {
    let text = env
        .with_env(|env| -> jni::errors::Result<String> {
            if text.is_null() {
                Ok(String::new())
            } else {
                text.try_to_string(env)
            }
        })
        .resolve::<jni::errors::LogErrorAndDefault>();
    let event = match kind {
        ASKING => VoiceEvent::Asking,
        READY => VoiceEvent::Ready,
        HEARD => VoiceEvent::Heard(text),
        ENDED => VoiceEvent::Ended,
        DONE => VoiceEvent::Done(text),
        ERROR => VoiceEvent::Failed(VoiceFailure::from_code(code)),
        DENIED => VoiceEvent::Failed(VoiceFailure::Denied),
        UNAVAILABLE => VoiceEvent::Failed(VoiceFailure::Unavailable),
        other => {
            log::warn!("voice: unknown event {other}");
            return;
        }
    };
    if let Some(report) = REPORT.get() {
        report(event);
    }
}
