// Doctor: checks that the tools a harness run depends on really start, not only that a file
// with the right name exists on PATH (a broken install can still be found on PATH).
use super::exec::{resolve_executable, run};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    pub name: String,
    /// Required tools block a run when they fail; optional ones only disable a feature.
    pub required: bool,
    pub purpose: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerCheck {
    pub context: Option<String>,
    pub endpoint: Option<String>,
    pub server_version: Option<String>,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub tools: Vec<ToolCheck>,
    pub docker: DockerCheck,
    /// True when every required tool works.
    pub ready: bool,
    pub checked_at: u64,
}

struct Probe {
    name: &'static str,
    required: bool,
    purpose: &'static str,
    version_args: &'static [&'static str],
}

const PROBES: &[Probe] = &[
    Probe {
        name: "git",
        required: true,
        purpose: "Worktrees, diffs and commits",
        version_args: &["--version"],
    },
    Probe {
        name: "claude",
        required: true,
        purpose: "Coding agent (Claude Code CLI)",
        version_args: &["--version"],
    },
    Probe {
        name: "codex",
        required: false,
        purpose: "Coding agent (Codex CLI), instead of Claude",
        version_args: &["--version"],
    },
    Probe {
        name: "gh",
        required: true,
        purpose: "Push and open Draft PRs",
        version_args: &["--version"],
    },
    Probe {
        name: "hurl",
        required: false,
        purpose: "HTTP checks requested by the agent",
        version_args: &["--version"],
    },
];

fn check_tool(probe: &Probe) -> ToolCheck {
    let mut check = ToolCheck {
        name: probe.name.into(),
        required: probe.required,
        purpose: probe.purpose.into(),
        path: None,
        version: None,
        ok: false,
        detail: None,
    };
    let Some(path) = resolve_executable(probe.name) else {
        check.detail = Some(format!("{} was not found on PATH", probe.name));
        return check;
    };
    check.path = Some(path.display().to_string());
    match run(&path, probe.version_args, None, PROBE_TIMEOUT) {
        Ok(output) if output.ok() => {
            check.version = output.first_line();
            check.ok = true;
        }
        Ok(output) => {
            check.detail = Some(format!("found but could not start: {}", output.failure()))
        }
        Err(error) => check.detail = Some(error),
    }
    if check.ok && probe.name == "gh" {
        // `gh auth status` exits non-zero when no account is logged in.
        match run(&path, &["auth", "status"], None, PROBE_TIMEOUT) {
            Ok(output) if output.ok() => {}
            _ => {
                check.ok = false;
                check.detail = Some("not logged in: run `gh auth login`".into());
            }
        }
    }
    check
}

fn check_docker() -> DockerCheck {
    let mut check = DockerCheck {
        context: None,
        endpoint: None,
        server_version: None,
        ok: false,
        detail: None,
    };
    let Some(docker) = resolve_executable("docker") else {
        check.detail = Some("docker CLI was not found on PATH".into());
        return check;
    };
    // The endpoint comes from the current Docker context; its port can change between restarts.
    if let Ok(output) = run(&docker, &["context", "show"], None, PROBE_TIMEOUT) {
        if output.ok() {
            check.context = output.first_line();
        }
    }
    if let Some(context) = &check.context {
        let args = [
            "context",
            "inspect",
            context.as_str(),
            "--format",
            "{{.Endpoints.docker.Host}}",
        ];
        if let Ok(output) = run(&docker, &args, None, PROBE_TIMEOUT) {
            if output.ok() {
                check.endpoint = output.first_line();
            }
        }
    }
    match run(
        &docker,
        &["version", "--format", "{{.Server.Version}}"],
        None,
        PROBE_TIMEOUT,
    ) {
        Ok(output) if output.ok() => {
            check.server_version = output.first_line();
            check.ok = check.server_version.is_some();
        }
        Ok(output) => {
            check.detail = Some(format!(
                "cannot reach the Docker engine: {}",
                output.failure()
            ))
        }
        Err(error) => check.detail = Some(error),
    }
    check
}

pub fn run_doctor() -> DoctorReport {
    let (tools, docker) = std::thread::scope(|scope| {
        let handles: Vec<_> = PROBES
            .iter()
            .map(|probe| scope.spawn(move || check_tool(probe)))
            .collect();
        let docker = scope.spawn(check_docker);
        let tools: Vec<ToolCheck> = handles
            .into_iter()
            .map(|handle| handle.join().expect("tool probe panicked"))
            .collect();
        (tools, docker.join().expect("docker probe panicked"))
    });
    let ready = tools.iter().all(|tool| tool.ok || !tool.required);
    DoctorReport {
        tools,
        docker,
        ready,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_is_reported_working() {
        let report = run_doctor();
        let git = report.tools.iter().find(|tool| tool.name == "git").unwrap();
        assert!(git.ok, "{:?}", git.detail);
        assert!(git
            .version
            .as_deref()
            .unwrap_or("")
            .starts_with("git version"));
    }

    #[test]
    fn missing_required_tool_is_not_ready() {
        let probe = Probe {
            name: "definitely-not-a-real-tool-4f2a",
            required: true,
            purpose: "test",
            version_args: &["--version"],
        };
        let check = check_tool(&probe);
        assert!(!check.ok);
        assert!(check.detail.unwrap().contains("not found"));
    }
}
