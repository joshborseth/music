fn main() {
    slint_build::compile("ui/app.slint").unwrap();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        compile_java();
    }
}

/// Compile `java/VoiceSearch.java` into `classes.dex` in `OUT_DIR`, which
/// `src/voice/android.rs` loads from memory: voice search needs a Java
/// listener, and a NativeActivity app has no Java of its own. The same way
/// the vendored Slint backend builds its helper; it needs the JDK and the
/// Android SDK that building the APK needs anyway.
fn compile_java() {
    use android_build::{Dexer, JavaBuild};
    use std::path::PathBuf;

    let source = "java/VoiceSearch.java";
    println!("cargo:rerun-if-changed={source}");
    let out: PathBuf = std::env::var_os("OUT_DIR").unwrap().into();
    let classes = out.join("java");
    let _ = std::fs::remove_dir_all(&classes);
    std::fs::create_dir_all(&classes).expect("create the Java output folder");
    let android_jar = android_build::android_jar(None).expect("no Android platform in the SDK");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");

    let javac = JavaBuild::new()
        .file(source)
        .class_path(&android_jar)
        .classes_out_dir(&classes)
        .java_source_version(8)
        .java_target_version(8)
        .command()
        .expect("find javac")
        .args(["-encoding", "UTF-8"])
        .output()
        .expect("run javac");
    assert!(
        javac.status.success(),
        "javac failed: {}",
        String::from_utf8_lossy(&javac.stderr)
    );

    let d8 = Dexer::new()
        .android_jar(&android_jar)
        .class_path(&classes)
        .collect_classes(&classes)
        .expect("list the compiled classes")
        .release(release)
        .android_min_api(26)
        .out_dir(&out)
        .command()
        .expect("find d8")
        .output()
        .expect("run d8");
    assert!(
        d8.status.success(),
        "d8 failed: {}",
        String::from_utf8_lossy(&d8.stderr)
    );
}
