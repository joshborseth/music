package app.music.tv;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;

/**
 * Voice search: Android's speech recognizer, for the Rust app.
 *
 * The app is a NativeActivity with no Java of its own, and a
 * RecognitionListener can only be written in Java, so this one class is
 * compiled into a dex file at build time (build.rs), loaded from memory by
 * src/voice/android.rs, and reports back through the native method
 * {@link #event}. SpeechRecognizer only works on the main thread, so every
 * call is posted there.
 */
public final class VoiceSearch {
    // What happened. src/voice/android.rs reads the same numbers.
    static final int ASKING = 0;
    static final int READY = 1;
    static final int HEARD = 2;
    static final int ENDED = 3;
    static final int DONE = 4;
    static final int ERROR = 5;
    static final int DENIED = 6;
    static final int UNAVAILABLE = 7;

    /** Into Rust: what happened, a SpeechRecognizer error code, and the words heard. */
    static native void event(int kind, int code, String text);

    /** How often, and how long, to look whether the microphone was allowed. */
    private static final long PERMISSION_POLL_MS = 250;
    private static final long PERMISSION_WAIT_MS = 60000;
    /** Android shows no prompt when the permission was denied for good. */
    private static final long PROMPT_WAIT_MS = 3000;

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    /** Each start counts up, so a cancelled session's callbacks are dropped. */
    private int session;

    public VoiceSearch(Activity activity) {
        this.activity = activity;
    }

    /** Start listening, asking for the microphone first if need be. */
    public void start() {
        main.post(new Runnable() {
            @Override
            public void run() {
                begin();
            }
        });
    }

    /** Stop listening and recognize what was said so far. */
    public void stop() {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (recognizer != null) {
                    recognizer.stopListening();
                }
            }
        });
    }

    /** Stop without a result. */
    public void cancel() {
        main.post(new Runnable() {
            @Override
            public void run() {
                session++;
                close();
            }
        });
    }

    private void begin() {
        session++;
        close();
        final int id = session;
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            event(UNAVAILABLE, 0, null);
            return;
        }
        if (allowed()) {
            listen(id);
            return;
        }
        event(ASKING, 0, null);
        activity.requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, 1);
        awaitPermission(id, SystemClock.uptimeMillis(), false);
    }

    private boolean allowed() {
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * NativeActivity drops onRequestPermissionsResult, so watch instead. The
     * prompt is an activity of its own: once it took the focus and gave it
     * back, it was answered.
     */
    private void awaitPermission(final int id, final long since, final boolean prompted) {
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (id != session) {
                    return;
                }
                if (allowed()) {
                    listen(id);
                    return;
                }
                boolean focused = activity.hasWindowFocus();
                long waited = SystemClock.uptimeMillis() - since;
                boolean answered = prompted && focused;
                boolean noPrompt = !prompted && focused && waited > PROMPT_WAIT_MS;
                if (answered || noPrompt || waited > PERMISSION_WAIT_MS) {
                    event(DENIED, 0, null);
                    return;
                }
                awaitPermission(id, since, prompted || !focused);
            }
        }, PERMISSION_POLL_MS);
    }

    private void listen(int id) {
        close();
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(new Listener(id));
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
        recognizer.startListening(intent);
    }

    private void close() {
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    private static String first(Bundle results) {
        if (results == null) {
            return null;
        }
        ArrayList<String> heard = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return heard == null || heard.isEmpty() ? null : heard.get(0);
    }

    private final class Listener implements RecognitionListener {
        private final int id;

        Listener(int id) {
            this.id = id;
        }

        private boolean current() {
            return id == session;
        }

        /** The session ended: let the recognizer go, after this callback returns. */
        private void finish() {
            session++;
            main.post(new Runnable() {
                @Override
                public void run() {
                    close();
                }
            });
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (current()) {
                event(READY, 0, null);
            }
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {
            if (current()) {
                event(ENDED, 0, null);
            }
        }

        @Override
        public void onError(int error) {
            if (current()) {
                finish();
                event(ERROR, error, null);
            }
        }

        @Override
        public void onResults(Bundle results) {
            if (current()) {
                finish();
                event(DONE, 0, first(results));
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String heard = first(partialResults);
            if (current() && heard != null) {
                event(HEARD, 0, heard);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }
}
