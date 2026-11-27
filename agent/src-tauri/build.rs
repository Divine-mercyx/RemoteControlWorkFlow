fn main() {
    // Rebuild when the baked-in server URL changes.
    println!("cargo:rerun-if-env-changed=NOLT_SERVER_URL");
    tauri_build::build()
}
