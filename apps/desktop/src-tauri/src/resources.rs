//! Resource monitoring behind a small platform abstraction.
//!
//! `ResourceProbe` is what the runtime depends on; `SysinfoProbe` implements it for macOS and
//! Windows (and Linux) via the `sysinfo` crate, which owns the per-OS system calls. Tests use a fake.
//! A future model lifecycle manager will consult the same probe before loading a model.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Pid, ProcessesToUpdate, RefreshKind, System,
};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    pub name: String,
    pub pid: u32,
    /// Resident memory of the process and all of its descendants.
    pub memory_bytes: u64,
    pub cpu_percent: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
    pub cpu_count: usize,
    pub cpu_brand: String,
    pub global_cpu_percent: f32,
    pub disk_available_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    pub processes: Vec<ProcessUsage>,
}

pub trait ResourceProbe: Send {
    fn available_memory_bytes(&mut self) -> u64;
    /// `tracked` lists (display name, root pid). Kept cheap: called on demand, never in a loop.
    fn snapshot(&mut self, tracked: &[(String, u32)], data_dir: &Path) -> ResourceSnapshot;
}

pub struct SysinfoProbe {
    sys: System,
}

impl SysinfoProbe {
    pub fn new() -> Result<Self, sysinfo::Error> {
        let kind = RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything());
        Ok(Self {
            sys: System::new_with_specifics(kind)?,
        })
    }
}

impl ResourceProbe for SysinfoProbe {
    fn available_memory_bytes(&mut self) -> u64 {
        self.sys.refresh_memory();
        self.sys.available_memory()
    }

    fn snapshot(&mut self, tracked: &[(String, u32)], data_dir: &Path) -> ResourceSnapshot {
        self.sys.refresh_memory();
        self.sys.refresh_cpu_usage();
        self.sys.refresh_processes(ProcessesToUpdate::All, true);

        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in self.sys.processes() {
            if let Some(parent) = p.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        let processes = tracked
            .iter()
            .filter_map(|(name, pid)| {
                let root = Pid::from_u32(*pid);
                self.sys.process(root)?;
                let (memory_bytes, cpu_percent) = tree(root, &children)
                    .into_iter()
                    .filter_map(|p| self.sys.process(p))
                    .fold((0, 0.0), |(m, c), p| (m + p.memory(), c + p.cpu_usage()));
                Some(ProcessUsage {
                    name: name.clone(),
                    pid: *pid,
                    memory_bytes,
                    cpu_percent,
                })
            })
            .collect();

        let (disk_available_bytes, disk_total_bytes) = disk_for(data_dir);
        let cpus = self.sys.cpus();
        ResourceSnapshot {
            total_memory_bytes: self.sys.total_memory(),
            available_memory_bytes: self.sys.available_memory(),
            cpu_count: cpus.len(),
            cpu_brand: cpus
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_default(),
            global_cpu_percent: self.sys.global_cpu_usage(),
            disk_available_bytes,
            disk_total_bytes,
            processes,
        }
    }
}

/// Root plus all descendants (iterative; cycles are impossible in a process tree but guarded anyway).
fn tree(root: Pid, children: &HashMap<Pid, Vec<Pid>>) -> Vec<Pid> {
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        if let Some(kids) = children.get(&out[i]) {
            out.extend(
                kids.iter()
                    .filter(|k| !out.contains(k))
                    .copied()
                    .collect::<Vec<_>>(),
            );
        }
        i += 1;
    }
    out
}

/// The disk holding the data directory: the mount point with the longest matching prefix.
fn disk_for(dir: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(disks) = Disks::new_with_refreshed_list() else {
        return (None, None);
    };
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    disks
        .iter()
        .filter(|d| dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map_or((None, None), |d| {
            (Some(d.available_space()), Some(d.total_space()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_collects_descendants() {
        let p = Pid::from_u32;
        let children = HashMap::from([(p(1), vec![p(2), p(3)]), (p(3), vec![p(4)])]);
        let mut all = tree(p(1), &children);
        all.sort();
        assert_eq!(all, vec![p(1), p(2), p(3), p(4)]);
    }

    #[test]
    fn real_probe_reports_this_process() {
        let mut probe = SysinfoProbe::new().unwrap();
        let snap = probe.snapshot(
            &[("desktop".into(), std::process::id())],
            &std::env::temp_dir(),
        );
        assert!(snap.total_memory_bytes > 0);
        assert_eq!(snap.processes.len(), 1);
        assert!(snap.processes[0].memory_bytes > 0);
    }
}
