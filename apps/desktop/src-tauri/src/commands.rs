//! IPC surface exposed to the webview. Each command is listed in build.rs and granted explicitly
//! in capabilities/default.json. None of them accepts paths, programs or arguments for processes.

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

use crate::diagnostics::{self, Report, RuntimeStatus};
use crate::runtime::Runtime;
use crate::services::{self, Kind};

const MAX_PATH_LEN: usize = 512;
const MAX_BODY_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
pub struct ProxyResponse {
    status: u16,
    body: Value,
}

/// Only API routes, with a conservative character set: no traversal, no scheme/host, no fragments.
pub fn validate_api_path(path: &str) -> Result<(), CommandError> {
    let ok_chars = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.?=&%:".contains(&b));
    if path.len() > MAX_PATH_LEN
        || !path.starts_with("/api/v1/")
        || !ok_chars
        || path.contains("..")
        || path.contains("//")
    {
        return Err(CommandError::new("INVALID_REQUEST", "Invalid API path"));
    }
    Ok(())
}

fn validate_method(method: &str) -> Result<reqwest::Method, CommandError> {
    match method {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        _ => Err(CommandError::new("INVALID_REQUEST", "Unsupported method")),
    }
}

/// Signs and forwards a request to the local API. The session secret never reaches the webview.
#[tauri::command]
pub async fn api_request(
    rt: State<'_, Arc<Runtime>>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<ProxyResponse, CommandError> {
    let method = validate_method(&method)?;
    validate_api_path(&path)?;
    let bytes = match body {
        Some(v) => {
            let b = serde_json::to_vec(&v)
                .map_err(|_| CommandError::new("INVALID_REQUEST", "Body is not serializable"))?;
            if b.len() > MAX_BODY_BYTES {
                return Err(CommandError::new(
                    "INVALID_REQUEST",
                    "Request body too large",
                ));
            }
            Some(b)
        }
        None => None,
    };
    if !rt.api.is_running() {
        return Err(CommandError::new(
            "API_UNAVAILABLE",
            "The local API is not running",
        ));
    }
    let (status, raw) = rt
        .api_call(method, &path, bytes)
        .await
        .map_err(|e| CommandError::new("API_UNAVAILABLE", e))?;
    let body = if raw.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&raw).unwrap_or(Value::Null)
    };
    Ok(ProxyResponse { status, body })
}

#[tauri::command]
pub fn runtime_status(rt: State<'_, Arc<Runtime>>) -> RuntimeStatus {
    diagnostics::runtime_status(&rt)
}

#[tauri::command]
pub async fn api_restart(rt: State<'_, Arc<Runtime>>) -> Result<(), CommandError> {
    services::restart(rt.inner().clone(), Kind::Api)
        .await
        .map_err(|e| CommandError::new("START_FAILED", e))
}

#[tauri::command]
pub async fn worker_start(rt: State<'_, Arc<Runtime>>) -> Result<(), CommandError> {
    services::start(rt.inner().clone(), Kind::Worker, true)
        .await
        .map_err(|e| CommandError::new("START_FAILED", e))
}

#[tauri::command]
pub async fn worker_stop(rt: State<'_, Arc<Runtime>>) -> Result<(), CommandError> {
    services::stop(rt.inner(), Kind::Worker).await;
    Ok(())
}

#[tauri::command]
pub async fn diagnostics_report(rt: State<'_, Arc<Runtime>>) -> Result<Report, CommandError> {
    Ok(diagnostics::report(rt.inner()).await)
}

#[derive(Serialize)]
pub struct ExportResult {
    path: String,
}

#[tauri::command]
pub async fn diagnostics_export(rt: State<'_, Arc<Runtime>>) -> Result<ExportResult, CommandError> {
    diagnostics::export(rt.inner())
        .await
        .map(|path| ExportResult { path })
        .map_err(|e| CommandError::new("EXPORT_FAILED", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_api_routes_and_rejects_everything_else() {
        for ok in [
            "/api/v1/jobs",
            "/api/v1/jobs?status=queued&limit=10",
            "/api/v1/jobs/0f0e-ab/cancel",
        ] {
            assert!(validate_api_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/health",
            "http://evil.example/api/v1/jobs",
            "/api/v1/../../etc/passwd",
            "/api/v1//jobs",
            "/api/v1/jobs#frag",
            "/api/v1/jobs\r\nX-Injected: 1",
            "/api/v1/jobs\\..\\x",
            "api/v1/jobs",
            &format!("/api/v1/{}", "a".repeat(600)),
        ] {
            assert!(validate_api_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn allows_only_known_methods() {
        assert!(validate_method("GET").is_ok());
        assert!(validate_method("get").is_err());
        assert!(validate_method("TRACE").is_err());
        assert!(validate_method("CONNECT").is_err());
    }
}
