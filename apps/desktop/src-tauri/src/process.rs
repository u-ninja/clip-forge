//! Safe child-process primitives: explicit program + argument arrays (never a shell string),
//! an allowlisted environment, and process-tree termination.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command};

/// Variables a child may inherit. Everything else (tokens in the user's shell, proxies, etc.) is dropped.
const INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    // Windows essentials
    "SystemRoot",
    "SystemDrive",
    "windir",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    // Tooling used by the development commands
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_DATA_HOME",
    // Non-secret app configuration (documented in .env.example)
    "CLIPFORGE_DATA_DIR",
    "CLIPFORGE_DATABASE_PATH",
    "CLIPFORGE_LOG_LEVEL",
    "CLIPFORGE_JOB_CONCURRENCY",
    "CLIPFORGE_JOB_MAX_QUEUED",
    "CLIPFORGE_WORKER_MAX_JOBS",
];

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// Explicit variables, applied after the allowlist.
    pub env: Vec<(String, String)>,
}

/// Fails unless `path` exists and is a regular file (after resolving links).
pub fn validate_executable(path: &Path) -> Result<(), String> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(format!("{} is not a file", path.display())),
        Err(_) => Err(format!("{} was not found", path.display())),
    }
}

pub fn spawn(spec: &SpawnSpec) -> std::io::Result<Child> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args).current_dir(&spec.cwd).env_clear();
    for name in INHERITED_ENV {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    cmd.envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0); // own group, so the whole tree (pnpm -> tsx -> node) can be signalled at once
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
}

/// Asks the process tree to exit (SIGTERM to the group). Windows has no equivalent for console
/// processes, so there this is a forced tree kill; SQLite WAL and job leases make that safe.
pub fn request_stop(pid: u32) {
    #[cfg(unix)]
    signal_group(pid, libc::SIGTERM);
    #[cfg(windows)]
    kill_tree(pid);
}

/// Forcefully ends the process and every descendant. Safe to call on an already-dead tree.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    signal_group(pid, libc::SIGKILL);
    #[cfg(windows)]
    {
        // Constant arguments only; the pid is a number we obtained from spawn().
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Waits until every process in the tree has exited, up to `timeout`. Returns whether it drained.
/// The group leader (e.g. pnpm) often exits before its children finish a graceful shutdown.
pub async fn wait_tree_exit(pid: u32, timeout: std::time::Duration) -> bool {
    #[cfg(unix)]
    {
        let deadline = tokio::time::Instant::now() + timeout;
        let Ok(pgid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        // SAFETY: signal 0 only probes whether any member of the group still exists.
        while unsafe { libc::kill(-pgid, 0) } == 0 {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        true
    }
    #[cfg(windows)]
    {
        let _ = (pid, timeout);
        true // tree is killed explicitly on Windows
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if pgid <= 1 {
        return; // never signal init or "all processes"
    }
    // SAFETY: plain syscall; a negative pid targets the process group we created at spawn.
    unsafe {
        libc::kill(-pgid, signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_or_non_file_executables() {
        assert!(validate_executable(Path::new("/definitely/not/here")).is_err());
        assert!(validate_executable(&std::env::temp_dir()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn env_is_allowlisted_and_tree_kill_ends_grandchildren() {
        // SAFETY: test-only, single-threaded at this point.
        unsafe { std::env::set_var("CLIPFORGE_TEST_LEAK", "should-not-pass") };
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "sleep 30 & echo \"leak=$CLIPFORGE_TEST_LEAK set=$EXPLICIT\"; wait".into(),
            ],
            cwd: std::env::temp_dir(),
            env: vec![("EXPLICIT".into(), "yes".into())],
        };
        let mut child = spawn(&spec).unwrap();
        let pid = child.id().unwrap();
        let mut out = String::new();
        use tokio::io::AsyncBufReadExt;
        tokio::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut out)
            .await
            .unwrap();
        assert_eq!(out.trim(), "leak= set=yes");
        kill_tree(pid);
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        // The backgrounded `sleep` (a grandchild) is gone too: once the OS reaps it, the group is empty.
        let mut gone = false;
        for _ in 0..50 {
            // SAFETY: existence probe only (signal 0).
            if unsafe { libc::kill(-(pid as libc::pid_t), 0) } == -1 {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(gone, "grandchild survived the tree kill");
    }
}
