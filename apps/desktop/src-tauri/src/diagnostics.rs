//! Diagnostics report: what the Diagnostics screen shows and what "Export" writes.
//! Contains no secrets, tokens, file contents or user media; paths have the home dir replaced by `~`.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use crate::auth::now_ms;
use crate::logs::LogEntry;
use crate::resources::ResourceSnapshot;
use crate::runtime::{Mode, Runtime};
use crate::services::ServiceStatus;

const KEEP_EXPORTS: usize = 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub mode: Mode,
    pub api: ServiceStatus,
    pub worker: ServiceStatus,
}

pub fn runtime_status(rt: &Runtime) -> RuntimeStatus {
    RuntimeStatus {
        mode: rt.mode,
        api: rt.api.status(),
        worker: rt.worker.status(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: String,
    mode: Mode,
}

#[derive(Serialize)]
pub struct OsInfo {
    name: String,
    version: String,
    arch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsInfo {
    directory: String,
    total_bytes: u64,
    file_count: usize,
    max_bytes: u64,
    retention_days: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    generated_at: u64,
    app: AppInfo,
    os: OsInfo,
    runtime: RuntimeStatus,
    resources: ResourceSnapshot,
    api: Option<Value>,
    api_error: Option<String>,
    logs: LogsInfo,
    recent_errors: Vec<LogEntry>,
}

pub async fn report(rt: &Arc<Runtime>) -> Report {
    let (api, api_error) = if rt.api.is_running() {
        match rt
            .api_call(reqwest::Method::GET, "/api/v1/diagnostics", None)
            .await
        {
            Ok((200, body)) => match serde_json::from_slice::<Value>(&body) {
                Ok(v) => (Some(v), None),
                Err(_) => (None, Some("API returned malformed diagnostics".into())),
            },
            Ok((status, _)) => (None, Some(format!("API returned HTTP {status}"))),
            Err(e) => (None, Some(e)),
        }
    } else {
        (None, Some("API is not running".into()))
    };

    let mut tracked = vec![("desktop".to_string(), std::process::id())];
    tracked.extend(rt.api.pid().map(|p| ("api".to_string(), p)));
    tracked.extend(rt.worker.pid().map(|p| ("worker".to_string(), p)));
    let resources = match rt.probe.lock() {
        Ok(mut probe) => probe.snapshot(&tracked, &rt.data_dir),
        Err(poisoned) => poisoned.into_inner().snapshot(&tracked, &rt.data_dir),
    };

    let (total_bytes, file_count) = rt.logs.usage();
    let cfg = rt.logs.config();
    Report {
        generated_at: now_ms(),
        app: AppInfo {
            name: "ClipForge Local",
            version: rt.app_version.clone(),
            mode: rt.mode,
        },
        os: OsInfo {
            name: sysinfo::System::name().unwrap_or_else(|_| std::env::consts::OS.into()),
            version: sysinfo::System::os_version().unwrap_or_default(),
            arch: sysinfo::System::cpu_arch(),
        },
        runtime: runtime_status(rt),
        resources,
        api,
        api_error,
        logs: LogsInfo {
            directory: rt.logs.redact(&cfg.dir.display().to_string()),
            total_bytes,
            file_count,
            max_bytes: cfg.max_dir_bytes,
            retention_days: cfg.retention_days,
        },
        recent_errors: rt.logs.recent_errors(),
    }
}

/// Writes the report to `<data dir>/diagnostics/` and returns the (redacted) path.
pub async fn export(rt: &Arc<Runtime>) -> Result<String, String> {
    let report = report(rt).await;
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    let dir = rt.data_dir.join("diagnostics");
    crate::logs::create_private_dir(&dir)
        .map_err(|e| format!("cannot create diagnostics folder: {e}"))?;
    let path = dir.join(format!(
        "clipforge-diagnostics-{}.json",
        report.generated_at
    ));
    // Defence in depth: redact the whole document once more before it touches disk.
    fs::write(&path, rt.logs.redact(&json)).map_err(|e| format!("cannot write report: {e}"))?;
    prune(&dir);
    Ok(rt.logs.redact(&path.display().to_string()))
}

fn prune(dir: &PathBuf) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(KEEP_EXPORTS);
    for f in files.into_iter().take(excess) {
        let _ = fs::remove_file(f);
    }
}
