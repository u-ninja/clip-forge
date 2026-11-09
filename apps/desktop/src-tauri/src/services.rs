//! Lifecycle of the two child services the desktop app owns: the API (started with the app) and
//! the worker (started only on request).
//!
//! State per service lives behind one mutex; a `generation` counter makes late events from an old
//! process (a monitor noticing exit, a readiness loop) harmless after a restart or stop.

use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::future::Future;
use std::net::TcpListener;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::watch;

use crate::auth::now_ms;
use crate::logs::Level;
use crate::process::{self, kill_tree, request_stop};
use crate::runtime::Runtime;

const READY_POLL: Duration = Duration::from_millis(250);
const PORT_WAIT: Duration = Duration::from_secs(5);
/// How long a service gets to exit after a stop request before its tree is killed.
const STOP_GRACE: Duration = Duration::from_secs(8);
const MAX_OUTPUT_LINE: u64 = 64 * 1024;
/// After an unexpected exit, survivors in the tree get this long before being killed.
const CRASH_DRAIN: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Api,
    Worker,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Api => "api",
            Kind::Worker => "worker",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServiceStatus {
    Stopped,
    Starting {
        attempt: u32,
    },
    Running {
        pid: u32,
        started_at: u64,
        restarts: u32,
    },
    Stopping,
    Failed {
        reason: String,
        at: u64,
    },
}

/// Automatic restarts after a crash: at most `max_restarts` within `window`, with exponential delay.
/// Beyond that the service stays `failed` until the user restarts it (no restart storms).
#[derive(Clone, Debug)]
pub struct RestartPolicy {
    pub max_restarts: usize,
    pub window: Duration,
    pub base_delay: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 3,
            window: Duration::from_secs(600),
            base_delay: Duration::from_secs(1),
        }
    }
}

impl RestartPolicy {
    /// Records a crash at `now`; returns the delay before restarting, or `None` if the budget is spent.
    pub fn next_delay(&self, history: &mut VecDeque<Instant>, now: Instant) -> Option<Duration> {
        while history
            .front()
            .is_some_and(|t| now.duration_since(*t) > self.window)
        {
            history.pop_front();
        }
        if history.len() >= self.max_restarts {
            return None;
        }
        history.push_back(now);
        Some(self.base_delay * 2u32.pow(history.len() as u32 - 1))
    }
}

struct Inner {
    status: ServiceStatus,
    pid: Option<u32>,
    generation: u64,
    crashes: VecDeque<Instant>,
    /// Whether the user/app wants this service up. Cleared by stop and by terminal failure.
    desired: bool,
    exited: Option<watch::Receiver<bool>>,
}

pub struct Service {
    pub port: u16,
    policy: RestartPolicy,
    startup_timeout: Duration,
    inner: Mutex<Inner>,
}

impl Service {
    pub fn new(port: u16, policy: RestartPolicy, startup_timeout: Duration) -> Self {
        Self {
            port,
            policy,
            startup_timeout,
            inner: Mutex::new(Inner {
                status: ServiceStatus::Stopped,
                pid: None,
                generation: 0,
                crashes: VecDeque::new(),
                desired: false,
                exited: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves plain data behind; keep going rather than poisoning the app.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> ServiceStatus {
        self.lock().status.clone()
    }

    pub fn pid(&self) -> Option<u32> {
        self.lock().pid
    }

    pub fn is_running(&self) -> bool {
        matches!(self.lock().status, ServiceStatus::Running { .. })
    }
}

/// Starts the service unless it is already starting or running (duplicate launches are no-ops).
/// `manual` resets the crash budget: an explicit user action always gets a fresh start.
pub async fn start(rt: Arc<Runtime>, kind: Kind, manual: bool) -> Result<(), String> {
    let svc = rt.service(kind);
    let generation = {
        let mut i = svc.lock();
        match i.status {
            ServiceStatus::Starting { .. } | ServiceStatus::Running { .. } => return Ok(()),
            ServiceStatus::Stopping => {
                return Err(format!(
                    "{} is stopping; try again in a moment",
                    kind.name()
                ));
            }
            ServiceStatus::Stopped | ServiceStatus::Failed { .. } => {}
        }
        if manual {
            i.crashes.clear();
        }
        i.desired = true;
        i.generation += 1;
        i.status = ServiceStatus::Starting {
            attempt: i.crashes.len() as u32 + 1,
        };
        i.generation
    };
    launch_or_fail(rt, kind, generation).await
}

pub async fn stop(rt: &Arc<Runtime>, kind: Kind) {
    let svc = rt.service(kind);
    let (pid, exited) = {
        let mut i = svc.lock();
        i.desired = false;
        match i.pid {
            None => {
                if !matches!(i.status, ServiceStatus::Failed { .. }) {
                    i.status = ServiceStatus::Stopped;
                }
                return;
            }
            Some(pid) => {
                i.status = ServiceStatus::Stopping;
                (pid, i.exited.clone())
            }
        }
    };
    rt.logs.event(
        Level::Info,
        "service.stop",
        "stopping service",
        json!({ "serviceName": kind.name(), "pid": pid }),
    );
    request_stop(pid);
    // Slightly longer than the monitor's own drain wait, which kills stragglers itself.
    if !wait_exit(exited.clone(), STOP_GRACE + Duration::from_secs(1)).await {
        rt.logs.event(
            Level::Warn,
            "service.kill",
            "service did not stop in time; killing process tree",
            json!({ "serviceName": kind.name(), "pid": pid }),
        );
        kill_tree(pid);
        wait_exit(exited, Duration::from_secs(3)).await;
    }
}

pub async fn restart(rt: Arc<Runtime>, kind: Kind) -> Result<(), String> {
    stop(&rt, kind).await;
    start(rt, kind, true).await
}

/// Boxed with an explicit `Send` bound: launch -> monitor -> (restart) -> launch is recursive,
/// which the compiler cannot prove `Send` on its own.
fn launch_or_fail(
    rt: Arc<Runtime>,
    kind: Kind,
    generation: u64,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
        let started = Instant::now();
        match launch(&rt, kind, generation).await {
            Ok(()) => {
                rt.logs.event(Level::Info, "service.ready", "service ready", json!({ "serviceName": kind.name(), "duration": started.elapsed().as_millis() as u64 }));
                Ok(())
            }
            Err(reason) => {
                fail(&rt, kind, generation, &reason);
                Err(reason)
            }
        }
    })
}

async fn launch(rt: &Arc<Runtime>, kind: Kind, generation: u64) -> Result<(), String> {
    let svc = rt.service(kind);
    if kind == Kind::Worker {
        let available = rt
            .probe
            .lock()
            .map(|mut p| p.available_memory_bytes())
            .unwrap_or(u64::MAX);
        if available < rt.min_worker_free_bytes {
            return Err(format!(
                "Not enough free memory to start the worker ({} MB available, {} MB required). Close other applications and try again.",
                available / 1_048_576,
                rt.min_worker_free_bytes / 1_048_576
            ));
        }
    }
    wait_for_free_port(svc.port).await?;
    let spec = rt.spawn_spec(kind)?;
    let mut child =
        process::spawn(&spec).map_err(|e| format!("failed to start {}: {e}", kind.name()))?;
    let Some(pid) = child.id() else {
        return Err(format!("{} exited immediately", kind.name()));
    };
    if let Some(out) = child.stdout.take() {
        pipe_output(rt.clone(), kind, false, out);
    }
    if let Some(err) = child.stderr.take() {
        pipe_output(rt.clone(), kind, true, err);
    }
    let (tx, exited) = watch::channel(false);
    {
        let mut i = svc.lock();
        if i.generation != generation || !i.desired {
            drop(i);
            kill_tree(pid);
            return Err("start cancelled".into());
        }
        i.pid = Some(pid);
        i.exited = Some(exited.clone());
    }
    rt.logs.event(
        Level::Info,
        "service.spawn",
        "service process started",
        json!({ "serviceName": kind.name(), "pid": pid, "port": svc.port }),
    );
    tokio::spawn(monitor(rt.clone(), kind, generation, pid, child, tx));

    let deadline = Instant::now() + svc.startup_timeout;
    loop {
        if *exited.borrow() {
            return Err(format!(
                "{} exited during startup; see its log for details",
                kind.name()
            ));
        }
        if !svc.lock().desired {
            return Err("start cancelled".into());
        }
        match probe(rt, kind).await {
            Ok(()) => break,
            Err(Probe::Fatal(reason)) => {
                kill_tree(pid);
                return Err(reason);
            }
            Err(Probe::NotYet) if Instant::now() > deadline => {
                kill_tree(pid);
                return Err(format!(
                    "{} did not become ready within {} s",
                    kind.name(),
                    svc.startup_timeout.as_secs()
                ));
            }
            Err(Probe::NotYet) => tokio::time::sleep(READY_POLL).await,
        }
    }
    let mut i = svc.lock();
    if i.generation == generation && matches!(i.status, ServiceStatus::Starting { .. }) {
        i.status = ServiceStatus::Running {
            pid,
            started_at: now_ms(),
            restarts: i.crashes.len() as u32,
        };
    }
    Ok(())
}

fn fail(rt: &Arc<Runtime>, kind: Kind, generation: u64, reason: &str) {
    let svc = rt.service(kind);
    let mut i = svc.lock();
    if i.generation != generation {
        return;
    }
    if let Some(pid) = i.pid.take() {
        kill_tree(pid);
    }
    i.exited = None;
    if i.desired {
        i.desired = false;
        i.status = ServiceStatus::Failed {
            reason: rt.logs.redact(reason),
            at: now_ms(),
        };
        drop(i);
        rt.logs.event(
            Level::Error,
            "service.fail",
            reason,
            json!({ "serviceName": kind.name() }),
        );
    } else {
        i.status = ServiceStatus::Stopped;
    }
}

/// Owns the child handle; reports its exit and decides whether a crash gets an automatic restart.
async fn monitor(
    rt: Arc<Runtime>,
    kind: Kind,
    generation: u64,
    pid: u32,
    mut child: Child,
    exited: watch::Sender<bool>,
) {
    let code = child.wait().await.ok().and_then(|s| s.code());
    let svc = rt.service(kind);
    // Let the rest of the tree finish (node under pnpm flushes and closes the DB), then sweep.
    let stopping = matches!(svc.lock().status, ServiceStatus::Stopping);
    let drain = if stopping { STOP_GRACE } else { CRASH_DRAIN };
    if !process::wait_tree_exit(pid, drain).await {
        kill_tree(pid);
    }
    let _ = exited.send(true);

    let restart_in = {
        let mut i = svc.lock();
        if i.generation != generation {
            return;
        }
        i.pid = None;
        i.exited = None;
        match i.status {
            ServiceStatus::Stopping => {
                i.status = ServiceStatus::Stopped;
                None
            }
            ServiceStatus::Running { .. } if i.desired => {
                match svc.policy.next_delay(&mut i.crashes, Instant::now()) {
                    Some(delay) => {
                        i.status = ServiceStatus::Starting {
                            attempt: i.crashes.len() as u32 + 1,
                        };
                        Some(delay)
                    }
                    None => {
                        i.desired = false;
                        i.status = ServiceStatus::Failed {
                            reason: format!(
                                "{} crashed {} times in {} min; restart it manually",
                                kind.name(),
                                svc.policy.max_restarts,
                                svc.policy.window.as_secs() / 60
                            ),
                            at: now_ms(),
                        };
                        None
                    }
                }
            }
            ServiceStatus::Running { .. } => {
                i.status = ServiceStatus::Stopped;
                None
            }
            // Starting/Failed: the launch path reports startup failures itself.
            _ => None,
        }
    };
    let level = if restart_in.is_some() || code != Some(0) {
        Level::Error
    } else {
        Level::Info
    };
    rt.logs.event(level, "service.exit", "service process exited", json!({ "serviceName": kind.name(), "pid": pid, "exitCode": code, "restartInMs": restart_in.map(|d| d.as_millis() as u64) }));

    if let Some(delay) = restart_in {
        tokio::time::sleep(delay).await;
        let next = {
            let mut i = svc.lock();
            if i.generation != generation || !i.desired {
                return;
            }
            i.generation += 1;
            i.generation
        };
        let _ = launch_or_fail(rt.clone(), kind, next).await;
    }
}

enum Probe {
    NotYet,
    Fatal(String),
}

async fn probe(rt: &Arc<Runtime>, kind: Kind) -> Result<(), Probe> {
    match kind {
        // An authenticated call proves the process on the port is *ours* (it knows this launch's secret).
        Kind::Api => match rt.api_call(reqwest::Method::GET, "/api/v1/version", None).await {
            Ok((200, _)) => Ok(()),
            Ok((401, _)) => Err(Probe::Fatal("The API on this port rejected this session's credentials (is another copy of ClipForge running?)".into())),
            _ => Err(Probe::NotYet),
        },
        Kind::Worker => {
            let url = format!("http://127.0.0.1:{}/health", rt.worker.port);
            let ok = match rt.http.get(url).timeout(Duration::from_secs(2)).send().await {
                Ok(res) if res.status().is_success() => res.json::<serde_json::Value>().await.is_ok_and(|v| v["status"] == "ok"),
                _ => false,
            };
            if ok { Ok(()) } else { Err(Probe::NotYet) }
        }
    }
}

/// A leftover process from a crashed session exits on its own within seconds (parent watchdog),
/// so wait briefly before declaring the port taken.
async fn wait_for_free_port(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + PORT_WAIT;
    loop {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "Port {port} is in use by another process. Close it or set a different port, then retry."
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

async fn wait_exit(rx: Option<watch::Receiver<bool>>, timeout: Duration) -> bool {
    let Some(mut rx) = rx else { return true };
    tokio::time::timeout(timeout, rx.wait_for(|done| *done))
        .await
        .is_ok()
}

fn pipe_output<R: AsyncRead + Unpin + Send + 'static>(
    rt: Arc<Runtime>,
    kind: Kind,
    stderr: bool,
    reader: R,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            // Bounded per read: a child that never prints a newline can't grow this buffer without limit.
            match (&mut reader)
                .take(MAX_OUTPUT_LINE)
                .read_until(b'\n', &mut buf)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) => rt
                    .logs
                    .child_line(kind.name(), stderr, &String::from_utf8_lossy(&buf)),
            }
        }
    });
}

/// Best-effort synchronous cleanup for the final exit path (no async runtime guarantees there).
pub fn kill_all_now(rt: &Runtime) {
    for svc in [&rt.api, &rt.worker] {
        let mut i = svc.lock();
        i.desired = false;
        if let Some(pid) = i.pid.take() {
            kill_tree(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::SessionSecret;
    use crate::logs::{LogConfig, LogHub};
    use crate::process::SpawnSpec;
    use crate::resources::{ResourceProbe, ResourceSnapshot};
    use crate::runtime::{Layout, Mode, RuntimeConfig};
    use std::path::Path;

    struct FakeProbe(u64);
    impl ResourceProbe for FakeProbe {
        fn available_memory_bytes(&mut self) -> u64 {
            self.0
        }
        fn snapshot(&mut self, _: &[(String, u32)], _: &Path) -> ResourceSnapshot {
            unimplemented!()
        }
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// A tiny worker stand-in: serves /health, optionally exits after `crash_after` seconds.
    fn worker_script(mode: &str) -> SpawnSpec {
        let code = r#"
import http.server, os, sys, threading, time
mode = sys.argv[1]
if mode == "exit": sys.exit(3)
if mode == "hang": time.sleep(60)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"status":"ok"}')
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", int(os.environ["CLIPFORGE_WORKER_PORT"])), H)
if mode == "crash": threading.Timer(0.3, lambda: os._exit(9)).start()
print('{"level":"info","msg":"fake worker up"}', flush=True)
srv.serve_forever()
"#;
        let python = which::which("python3").expect("python3 is required for lifecycle tests");
        SpawnSpec {
            program: python,
            args: vec!["-c".into(), code.into(), mode.into()],
            cwd: std::env::temp_dir(),
            env: vec![],
        }
    }

    fn runtime(mode: &str, free_memory: u64, dir: &Path) -> Arc<Runtime> {
        let layout = Layout::Fixed {
            api: worker_script(mode),
            worker: worker_script(mode),
        };
        let mut cfg =
            RuntimeConfig::from_env(Mode::Development, layout, dir.to_path_buf(), "test".into());
        cfg.worker_port = free_port();
        cfg.min_worker_free_bytes = 1024;
        cfg.startup_timeout = Duration::from_secs(5);
        cfg.worker_policy = RestartPolicy {
            max_restarts: 2,
            window: Duration::from_secs(60),
            base_delay: Duration::from_millis(50),
        };
        let logs = LogHub::new(LogConfig::from_env(dir.join("logs"), false), vec![]).unwrap();
        Arc::new(
            Runtime::new(
                cfg,
                SessionSecret::generate().unwrap(),
                logs,
                Box::new(FakeProbe(free_memory)),
            )
            .unwrap(),
        )
    }

    async fn until(rt: &Arc<Runtime>, pred: impl Fn(&ServiceStatus) -> bool) -> ServiceStatus {
        for _ in 0..200 {
            let s = rt.worker.status();
            if pred(&s) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "condition not reached; last status {:?}",
            rt.worker.status()
        );
    }

    #[test]
    fn restart_policy_is_bounded_and_backs_off() {
        let p = RestartPolicy {
            max_restarts: 2,
            window: Duration::from_secs(10),
            base_delay: Duration::from_secs(1),
        };
        let mut h = VecDeque::new();
        let t = Instant::now();
        assert_eq!(p.next_delay(&mut h, t), Some(Duration::from_secs(1)));
        assert_eq!(p.next_delay(&mut h, t), Some(Duration::from_secs(2)));
        assert_eq!(p.next_delay(&mut h, t), None);
        assert_eq!(
            p.next_delay(&mut h, t + Duration::from_secs(11)),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn status_serializes_as_the_shared_contract() {
        let s = ServiceStatus::Running {
            pid: 7,
            started_at: 1,
            restarts: 0,
        };
        assert_eq!(
            serde_json::to_value(s).unwrap(),
            json!({ "state": "running", "pid": 7, "startedAt": 1, "restarts": 0 })
        );
        assert_eq!(
            serde_json::to_value(ServiceStatus::Stopped).unwrap(),
            json!({ "state": "stopped" })
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starts_once_stops_cleanly_and_never_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime("ok", u64::MAX, dir.path());
        start(rt.clone(), Kind::Worker, true).await.unwrap();
        let ServiceStatus::Running { pid, .. } = rt.worker.status() else {
            panic!("not running")
        };
        start(rt.clone(), Kind::Worker, true).await.unwrap(); // duplicate request: no second process
        assert_eq!(rt.worker.pid(), Some(pid));
        stop(&rt, Kind::Worker).await;
        assert_eq!(rt.worker.status(), ServiceStatus::Stopped);
        assert!(
            TcpListener::bind(("127.0.0.1", rt.worker.port)).is_ok(),
            "port released"
        );
        let log = std::fs::read_to_string(dir.path().join("logs").join("worker.log")).unwrap();
        assert!(log.contains("fake worker up"), "child output captured");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn crashes_are_restarted_within_budget_then_reported() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime("crash", u64::MAX, dir.path());
        start(rt.clone(), Kind::Worker, true).await.unwrap();
        let failed = until(&rt, |s| matches!(s, ServiceStatus::Failed { .. })).await;
        let ServiceStatus::Failed { reason, .. } = failed else {
            unreachable!()
        };
        assert!(reason.contains("crashed 2 times"), "{reason}");
        assert_eq!(rt.worker.pid(), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reports_startup_failure_and_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime("exit", u64::MAX, dir.path());
        let err = start(rt.clone(), Kind::Worker, true).await.unwrap_err();
        assert!(err.contains("exited during startup"), "{err}");
        assert!(matches!(rt.worker.status(), ServiceStatus::Failed { .. }));

        let rt = runtime("hang", u64::MAX, dir.path());
        let err = start(rt.clone(), Kind::Worker, true).await.unwrap_err();
        assert!(err.contains("did not become ready"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_to_start_without_enough_memory_or_with_a_taken_port() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime("ok", 10, dir.path());
        let err = start(rt.clone(), Kind::Worker, true).await.unwrap_err();
        assert!(err.contains("Not enough free memory"), "{err}");

        let rt = runtime("ok", u64::MAX, dir.path());
        let _squatter = TcpListener::bind(("127.0.0.1", rt.worker.port)).unwrap();
        let err = start(rt.clone(), Kind::Worker, true).await.unwrap_err();
        assert!(err.contains("in use"), "{err}");
    }
}
