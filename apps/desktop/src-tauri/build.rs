fn main() {
    // App commands must be granted explicitly in capabilities/ (no implicit allow-all).
    let commands = &[
        "api_request",
        "runtime_status",
        "api_restart",
        "worker_start",
        "worker_stop",
        "diagnostics_report",
        "diagnostics_export",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
