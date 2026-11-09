//! Bounded JSON-lines logging for the desktop runtime and the child processes it owns.
//!
//! Every service writes to `<data dir>/logs/<service>.log`, rotated by size. Old files are removed
//! by age and by total directory size at startup. Lines are redacted (session secret, home dir)
//! before they touch disk. Recent warnings/errors are kept in memory for the diagnostics screen.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::auth::now_ms;

const MAX_LINE_BYTES: usize = 16 * 1024;
const RECENT_CAPACITY: usize = 50;

#[derive(Clone, Debug)]
pub struct LogConfig {
    pub dir: PathBuf,
    pub max_file_bytes: u64,
    /// Rotated files kept per service, besides the active one.
    pub max_files: usize,
    pub max_dir_bytes: u64,
    pub retention_days: u64,
    /// Mirror lines to this process's stderr (development).
    pub echo: bool,
}

impl LogConfig {
    /// Defaults, overridable with CLIPFORGE_LOG_MAX_FILE_MB / _MAX_DIR_MB / _RETENTION_DAYS.
    pub fn from_env(dir: PathBuf, echo: bool) -> Self {
        let num = |name: &str, default: u64, max: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| (1..=max).contains(v))
                .unwrap_or(default)
        };
        Self {
            dir,
            max_file_bytes: num("CLIPFORGE_LOG_MAX_FILE_MB", 5, 100) * 1024 * 1024,
            max_files: 4,
            max_dir_bytes: num("CLIPFORGE_LOG_MAX_DIR_MB", 100, 2048) * 1024 * 1024,
            retention_days: num("CLIPFORGE_LOG_RETENTION_DAYS", 14, 365),
            echo,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LogEntry {
    pub time: u64,
    pub service: String,
    pub level: String,
    pub message: String,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// pino numbers (30 info, 40 warn, 50 error, 60 fatal) or names (Python, ours).
    fn from_json(v: Option<&Value>) -> Option<Level> {
        match v? {
            Value::Number(n) => n.as_u64().map(|n| match n {
                0..=29 => Level::Debug,
                30..=39 => Level::Info,
                40..=49 => Level::Warn,
                _ => Level::Error,
            }),
            Value::String(s) => Some(match s.to_ascii_lowercase().as_str() {
                "debug" | "trace" => Level::Debug,
                "warn" | "warning" => Level::Warn,
                "error" | "fatal" | "critical" => Level::Error,
                _ => Level::Info,
            }),
            _ => None,
        }
    }
}

struct RotatingFile {
    path: PathBuf,
    file: File,
    size: u64,
}

impl RotatingFile {
    fn open(path: PathBuf) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self { path, file, size })
    }

    fn write_line(&mut self, line: &str, cfg: &LogConfig) -> io::Result<()> {
        let len = line.len() as u64 + 1;
        if self.size > 0 && self.size + len > cfg.max_file_bytes {
            self.rotate(cfg)?;
        }
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.size += len;
        Ok(())
    }

    /// api.log -> api.1.log -> ... -> api.<max_files>.log (dropped).
    fn rotate(&mut self, cfg: &LogConfig) -> io::Result<()> {
        let numbered = |i: usize| self.path.with_extension(format!("{i}.log"));
        let _ = fs::remove_file(numbered(cfg.max_files));
        for i in (1..cfg.max_files).rev() {
            let from = numbered(i);
            if from.exists() {
                fs::rename(&from, numbered(i + 1))?;
            }
        }
        fs::rename(&self.path, numbered(1))?;
        *self = Self::open(self.path.clone())?;
        Ok(())
    }
}

pub struct LogHub {
    cfg: LogConfig,
    files: Mutex<HashMap<String, RotatingFile>>,
    recent: Mutex<VecDeque<LogEntry>>,
    redactions: Vec<(String, String)>,
}

impl LogHub {
    /// Creates the directory, applies retention, and remembers values that must never be written.
    pub fn new(cfg: LogConfig, secrets: Vec<String>) -> io::Result<Self> {
        create_private_dir(&cfg.dir)?;
        cleanup(&cfg)?;
        let mut redactions: Vec<(String, String)> = secrets
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(|s| (s, "[REDACTED]".into()))
            .collect();
        if let Some(home) = std::env::home_dir()
            .and_then(|h| h.to_str().map(String::from))
            .filter(|h| h.len() > 1)
        {
            redactions.push((home, "~".into()));
        }
        Ok(Self {
            cfg,
            files: Mutex::new(HashMap::new()),
            recent: Mutex::new(VecDeque::new()),
            redactions,
        })
    }

    pub fn config(&self) -> &LogConfig {
        &self.cfg
    }

    pub fn redact(&self, text: &str) -> String {
        self.redactions
            .iter()
            .fold(text.to_string(), |acc, (needle, with)| {
                acc.replace(needle.as_str(), with)
            })
    }

    /// Structured event from the desktop runtime itself.
    pub fn event(&self, level: Level, operation: &str, message: &str, fields: Value) {
        let mut entry = Map::new();
        entry.insert("time".into(), json!(now_ms()));
        entry.insert("level".into(), json!(level.as_str()));
        entry.insert("service".into(), json!("desktop"));
        entry.insert("operation".into(), json!(operation));
        entry.insert("msg".into(), json!(message));
        if let Value::Object(extra) = fields {
            entry.extend(extra);
        }
        self.write("desktop", level, message, &Value::Object(entry).to_string());
    }

    /// One line of child output. JSON lines pass through; anything else is wrapped.
    pub fn child_line(&self, service: &str, stderr: bool, raw: &str) {
        let raw = truncate(raw.trim_end(), MAX_LINE_BYTES);
        if raw.is_empty() {
            return;
        }
        let parsed = serde_json::from_str::<Value>(raw)
            .ok()
            .filter(Value::is_object);
        let (level, message, line) = match parsed {
            Some(v) => {
                let level = Level::from_json(v.get("level")).unwrap_or(Level::Info);
                let msg = v
                    .get("msg")
                    .or_else(|| v.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                (level, msg, raw.to_string())
            }
            None => {
                // Unstructured output (pnpm banners, tracebacks): stderr is treated as an error.
                let level = if stderr { Level::Error } else { Level::Info };
                let line = json!({ "time": now_ms(), "level": level.as_str(), "service": service, "msg": raw }).to_string();
                (level, raw.to_string(), line)
            }
        };
        self.write(service, level, &message, &line);
    }

    pub fn recent_errors(&self) -> Vec<LogEntry> {
        self.recent
            .lock()
            .map(|r| r.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// (total bytes, file count) of the log directory.
    pub fn usage(&self) -> (u64, usize) {
        log_files(&self.cfg.dir)
            .iter()
            .fold((0, 0), |(b, n), f| (b + f.size, n + 1))
    }

    fn write(&self, service: &str, level: Level, message: &str, line: &str) {
        let line = self.redact(line);
        if self.cfg.echo {
            eprintln!("{line}");
        }
        if level >= Level::Warn
            && let Ok(mut recent) = self.recent.lock()
        {
            if recent.len() == RECENT_CAPACITY {
                recent.pop_front();
            }
            recent.push_back(LogEntry {
                time: now_ms(),
                service: service.into(),
                level: level.as_str().into(),
                message: self.redact(truncate(message, 500)),
            });
        }
        let Ok(mut files) = self.files.lock() else {
            return;
        };
        if !files.contains_key(service) {
            match RotatingFile::open(self.cfg.dir.join(format!("{service}.log"))) {
                Ok(f) => {
                    files.insert(service.to_string(), f);
                }
                Err(e) => {
                    eprintln!("clipforge: cannot open log file for {service}: {e}");
                    return;
                }
            }
        }
        if let Some(file) = files.get_mut(service)
            && let Err(e) = file.write_line(&line, &self.cfg)
        {
            eprintln!("clipforge: log write failed for {service}: {e}");
        }
    }
}

/// Creates `dir` (and missing parents) readable only by the current user on Unix.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

struct LogFile {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

fn log_files(dir: &Path) -> Vec<LogFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| LogFile {
                path: e.path(),
                size: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            })
        })
        .collect()
}

/// Deletes logs past retention, then the oldest until the directory fits its size cap.
pub fn cleanup(cfg: &LogConfig) -> io::Result<()> {
    let cutoff = SystemTime::now() - Duration::from_secs(cfg.retention_days * 24 * 3600);
    let mut files = log_files(&cfg.dir);
    files.retain(|f| {
        let expired = f.modified < cutoff;
        if expired {
            let _ = fs::remove_file(&f.path);
        }
        !expired
    });
    files.sort_by_key(|f| f.modified);
    let mut total: u64 = files.iter().map(|f| f.size).sum();
    for f in files {
        if total <= cfg.max_dir_bytes {
            break;
        }
        fs::remove_file(&f.path)?;
        total -= f.size;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(dir: &Path) -> LogConfig {
        LogConfig {
            dir: dir.to_path_buf(),
            max_file_bytes: 200,
            max_files: 2,
            max_dir_bytes: 10_000,
            retention_days: 14,
            echo: false,
        }
    }

    #[test]
    fn rotates_by_size_and_keeps_a_bounded_number_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let hub = LogHub::new(cfg(dir.path()), vec![]).unwrap();
        for i in 0..50 {
            hub.child_line(
                "api",
                false,
                &format!(r#"{{"level":30,"msg":"line {i} padding padding padding"}}"#),
            );
        }
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["api.1.log", "api.2.log", "api.log"]);
        assert!(hub.usage().0 <= 3 * 200 + 100);
    }

    #[test]
    fn redacts_secrets_and_wraps_unstructured_lines() {
        let dir = tempfile::tempdir().unwrap();
        let hub = LogHub::new(cfg(dir.path()), vec!["s3cr3t-value".into()]).unwrap();
        hub.child_line("api", true, "boom: token s3cr3t-value leaked");
        let text = fs::read_to_string(dir.path().join("api.log")).unwrap();
        assert!(!text.contains("s3cr3t-value"));
        let v: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(v["level"], "error");
        assert_eq!(
            hub.recent_errors()[0].message,
            "boom: token [REDACTED] leaked"
        );
    }

    #[test]
    fn keeps_only_warnings_and_errors_in_recent() {
        let dir = tempfile::tempdir().unwrap();
        let hub = LogHub::new(cfg(dir.path()), vec![]).unwrap();
        hub.child_line("worker", false, r#"{"level":"info","msg":"fine"}"#);
        hub.child_line("api", false, r#"{"level":50,"msg":"bad"}"#);
        hub.event(Level::Warn, "test", "careful", json!({}));
        let recent: Vec<_> = hub.recent_errors().into_iter().map(|e| e.message).collect();
        assert_eq!(recent, ["bad", "careful"]);
    }

    #[test]
    fn cleanup_enforces_the_directory_cap_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = cfg(dir.path());
        c.max_dir_bytes = 150;
        for (i, name) in ["old.log", "mid.log", "new.log"].iter().enumerate() {
            fs::write(dir.path().join(name), vec![b'x'; 100]).unwrap();
            let t = SystemTime::now() - Duration::from_secs(1000 - i as u64 * 100);
            File::options()
                .write(true)
                .open(dir.path().join(name))
                .unwrap()
                .set_modified(t)
                .unwrap();
        }
        cleanup(&c).unwrap();
        assert!(!dir.path().join("old.log").exists());
        assert!(!dir.path().join("mid.log").exists());
        assert!(dir.path().join("new.log").exists());
    }
}
