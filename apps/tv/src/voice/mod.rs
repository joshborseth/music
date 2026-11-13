//! Voice search: Android's speech recognizer turns what someone says into
//! a search.
//!
//! The recognizer reports through a `RecognitionListener`, a Java interface
//! a NativeActivity app can't implement over JNI alone. So `java/VoiceSearch.java`
//! does that part: `build.rs` compiles it into a dex file, `android.rs` loads
//! it from memory and registers the native method it reports through. The
//! first time, Android asks whether Joshify may use the microphone.
//!
//! Elsewhere (tests, screenshots) there is no recognizer: starting reports
//! [`VoiceFailure::Unavailable`].

#[cfg(target_os = "android")]
mod android;

/// What the recognizer did, in order: maybe `Asking`, then `Ready`, any
/// number of `Heard`, `Ended`, and `Done`; or `Failed` at any point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceEvent {
    /// Android is asking whether Joshify may use the microphone.
    Asking,
    /// Listening.
    Ready,
    /// The words heard so far.
    Heard(String),
    /// The speaker stopped; the recognizer is working out the words.
    Ended,
    /// What was said. Empty when it made out nothing.
    Done(String),
    Failed(VoiceFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceFailure {
    /// This TV has no speech recognizer.
    Unavailable,
    /// Joshify may not use the microphone.
    Denied,
    /// Nobody spoke.
    NoSpeech,
    /// It heard something but made out no words.
    NoMatch,
    /// The recognizer needs the internet and could not reach it.
    Network,
    /// The recognizer is busy with something else.
    Busy,
    /// Any other `SpeechRecognizer` error code.
    Other(i32),
}

impl VoiceFailure {
    /// From one of `SpeechRecognizer`'s `ERROR_*` codes.
    pub fn from_code(code: i32) -> Self {
        match code {
            // ERROR_NETWORK_TIMEOUT, ERROR_NETWORK, ERROR_SERVER,
            // ERROR_SERVER_DISCONNECTED
            1 | 2 | 4 | 11 => Self::Network,
            // ERROR_SPEECH_TIMEOUT
            6 => Self::NoSpeech,
            // ERROR_NO_MATCH
            7 => Self::NoMatch,
            // ERROR_RECOGNIZER_BUSY, ERROR_TOO_MANY_REQUESTS
            8 | 10 => Self::Busy,
            // ERROR_INSUFFICIENT_PERMISSIONS
            9 => Self::Denied,
            other => Self::Other(other),
        }
    }

    /// What the TV says about it.
    pub fn message(self) -> String {
        match self {
            Self::Unavailable => "Voice search isn't available on this TV".into(),
            Self::Denied => {
                "Voice search needs the microphone: allow it for Joshify in Android's settings"
                    .into()
            }
            Self::NoSpeech => "Didn't hear anything. Press the mic and try again".into(),
            Self::NoMatch => "Didn't catch that. Press the mic and try again".into(),
            Self::Network => "Voice search couldn't reach the internet".into(),
            Self::Busy => "The microphone is busy. Try again in a moment".into(),
            Self::Other(code) => format!("Voice search stopped (error {code})"),
        }
    }
}

/// Starts and stops the recognizer. Its events go to the function given to
/// [`Voice::new`], on whatever thread the recognizer uses.
pub struct Voice {
    report: std::sync::Arc<dyn Fn(VoiceEvent) + Send + Sync>,
}

impl Voice {
    pub fn new(report: impl Fn(VoiceEvent) + Send + Sync + 'static) -> Self {
        let report: std::sync::Arc<dyn Fn(VoiceEvent) + Send + Sync> = std::sync::Arc::new(report);
        #[cfg(target_os = "android")]
        android::listen(report.clone());
        Self { report }
    }

    /// Start listening.
    pub fn start(&self) {
        #[cfg(target_os = "android")]
        if let Err(error) = android::call("start") {
            log::error!("voice: {error}");
            (self.report)(VoiceEvent::Failed(VoiceFailure::Unavailable));
        }
        #[cfg(not(target_os = "android"))]
        (self.report)(VoiceEvent::Failed(VoiceFailure::Unavailable));
    }

    /// Stop listening, and search for what was said so far.
    pub fn finish(&self) {
        #[cfg(target_os = "android")]
        if let Err(error) = android::call("stop") {
            log::warn!("voice: {error}");
        }
    }

    /// Stop listening without searching.
    pub fn cancel(&self) {
        #[cfg(target_os = "android")]
        if let Err(error) = android::call("cancel") {
            log::warn!("voice: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::VoiceFailure;

    #[test]
    fn reads_the_recognizers_error_codes() {
        assert_eq!(VoiceFailure::from_code(6), VoiceFailure::NoSpeech);
        assert_eq!(VoiceFailure::from_code(7), VoiceFailure::NoMatch);
        assert_eq!(VoiceFailure::from_code(2), VoiceFailure::Network);
        assert_eq!(VoiceFailure::from_code(9), VoiceFailure::Denied);
        assert_eq!(VoiceFailure::from_code(13), VoiceFailure::Other(13));
    }
}
