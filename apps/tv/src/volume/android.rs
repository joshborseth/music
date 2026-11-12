//! Android's music stream volume, through `AudioManager` over JNI.

use jni::objects::{JObject, JValue};
use jni::{Env, jni_sig, jni_str};

use super::{Platform, Steps};
use crate::android_jni::{Attach, Failure, Java, sdk_int, with_context_attached};

// android.media.AudioManager
const STREAM_MUSIC: i32 = 3;
const FLAG_SHOW_UI: i32 = 1;
/// `getStreamMinVolume` exists from Android 9 (API 28). Before, it is 0.
const MIN_VOLUME_API: i32 = 28;

pub struct Android {
    has_min_volume: bool,
}

impl Android {
    pub fn new() -> Self {
        let sdk = sdk_int().unwrap_or_else(|error| {
            log::warn!("volume: {error}");
            0
        });
        Self {
            has_min_volume: sdk >= MIN_VOLUME_API,
        }
    }
}

impl Platform for Android {
    fn read(&mut self) -> Result<Option<Steps>, String> {
        let has_min_volume = self.has_min_volume;
        // NOTE: this thread asks twice a second, so it stays attached.
        with_context_attached("reading the volume", Attach::Permanently, |env, context| {
            let audio = audio_manager(env, context)?;
            let fixed = env
                .call_method(&audio, jni_str!("isVolumeFixed"), jni_sig!("()Z"), &[])?
                .z()?;
            if fixed {
                return Ok(None);
            }
            let stream = [JValue::Int(STREAM_MUSIC)];
            let max = env
                .call_method(
                    &audio,
                    jni_str!("getStreamMaxVolume"),
                    jni_sig!("(I)I"),
                    &stream,
                )?
                .i()?;
            let min = if has_min_volume {
                env.call_method(
                    &audio,
                    jni_str!("getStreamMinVolume"),
                    jni_sig!("(I)I"),
                    &stream,
                )?
                .i()?
            } else {
                0
            };
            let current = env
                .call_method(
                    &audio,
                    jni_str!("getStreamVolume"),
                    jni_sig!("(I)I"),
                    &stream,
                )?
                .i()?;
            Ok(Some(Steps { current, min, max }))
        })
    }

    fn set(&mut self, step: i32) -> Result<(), String> {
        with_context_attached("setting the volume", Attach::Permanently, |env, context| {
            let audio = audio_manager(env, context)?;
            env.call_method(
                &audio,
                jni_str!("setStreamVolume"),
                jni_sig!("(III)V"),
                &[
                    JValue::Int(STREAM_MUSIC),
                    JValue::Int(step),
                    JValue::Int(FLAG_SHOW_UI),
                ],
            )?;
            Ok(())
        })
    }
}

fn audio_manager<'j>(env: &mut Env<'j>, context: &JObject<'j>) -> Java<JObject<'j>> {
    let name = env.new_string("audio")?;
    let manager = env
        .call_method(
            context,
            jni_str!("getSystemService"),
            jni_sig!("(Ljava/lang/String;)Ljava/lang/Object;"),
            &[JValue::Object(&name)],
        )?
        .l()?;
    if manager.is_null() {
        return Err(Failure::Message("no AudioManager".into()));
    }
    Ok(manager)
}
