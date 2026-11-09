//! Shared runtime context: session secret, logs, resource probe, the two managed services,
//! and how to launch each of them in development and production.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::auth::{HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, SessionSecret, random_hex};
use crate::logs::LogHub;
use crate::process::{SpawnSpec, validate_executable};
use crate::resources::ResourceProbe;
use crate::services::{Kind, RestartPolicy, Service};

pub const DEFAULT_API_PORT: u16 = 4317; // keep in sync with packages/shared constants
pub const DEFAULT_WORKER_PORT: u16 = 4318;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Responses larger than this are refused rather than buffered.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Development,
    Production,
}

/// Where service executables come from.
#[derive(Clone, Debug)]
pub enum Layout {
    /// Local Node/pnpm and the worker venv from the repository (hot reload via the dev commands).
    Development { repo_root: PathBuf },
    /// Bundled sidecar executables next to the app binary (see docs/RUNTIME_LIFECYCLE.md).
    Production { bin_dir: PathBuf },
    /// Explicit specs (tests).
    #[cfg(test)]
    Fixed { api: SpawnSpec, worker: SpawnSpec },
}

pub struct RuntimeConfig {
    pub mode: Mode,
    pub layout: Layout,
    pub data_dir: PathBuf,
    pub api_port: u16,
    pub worker_port: u16,
    pub min_worker_free_bytes: u64,
    pub app_version: String,
    pub api_policy: RestartPolicy,
    pub worker_policy: RestartPolicy,
    pub startup_timeout: Duration,
}

impl RuntimeConfig {
    pub fn from_env(mode: Mode, layout: Layout, data_dir: PathBuf, app_version: String) -> Self {
        let port = |name: &str, default: u16| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|p| *p >= 1024)
                .unwrap_or(default)
        };
        let min_free_mb = std::env::var("CLIPFORGE_WORKER_MIN_FREE_MB")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(1024);
        Self {
            mode,
            layout,
            data_dir,
            api_port: port("CLIPFORGE_API_PORT", DEFAULT_API_PORT),
            worker_port: port("CLIPFORGE_WORKER_PORT", DEFAULT_WORKER_PORT),
            min_worker_free_bytes: min_free_mb * 1024 * 1024,
            app_version,
            api_policy: RestartPolicy::default(),
            worker_policy: RestartPolicy::default(),
            // First dev start compiles TypeScript on the fly; production starts in well under this.
            startup_timeout: Duration::from_secs(45),
        }
    }
}

pub struct Runtime {
    pub mode: Mode,
    pub layout: Layout,
    pub data_dir: PathBuf,
    pub app_version: String,
    pub secret: SessionSecret,
    pub http: reqwest::Client,
    pub logs: LogHub,
    pub probe: Mutex<Box<dyn ResourceProbe>>,
    pub min_worker_free_bytes: u64,
    pub api: Service,
    pub worker: Service,
}

impl Runtime {
    pub fn new(
        cfg: RuntimeConfig,
        secret: SessionSecret,
        logs: LogHub,
        probe: Box<dyn ResourceProbe>,
    ) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .no_proxy() // loopback only; never route through a configured proxy
            .timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        Ok(Self {
            mode: cfg.mode,
            layout: cfg.layout,
            data_dir: cfg.data_dir,
            app_version: cfg.app_version,
            secret,
            http,
            logs,
            probe: Mutex::new(probe),
            min_worker_free_bytes: cfg.min_worker_free_bytes,
            api: Service::new(cfg.api_port, cfg.api_policy, cfg.startup_timeout),
            worker: Service::new(cfg.worker_port, cfg.worker_policy, cfg.startup_timeout),
        })
    }

    pub fn service(&self, kind: Kind) -> &Service {
        match kind {
            Kind::Api => &self.api,
            Kind::Worker => &self.worker,
        }
    }

    /// Builds the launch command. Never interpolates external input: programs are fixed or resolved
    /// from PATH / known locations, and arguments are constant arrays.
    pub fn spawn_spec(&self, kind: Kind) -> Result<SpawnSpec, String> {
        let svc = self.service(kind);
        let mut env = vec![(
            "CLIPFORGE_PARENT_PID".to_string(),
            std::process::id().to_string(),
        )];
        match kind {
            Kind::Api => env.extend([
                (
                    "NODE_ENV".into(),
                    if self.mode == Mode::Development {
                        "development"
                    } else {
                        "production"
                    }
                    .into(),
                ),
                ("CLIPFORGE_API_HOST".into(), "127.0.0.1".into()),
                ("CLIPFORGE_API_PORT".into(), svc.port.to_string()),
                ("CLIPFORGE_API_SECRET".into(), self.secret.to_hex()),
            ]),
            Kind::Worker => env.extend([
                ("CLIPFORGE_WORKER_HOST".into(), "127.0.0.1".into()),
                ("CLIPFORGE_WORKER_PORT".into(), svc.port.to_string()),
                ("PYTHONUNBUFFERED".into(), "1".into()),
                ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
            ]),
        }
        let (program, args, cwd): (PathBuf, Vec<&str>, PathBuf) = match (&self.layout, kind) {
            (Layout::Development { repo_root }, Kind::Api) => {
                let pnpm = which::which("pnpm").map_err(|_| {
                    "pnpm was not found on PATH (development mode needs Node.js and pnpm)"
                        .to_string()
                })?;
                (
                    pnpm,
                    vec!["--filter", "@clipforge/api", "dev"],
                    repo_root.clone(),
                )
            }
            (Layout::Development { repo_root }, Kind::Worker) => {
                let dir = repo_root.join("services").join("worker");
                let python = if cfg!(windows) {
                    dir.join(".venv").join("Scripts").join("python.exe")
                } else {
                    dir.join(".venv").join("bin").join("python")
                };
                validate_executable(&python).map_err(|_| "Worker environment missing: run `pnpm dev:worker` once to create services/worker/.venv".to_string())?;
                // Spawn the venv path itself (not its resolved target) so Python picks up the venv.
                (python, vec!["-m", "worker.main"], dir)
            }
            (Layout::Production { bin_dir }, kind) => {
                let name = match kind {
                    Kind::Api => "clipforge-api",
                    Kind::Worker => "clipforge-worker",
                };
                (sidecar(bin_dir, name)?, vec![], self.data_dir.clone())
            }
            #[cfg(test)]
            (Layout::Fixed { api, worker }, kind) => {
                let mut spec = if kind == Kind::Api {
                    api.clone()
                } else {
                    worker.clone()
                };
                spec.env.extend(env);
                return Ok(spec);
            }
        };
        validate_executable(&program)?;
        Ok(SpawnSpec {
            program,
            args: args.into_iter().map(Into::into).collect(),
            cwd,
            env,
        })
    }

    /// Sends a signed request to the API. `path` must already be validated by the caller.
    pub async fn api_call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<(u16, Vec<u8>), String> {
        let bytes = body.unwrap_or_default();
        let signed = self
            .secret
            .sign(method.as_str(), path, &bytes)
            .map_err(|e| format!("signing failed: {e}"))?;
        let url = format!("http://127.0.0.1:{}{path}", self.api.port);
        let correlation = random_hex(16).unwrap_or_default();
        let mut req = self
            .http
            .request(method, url)
            .header(HEADER_TIMESTAMP, signed.timestamp)
            .header(HEADER_NONCE, signed.nonce)
            .header(HEADER_SIGNATURE, signed.signature)
            .header("x-request-id", correlation);
        if !bytes.is_empty() {
            req = req.header("content-type", "application/json").body(bytes);
        }
        let mut res = req
            .send()
            .await
            .map_err(|e| format!("API unreachable: {}", without_url(&e)))?;
        let status = res.status().as_u16();
        let mut out = Vec::new();
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| format!("API response failed: {}", without_url(&e)))?
        {
            if out.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("API response too large".into());
            }
            out.extend_from_slice(&chunk);
        }
        Ok((status, out))
    }
}

fn without_url(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    if let Some(url) = e.url() {
        s = s.replace(url.as_str(), "");
    }
    s
}

/// A bundled executable: must exist inside `bin_dir` itself (no symlink escaping it).
fn sidecar(bin_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let path = bin_dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let not_bundled = || {
        format!(
            "This build does not include the {name} runtime; see docs/RUNTIME_LIFECYCLE.md (production packaging)"
        )
    };
    let real = path.canonicalize().map_err(|_| not_bundled())?;
    let root = bin_dir.canonicalize().map_err(|_| not_bundled())?;
    if !real.starts_with(&root) {
        return Err(format!("{name} resolves outside the application directory"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_reports_missing_sidecars_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let err = sidecar(dir.path(), "clipforge-api").unwrap_err();
        assert!(err.contains("does not include"));
    }

    #[cfg(unix)]
    #[test]
    fn production_rejects_sidecars_that_escape_the_app_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/bin/sh", dir.path().join("clipforge-api")).unwrap();
        assert!(
            sidecar(dir.path(), "clipforge-api")
                .unwrap_err()
                .contains("outside")
        );
    }
}
