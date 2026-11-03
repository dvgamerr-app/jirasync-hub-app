// The agent part of a run: write the task context, plan (read-only) → owner approves →
// implement → the app runs the final checks itself → repair rounds → ready for review.
// Each step is one CLI invocation that resumes the same session the app chose up front.
use super::claude::{self, AgentLauncher, Invocation, Session};
use super::exec::git;
use super::mcp::McpServer;
use super::repo::CommandSpec;
use super::run::{run_step, Control, EventKind, Journal, RunStatus, Step, StepOutcome};
use super::tools::{Phase, RunTools};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const AGENT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_REPAIRS: u32 = 2;
const MAX_CONTEXT_BYTES: usize = 200 * 1024;
const MAX_PROGRESS_CHARS: usize = 20_000;
const FAILURE_TAIL_LINES: usize = 30;
/// Files whose change means the dependencies must be installed again before the checks.
const MANIFESTS: &[&str] = &[
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "pyproject.toml",
    "uv.lock",
    "requirements.txt",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub log_id: String,
    pub duration_ms: u64,
}

/// What every agent run shares: how to start the agent, the app's skills, the MCP server.
pub struct AgentEnv {
    pub launcher: AgentLauncher,
    pub skills_dir: PathBuf,
    /// Working-time budget per owner-approved step; time the app spends executing is excluded.
    pub budget: Duration,
    pub model: Option<String>,
    mcp: OnceLock<McpServer>,
}

impl AgentEnv {
    pub fn new(launcher: AgentLauncher, skills_dir: PathBuf, budget: Duration) -> Self {
        Self {
            launcher,
            skills_dir,
            budget,
            model: None,
            mcp: OnceLock::new(),
        }
    }

    fn mcp(&self) -> Result<&McpServer, String> {
        if let Some(server) = self.mcp.get() {
            return Ok(server);
        }
        let server = McpServer::start()?;
        Ok(self.mcp.get_or_init(|| server))
    }
}

pub(super) struct AgentRun<'a> {
    pub journal: &'a Arc<Journal>,
    pub control: &'a Arc<Control>,
    pub env: &'a AgentEnv,
    pub run_dir: &'a Path,
}

fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl AgentRun<'_> {
    fn worktree(&self) -> Result<PathBuf, String> {
        let record = self.journal.record();
        record
            .worktree
            .filter(|_| !record.worktree_removed)
            .map(|info| PathBuf::from(info.path))
            .ok_or_else(|| "this run has no worktree".into())
    }

    /// Writes `.harness/task.md` (the ticket snapshot the agent works from) and keeps
    /// `.harness/` out of git so it never lands in a commit.
    pub fn write_context(&self, markdown: &str) -> Result<(), String> {
        if markdown.len() > MAX_CONTEXT_BYTES {
            return Err("the task context is too large".into());
        }
        let worktree = self.worktree()?;
        let dir = worktree.join(".harness");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(dir.join("task.md"), markdown).map_err(|e| e.to_string())?;

        let common = git(
            &["rev-parse", "--git-common-dir"],
            &worktree,
            Duration::from_secs(20),
        )?;
        let common = Path::new(&common);
        let common = if common.is_absolute() {
            common.to_path_buf()
        } else {
            worktree.join(common)
        };
        let exclude = common.join("info").join("exclude");
        let current = fs::read_to_string(&exclude).unwrap_or_default();
        if !current.lines().any(|line| line.trim() == ".harness/") {
            fs::create_dir_all(exclude.parent().unwrap()).map_err(|e| e.to_string())?;
            let separator = if current.is_empty() || current.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            fs::write(&exclude, format!("{current}{separator}.harness/\n"))
                .map_err(|e| e.to_string())?;
        }
        let snapshot = digest(markdown);
        self.journal
            .update(|record| record.context_digest = Some(snapshot));
        Ok(())
    }

    fn invoke(&self, phase: Phase, prompt: &str) -> Result<(StepOutcome, Arc<RunTools>), String> {
        let record = self.journal.record();
        let worktree = self.worktree()?;
        let tools = Arc::new(RunTools::new(
            self.journal.clone(),
            self.control.clone(),
            worktree.clone(),
            record.commands.clone(),
            self.env.skills_dir.clone(),
        ));
        tools.set_phase(phase);
        let mcp = self.env.mcp()?;
        let token = mcp.register(tools.clone());
        let config_path = self.run_dir.join("mcp.json");
        let config = mcp.client_config(&token).to_string();
        let result = fs::write(&config_path, config)
            .map_err(|e| e.to_string())
            .and_then(|_| self.run_agent(&tools, phase, prompt, &worktree, &config_path));
        mcp.unregister(&token);
        let _ = fs::remove_file(&config_path);
        tools.shutdown();
        result.map(|outcome| (outcome, tools))
    }

    fn run_agent(
        &self,
        tools: &RunTools,
        phase: Phase,
        prompt: &str,
        worktree: &Path,
        config_path: &Path,
    ) -> Result<StepOutcome, String> {
        let existing = self.journal.record().session_id;
        let session_id = existing.clone().unwrap_or_else(claude::new_session_id);
        if existing.is_none() {
            let id = session_id.clone();
            self.journal.update(|record| record.session_id = Some(id));
        }
        let config = config_path.display().to_string();
        let cli_args = claude::args(&Invocation {
            prompt,
            session: if existing.is_some() {
                Session::Resume(&session_id)
            } else {
                Session::New(&session_id)
            },
            tools: if phase == Phase::Planning {
                claude::PLANNING_TOOLS
            } else {
                claude::IMPLEMENTING_TOOLS
            },
            mcp_config: &config,
            model: self.env.model.as_deref(),
        });
        let launcher = &self.env.launcher;
        let mut env = launcher.env.clone();
        // Harness tools (tests, builds) can legitimately take many minutes.
        env.push(("MCP_TOOL_TIMEOUT".into(), (30 * 60 * 1000).to_string()));
        let mut args = launcher.prefix_args.clone();
        match &launcher.args_env {
            Some(name) => env.push((name.clone(), serde_json::to_string(&cli_args).unwrap())),
            None => args.extend(cli_args),
        }
        let command = CommandSpec {
            executable: launcher.executable.display().to_string(),
            args,
        };

        let budget = self.env.budget;
        let started = Instant::now();
        let exec_at_start = tools.exec_ms();
        let ai_time = || {
            let exec = Duration::from_millis(tools.exec_ms() - exec_at_start);
            started.elapsed().saturating_sub(exec)
        };
        let over_budget = || ai_time() > budget;
        let step = Step {
            name: "agent",
            command: &command,
            cwd: worktree,
            timeout: AGENT_TIMEOUT,
            env: &env,
            parse_stdout: Some(claude::parse_stream_line),
            over_budget: Some(&over_budget),
        };
        let outcome = run_step(self.journal, self.control, &step);
        let spent = ai_time().as_millis() as u64;
        self.journal.update(|record| record.ai_ms += spent);
        outcome
    }

    fn agent_outcome(&self, outcome: StepOutcome) -> Result<Option<RunStatus>, String> {
        match outcome {
            StepOutcome::Exited(0) => Ok(None),
            StepOutcome::Exited(code) => Err(format!("the agent exited with code {code}")),
            StepOutcome::Cancelled => Ok(Some(RunStatus::Cancelled)),
            StepOutcome::OverBudget => Err(format!(
                "the agent used its {}-minute working-time budget",
                self.env.budget.as_secs() / 60
            )),
            StepOutcome::TimedOut => Err("the agent did not finish in time".into()),
        }
    }

    /// Read-only planning. Ends waiting for the owner with the submitted plan.
    pub fn plan(&self, feedback: Option<&str>) -> Result<RunStatus, String> {
        self.journal.set_status(RunStatus::Planning, None);
        let issue_key = self.journal.record().issue_key;
        let prompt = match feedback {
            Some(feedback) => claude::revise_plan_prompt(feedback),
            None => claude::planning_prompt(&issue_key),
        };
        let (outcome, tools) = self.invoke(Phase::Planning, &prompt)?;
        if let Some(status) = self.agent_outcome(outcome)? {
            return Ok(status);
        }
        let plan = tools
            .take_plan()
            .ok_or("the agent finished without submitting a plan")?;
        self.journal.update(|record| record.plan = Some(plan));
        Ok(RunStatus::AwaitingPlan)
    }

    /// Implement → final checks by the app → up to two repair rounds → ready for review.
    pub fn implement(&self, first_prompt: String) -> Result<RunStatus, String> {
        let mut prompt = first_prompt;
        let mut repairs = 0;
        loop {
            self.journal.set_status(RunStatus::Running, None);
            let (outcome, _) = self.invoke(Phase::Implementing, &prompt)?;
            if let Some(status) = self.agent_outcome(outcome)? {
                return Ok(status);
            }
            self.journal.set_status(RunStatus::Verifying, None);
            let checks = self.verify()?;
            let worktree = self.worktree()?;
            let changed = changed_files(&worktree)?;
            let progress = fs::read_to_string(worktree.join(".harness/progress.md"))
                .ok()
                .map(|text| text.chars().take(MAX_PROGRESS_CHARS).collect::<String>());
            let failed: Vec<CheckResult> = checks
                .iter()
                .filter(|check| check.status != "passed")
                .cloned()
                .collect();
            self.journal.update(|record| {
                record.checks = checks;
                record.changed_files = changed;
                record.progress = progress;
            });
            if self.control.cancelled() {
                return Ok(RunStatus::Cancelled);
            }
            if failed.is_empty() {
                return Ok(RunStatus::ReadyForReview);
            }
            let names = failed
                .iter()
                .map(|check| check.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if repairs >= MAX_REPAIRS {
                return Err(format!(
                    "checks still fail after {MAX_REPAIRS} repair rounds: {names}"
                ));
            }
            repairs += 1;
            self.journal.update(|record| record.attempts += 1);
            prompt = claude::repair_prompt(&self.failure_report(&failed));
        }
    }

    fn failure_report(&self, failed: &[CheckResult]) -> String {
        failed
            .iter()
            .map(|check| {
                let lines = self.journal.step_lines(&check.log_id);
                let tail = lines[lines.len().saturating_sub(FAILURE_TAIL_LINES)..].join("\n");
                let code = check
                    .exit_code
                    .map_or_else(|| check.status.clone(), |code| format!("exit code {code}"));
                format!("### {} ({code})\n```\n{tail}\n```", check.name)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The app's own checks; the agent's claims about tests never count as results.
    fn verify(&self) -> Result<Vec<CheckResult>, String> {
        let worktree = self.worktree()?;
        let commands = self.journal.record().commands;
        let mut results = Vec::new();
        let manifest_changed = changed_files(&worktree)?.iter().any(|file| {
            let name = Path::new(file)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            MANIFESTS.contains(&name.as_str())
        });
        let mut planned: Vec<(&str, &CommandSpec)> = Vec::new();
        if manifest_changed {
            if let Some(install) = commands.install.as_ref() {
                planned.push(("install", install));
            }
        }
        for (name, command) in [
            ("build", commands.build.as_ref()),
            ("lint", commands.lint.as_ref()),
            ("test", commands.test.as_ref()),
        ] {
            if let Some(command) = command {
                planned.push((name, command));
            }
        }
        if planned.is_empty() {
            self.journal.push(EventKind::Output {
                step: "verify".into(),
                stream: "stderr".into(),
                text: "no build, lint or test command is set for this repository".into(),
            });
        }
        for (name, command) in planned {
            let log_id = format!("verify:{name}");
            let started = Instant::now();
            let outcome = run_step(
                self.journal,
                self.control,
                &Step::new(&log_id, command, &worktree, CHECK_TIMEOUT),
            )?;
            let (status, exit_code) = match outcome {
                StepOutcome::Exited(0) => ("passed", Some(0)),
                StepOutcome::Exited(code) => ("failed", Some(code)),
                StepOutcome::Cancelled => return Err("stopped".into()),
                StepOutcome::TimedOut | StepOutcome::OverBudget => ("timed_out", None),
            };
            results.push(CheckResult {
                name: name.into(),
                status: status.into(),
                exit_code,
                log_id,
                duration_ms: started.elapsed().as_millis() as u64,
            });
            // A failed install makes the remaining checks meaningless.
            if name == "install" && status != "passed" {
                break;
            }
        }
        Ok(results)
    }
}

/// Changed and new files in the worktree, excluding the harness scratch folder.
pub fn changed_files(worktree: &Path) -> Result<Vec<String>, String> {
    let status = git(
        &["status", "--porcelain=v1", "-uall"],
        worktree,
        Duration::from_secs(30),
    )?;
    Ok(status
        .lines()
        .filter_map(|line| line.get(3..))
        .map(|path| path.trim_matches('"').replace('\\', "/"))
        .filter(|path| !path.starts_with(".harness/"))
        .collect())
}

#[cfg(test)]
#[path = "agent_tests.rs"]
mod tests;
