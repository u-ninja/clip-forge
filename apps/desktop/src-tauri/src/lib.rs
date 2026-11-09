//! ClipForge Local desktop runtime: owns the API (started with the app) and the worker (on
//! request), signs every API request on behalf of the UI, and reports health and resources.
//! See docs/RUNTIME_LIFECYCLE.md.

mod auth;
mod commands;
mod diagnostics;
mod logs;
mod process;
mod resources;
mod runtime;
mod services;

use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, RunEvent};

use crate::auth::SessionSecret;
use crate::logs::{Level, LogConfig, LogHub};
use crate::resources::SysinfoProbe;
use crate::runtime::{Layout, Mode, Runtime, RuntimeConfig};
use crate::services::Kind;

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn build_runtime(app: &tauri::App) -> Result<Arc<Runtime>, Box<dyn std::error::Error>> {
    let data_dir = match std::env::var_os("CLIPFORGE_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    };
    let (mode, layout) = if cfg!(debug_assertions) {
        // Debug builds run from the repository: src-tauri -> desktop -> apps -> root.
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .canonicalize()?;
        (Mode::Development, Layout::Development { repo_root })
    } else {
        let bin_dir = std::env::current_exe()?
            .parent()
            .map(PathBuf::from)
            .ok_or("no executable directory")?;
        (Mode::Production, Layout::Production { bin_dir })
    };
    // A fresh secret every launch: restarting the app rotates the API credentials.
    let secret = SessionSecret::generate()?;
    let logs = LogHub::new(
        LogConfig::from_env(data_dir.join("logs"), mode == Mode::Development),
        vec![secret.to_hex()],
    )?;
    let version = app.package_info().version.to_string();
    let cfg = RuntimeConfig::from_env(mode, layout, data_dir, version.clone());
    let probe = Box::new(SysinfoProbe::new()?);
    let rt = Arc::new(Runtime::new(cfg, secret, logs, probe)?);
    rt.logs.event(
        Level::Info,
        "startup",
        "desktop runtime starting",
        json!({ "version": version, "mode": mode, "pid": std::process::id() }),
    );
    Ok(rt)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let rt = build_runtime(app)?;
            app.manage(rt.clone());
            // SIGTERM (logout, `kill`, OS shutdown) takes the same graceful path as quitting.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(mut term) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        term.recv().await;
                        handle.exit(0);
                    }
                });
            }
            // The API starts with the app; the worker waits until something asks for it.
            tauri::async_runtime::spawn(async move {
                let _ = services::start(rt, Kind::Api, true).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::api_request,
            commands::runtime_status,
            commands::api_restart,
            commands::worker_start,
            commands::worker_stop,
            commands::diagnostics_report,
            commands::diagnostics_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // Hold the exit until both services have stopped gracefully, then exit for real.
            if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let rt = handle.state::<Arc<Runtime>>().inner().clone();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                rt.logs
                    .event(Level::Info, "shutdown", "stopping services", json!({}));
                tokio::join!(
                    services::stop(&rt, Kind::Worker),
                    services::stop(&rt, Kind::Api)
                );
                rt.logs.event(
                    Level::Info,
                    "shutdown",
                    "desktop runtime stopped",
                    json!({}),
                );
                handle.exit(0);
            });
        }
        RunEvent::Exit => {
            if let Some(rt) = handle.try_state::<Arc<Runtime>>() {
                services::kill_all_now(&rt);
            }
        }
        _ => {}
    });
}
