// The agent part of a run: write the task context, plan (read-only) → owner approves →
// implement → the app runs the final checks itself → repair rounds → ready for review.
// Each step is one CLI invocation that resumes the same session the app chose up front.
use super::claude::{self, AgentLauncher, Invocation, Session};
use super::codex::{self, AppServer};
use super::docker::{self, DockerEndpoint, EnvVar};
use super::exec::git;
use super::mcp::McpServer;
use super::repo::CommandSpec;
use super::run::{run_step, Control, EventKind, Journal, RunStatus, Step, StepOutcome};
use super::tools::{AgentReview, Phase, PrDraft, RunTools};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// How `codex` is started for runs that use Codex (a fake app-server in tests).
    pub codex: AgentLauncher,
    /// How `gh` is started for publishing (a fake in tests).
    pub gh: AgentLauncher,
    /// Docker engine for service containers; `None` reads the current Docker context.
    pub docker: Option<DockerEndpoint>,
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
            gh: AgentLauncher::plain(PathBuf::from("gh")),
            codex: AgentLauncher::plain(PathBuf::from("codex")),
            docker: None,
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
        let config = mcp.client_config(&token);
        let result = if record.provider == "codex" {
            let url = config["mcpServers"]["harness"]["url"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            self.run_codex(&tools, phase, prompt, &worktree, &url, &token)
        } else {
            fs::write(&config_path, config.to_string())
                .map_err(|e| e.to_string())
                .and_then(|_| self.run_agent(&tools, phase, prompt, &worktree, &config_path))
        };
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
        // The reviewer is independent: a fresh session that never sees the implementer's
        // reasoning, only the task, the diff and the checks.
        let existing = if phase == Phase::Reviewing {
            None
        } else {
            self.journal.record().session_id
        };
        let session_id = existing.clone().unwrap_or_else(claude::new_session_id);
        if existing.is_none() && phase != Phase::Reviewing {
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
            // Only implementing may edit files; every other step is read-only.
            tools: if phase == Phase::Implementing {
                claude::IMPLEMENTING_TOOLS
            } else {
                claude::PLANNING_TOOLS
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
            ..CommandSpec::default()
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
            keep_secrets: false,
            over_budget: Some(&over_budget),
        };
        let outcome = run_step(self.journal, self.control, &step);
        let spent = ai_time().as_millis() as u64;
        self.journal.update(|record| record.ai_ms += spent);
        outcome
    }

    /// One Codex turn through `codex app-server`, under the same rules as Claude: the app
    /// declines every shell command, accepts file changes only while implementing and only
    /// inside the worktree, and lets the agent reach only the harness MCP server.
    fn run_codex(
        &self,
        tools: &RunTools,
        phase: Phase,
        prompt: &str,
        worktree: &Path,
        mcp_url: &str,
        token: &str,
    ) -> Result<StepOutcome, String> {
        const TOKEN_ENV: &str = "JIRASYNC_MCP_TOKEN";
        self.journal.push(EventKind::StepStart {
            step: "agent".into(),
            command: "codex app-server".into(),
        });
        let started = Instant::now();
        let exec_at_start = tools.exec_ms();
        let ai_time = || {
            let exec = Duration::from_millis(tools.exec_ms() - exec_at_start);
            started.elapsed().saturating_sub(exec)
        };
        let env = [(TOKEN_ENV.to_string(), token.to_string())];
        let outcome = AppServer::start(&self.env.codex, worktree, &env).and_then(|mut server| {
            self.control.track(server.pid());
            let outcome = self.codex_turn(
                &mut server,
                phase,
                prompt,
                worktree,
                mcp_url,
                TOKEN_ENV,
                &ai_time,
            );
            self.control.untrack(server.pid());
            outcome
        });
        let spent = ai_time().as_millis() as u64;
        self.journal.update(|record| record.ai_ms += spent);
        self.journal.push(EventKind::StepEnd {
            step: "agent".into(),
            exit_code: match outcome {
                Ok(StepOutcome::Exited(code)) => Some(code),
                Err(_) => Some(1),
                _ => None,
            },
            duration_ms: started.elapsed().as_millis() as u64,
        });
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn codex_turn(
        &self,
        server: &mut AppServer,
        phase: Phase,
        prompt: &str,
        worktree: &Path,
        mcp_url: &str,
        token_env: &str,
        ai_time: &dyn Fn() -> Duration,
    ) -> Result<StepOutcome, String> {
        let writable = phase == Phase::Implementing;
        let mut params = codex::thread_params(
            worktree,
            mcp_url,
            token_env,
            writable,
            claude::SYSTEM_PROMPT,
        );
        // The reviewer is independent: a fresh thread, never the implementer's.
        let existing = if phase == Phase::Reviewing {
            None
        } else {
            self.journal.record().session_id
        };
        let thread_id = match existing {
            Some(id) => {
                params["threadId"] = Value::String(id.clone());
                server.call("thread/resume", params, Duration::from_secs(120))?;
                id
            }
            None => {
                let thread = server.call("thread/start", params, Duration::from_secs(120))?;
                let id = thread
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .ok_or("codex did not return a thread id")?
                    .to_string();
                if phase != Phase::Reviewing {
                    let saved = id.clone();
                    self.journal
                        .update(|record| record.session_id = Some(saved));
                }
                id
            }
        };
        let policy = codex::TurnPolicy {
            worktree,
            allow_file_changes: writable,
        };
        let budget = self.env.budget;
        let stop = || {
            if self.control.cancelled() {
                Some("cancelled")
            } else if ai_time() > budget {
                Some("over_budget")
            } else {
                None
            }
        };
        let journal = self.journal;
        let mut on_event = |kind: &str, value: &Value| {
            let agent = |kind: &str, text: String| EventKind::Agent {
                kind: kind.into(),
                text: text.chars().take(4000).collect(),
            };
            match kind {
                "decision" => {
                    let what = value["kind"].as_str().unwrap_or("");
                    let detail = value["detail"].as_str().unwrap_or("");
                    let tool = match what {
                        "command" => format!("Shell {detail}"),
                        "file" => format!("Edit {detail}"),
                        "mcp" => format!("mcp {detail}"),
                        other => other.to_string(),
                    };
                    journal.push(EventKind::Permission {
                        tool: tool.chars().take(300).collect(),
                        decision: if value["allowed"].as_bool() == Some(true) {
                            "allow"
                        } else {
                            "deny"
                        }
                        .into(),
                    });
                }
                "item/started" => {
                    if let (Some(name), Some(arguments)) =
                        (value["tool"].as_str(), value.get("arguments"))
                    {
                        journal.push(agent("tool", claude::tool_summary(name, arguments)));
                    }
                }
                "item/completed" if value["type"] == "agentMessage" => {
                    if let Some(text) = value["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        journal.push(agent("text", text.to_string()));
                    }
                }
                "error" => journal.push(EventKind::Output {
                    step: "agent".into(),
                    stream: "stderr".into(),
                    text: value.to_string().chars().take(1000).collect(),
                }),
                _ => {}
            }
        };
        let report = match server.run_turn(
            &thread_id,
            prompt,
            &policy,
            &mut on_event,
            &stop,
            AGENT_TIMEOUT,
        ) {
            Ok(report) => report,
            Err(error) if error.contains("timed out") => return Ok(StepOutcome::TimedOut),
            Err(error) => return Err(error),
        };
        self.journal.push(EventKind::Agent {
            kind: "result".into(),
            text: format!("{} · codex", report.status),
        });
        Ok(match report.status.as_str() {
            "completed" => StepOutcome::Exited(0),
            "cancelled" => StepOutcome::Cancelled,
            "over_budget" => StepOutcome::OverBudget,
            _ => StepOutcome::Exited(1),
        })
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

    /// A setup command (`install`, `migrate`) failed: the agent fixes the cause itself, in the
    /// repo or in the command, and the app runs the command again; the owner is not asked.
    /// Gives up after `MAX_REPAIRS` rounds. `Err("stopped")` when the owner stopped the run.
    fn repair_setup(&self, name: &str) -> Result<(), String> {
        let worktree = self.worktree()?;
        for _ in 0..MAX_REPAIRS {
            self.journal.update(|record| record.attempts += 1);
            self.journal.push(EventKind::Agent {
                kind: "notice".into(),
                text: format!("{name} failed; the agent is fixing it"),
            });
            self.journal.set_status(RunStatus::Running, None);
            let lines = self.journal.step_lines(name);
            let tail = lines[lines.len().saturating_sub(FAILURE_TAIL_LINES)..].join("\n");
            let (outcome, _) = self.invoke(
                Phase::Implementing,
                &claude::setup_repair_prompt(name, &tail),
            )?;
            if self.agent_outcome(outcome)?.is_some() {
                return Err("stopped".into());
            }
            // The agent may have replaced the command; run what the record has now.
            let command = self
                .journal
                .record()
                .commands
                .slot_mut(name)
                .cloned()
                .flatten();
            let Some(command) = command else {
                return Ok(());
            };
            match run_step(
                self.journal,
                self.control,
                &Step::new(name, &command, &worktree, CHECK_TIMEOUT),
            )? {
                StepOutcome::Exited(0) => return Ok(()),
                StepOutcome::Cancelled => return Err("stopped".into()),
                _ => {}
            }
        }
        Err(format!(
            "{name} still fails after {MAX_REPAIRS} repair rounds"
        ))
    }

    /// Install failed while preparing the worktree: repaired by the agent before it plans.
    pub fn repair_install(&self) -> Result<Option<RunStatus>, String> {
        match self.repair_setup("install") {
            Ok(()) => Ok(None),
            Err(_) if self.control.cancelled() => Ok(Some(RunStatus::Cancelled)),
            Err(error) => Err(error),
        }
    }

    /// Starts the run's service containers, writes the per-run env values into the worktree
    /// `.env`, runs migrations, does `work`, then always removes the containers. With
    /// `repair`, a failed migration goes to the agent to fix instead of failing the run.
    fn with_services<T>(
        &self,
        repair: bool,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let record = self.journal.record();
        let migrate = record.commands.migrate.clone();
        if record.services.is_empty() && record.env_overrides.is_empty() && migrate.is_none() {
            return work();
        }
        let worktree = self.worktree()?;
        let mut running = Vec::new();
        let endpoint = if record.services.is_empty() {
            None
        } else {
            let endpoint = match &self.env.docker {
                Some(endpoint) => endpoint.clone(),
                None => DockerEndpoint::from_context()?,
            };
            self.journal.push(EventKind::StepStart {
                step: "services".into(),
                command: format!(
                    "docker: {}",
                    record
                        .services
                        .iter()
                        .map(|s| format!("{} ({})", s.name, s.image))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
            let started = Instant::now();
            let _ = docker::remove_leftovers(&endpoint);
            let log = |text: String| {
                self.journal.push(EventKind::Output {
                    step: "services".into(),
                    stream: "stdout".into(),
                    text,
                })
            };
            let result = docker::start_services(&endpoint, &record.run_id, &record.services, &log);
            self.journal.push(EventKind::StepEnd {
                step: "services".into(),
                exit_code: Some(if result.is_ok() { 0 } else { 1 }),
                duration_ms: started.elapsed().as_millis() as u64,
            });
            running = result?;
            Some(endpoint)
        };
        let outcome = (|| {
            if !record.env_overrides.is_empty() {
                let run_port = std::net::TcpListener::bind("127.0.0.1:0")
                    .and_then(|listener| listener.local_addr())
                    .map_err(|e| e.to_string())?
                    .port();
                let values: Vec<EnvVar> = record
                    .env_overrides
                    .iter()
                    .map(|var| EnvVar {
                        key: var.key.clone(),
                        value: docker::render(&var.value, &running, run_port),
                    })
                    .collect();
                // The values go where the app reads its env: the files copied into this run
                // (e.g. `api/.env` in a sub-repo), or the root `.env` when none was copied.
                let targets = if record.copy_env.is_empty() {
                    vec![".env".to_string()]
                } else {
                    record.copy_env.clone()
                };
                for target in &targets {
                    docker::apply_env(&worktree.join(target), &values)?;
                }
                self.journal.push(EventKind::Output {
                    step: "services".into(),
                    stream: "stdout".into(),
                    text: format!(
                        "set for this run in {}: {}",
                        targets.join(", "),
                        values
                            .iter()
                            .map(|v| v.key.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                });
            }
            if let Some(command) = &migrate {
                match run_step(
                    self.journal,
                    self.control,
                    &Step::new("migrate", command, &worktree, CHECK_TIMEOUT),
                )? {
                    StepOutcome::Exited(0) => {}
                    StepOutcome::Exited(_) if repair => self.repair_setup("migrate")?,
                    StepOutcome::Exited(code) => {
                        return Err(format!("migrate failed (exit code {code})"))
                    }
                    StepOutcome::Cancelled => return Err("stopped".into()),
                    StepOutcome::TimedOut | StepOutcome::OverBudget => {
                        return Err("migrate timed out".into())
                    }
                }
            }
            work()
        })();
        if let Some(endpoint) = endpoint {
            docker::stop_services(&endpoint, &running);
            self.journal.push(EventKind::Output {
                step: "services".into(),
                stream: "stdout".into(),
                text: "service containers removed".into(),
            });
        }
        outcome
    }

    /// Implement → final checks by the app → up to two repair rounds → ready for review.
    pub fn implement(&self, first_prompt: String) -> Result<RunStatus, String> {
        self.with_services(true, || self.implement_rounds(first_prompt))
    }

    fn implement_rounds(&self, first_prompt: String) -> Result<RunStatus, String> {
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
            let digest = tree_digest(&worktree)?;
            self.journal.update(|record| {
                record.checks = checks;
                record.changed_files = changed;
                record.progress = progress;
                record.verified_digest = Some(digest);
            });
            if self.control.cancelled() {
                return Ok(RunStatus::Cancelled);
            }
            if failed.is_empty() {
                return self.review();
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

    /// An independent, read-only reviewer compares the change with the task and the app's
    /// checks (agents tend to rate their own work too well). Its verdict informs the owner;
    /// if it cannot run, the change still reaches review, marked as not reviewed.
    fn review(&self) -> Result<RunStatus, String> {
        self.journal.set_status(RunStatus::Reviewing, None);
        let record = self.journal.record();
        let checks = record
            .checks
            .iter()
            .map(|check| format!("{}: {}", check.name, check.status))
            .collect::<Vec<_>>()
            .join(", ");
        let prompt = claude::reviewer_prompt(&record.issue_key, &checks);
        let review = match self.invoke(Phase::Reviewing, &prompt) {
            Ok((outcome, tools)) => match self.agent_outcome(outcome)? {
                Some(status) => return Ok(status),
                None => tools.take_review().unwrap_or_else(|| {
                    unavailable("the reviewer finished without submitting a review")
                }),
            },
            Err(_) if self.control.cancelled() => return Ok(RunStatus::Cancelled),
            Err(error) => unavailable(&error),
        };
        self.journal.update(|record| record.review = Some(review));
        Ok(RunStatus::ReadyForReview)
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

impl AgentRun<'_> {
    /// Accept → (re-check if the change moved since its checks) → the agent drafts the text
    /// read-only → the app commits, pushes and opens or updates a Draft PR. Any failure keeps
    /// the run ready for review with the reason, so Accept can be retried.
    pub fn publish(&self) -> Result<RunStatus, String> {
        self.journal.set_status(RunStatus::Publishing, None);
        match self.publish_steps() {
            Ok(Some(url)) => {
                self.journal.update(|record| {
                    record.pr_url = Some(url);
                    record.error = None;
                });
                Ok(RunStatus::Completed)
            }
            Ok(None) => Ok(RunStatus::Cancelled),
            Err(_) if self.control.cancelled() => Ok(RunStatus::Cancelled),
            Err(error) => {
                self.journal.update(|record| record.error = Some(error));
                Ok(RunStatus::ReadyForReview)
            }
        }
    }

    fn publish_steps(&self) -> Result<Option<String>, String> {
        let worktree = self.worktree()?;
        let record = self.journal.record();
        let info = record.worktree.clone().ok_or("this run has no worktree")?;

        if record.verified_digest.as_deref() != Some(tree_digest(&worktree)?.as_str()) {
            self.note("the change moved after its checks; running them again");
            let checks = self.with_services(false, || self.verify())?;
            let failed: Vec<&str> = checks
                .iter()
                .filter(|check| check.status != "passed")
                .map(|check| check.name.as_str())
                .collect();
            let digest = tree_digest(&worktree)?;
            let names = failed.join(", ");
            self.journal.update(|record| {
                record.checks = checks;
                record.verified_digest = Some(digest);
            });
            if !names.is_empty() {
                return Err(format!("checks fail on the current change: {names}"));
            }
        }
        let changed = changed_files(&worktree)?;
        let ahead = git(
            &["rev-list", "--count", &format!("{}..HEAD", info.base_sha)],
            &worktree,
            Duration::from_secs(20),
        )?;
        if changed.is_empty() && ahead.trim() == "0" {
            return Err("nothing to publish: no files changed".into());
        }

        let (outcome, tools) =
            self.invoke(Phase::Drafting, &claude::drafting_prompt(&record.issue_key))?;
        if let Some(status) = self.agent_outcome(outcome)? {
            return if status == RunStatus::Cancelled {
                Ok(None)
            } else {
                Err("drafting stopped".into())
            };
        }
        let draft = tools
            .take_pr_draft()
            .ok_or("the agent did not submit a pull request draft")?;
        let record = self.journal.record();
        let body = pr_body(&record, &draft);
        let body_file = self.run_dir.join("pr-body.md");
        let message_file = self.run_dir.join("commit-message.txt");
        fs::write(&body_file, &body).map_err(|e| e.to_string())?;
        fs::write(&message_file, format!("{}\n", draft.commit_message))
            .map_err(|e| e.to_string())?;
        let body_arg = body_file.display().to_string();

        if !changed.is_empty() {
            // Env files the app copied in are never committed, even if the repo does not ignore them.
            let mut add = vec!["add".to_string(), "-A".into(), "--".into(), ".".into()];
            add.extend(
                record
                    .copy_env
                    .iter()
                    .map(|file| format!(":(exclude){file}")),
            );
            self.app_step("publish:add", "git", add)?;
            let message = message_file.display().to_string();
            self.app_step(
                "publish:commit",
                "git",
                vec!["commit".into(), "-F".into(), message],
            )?;
        }
        self.app_step(
            "publish:push",
            "git",
            vec![
                "push".into(),
                "-u".into(),
                "origin".into(),
                info.branch.clone(),
            ],
        )?;

        let list = self.gh_step(
            "publish:pr-list",
            [
                "pr",
                "list",
                "--head",
                &info.branch,
                "--state",
                "all",
                "--json",
                "number,state,url",
                "--limit",
                "1",
            ],
        )?;
        let existing: Vec<serde_json::Value> = list
            .iter()
            .rev()
            .find_map(|line| serde_json::from_str(line.trim()).ok())
            .unwrap_or_default();
        if let Some(pr) = existing.first() {
            let url = pr["url"].as_str().unwrap_or("").to_string();
            match pr["state"].as_str() {
                Some("MERGED") => {
                    return Err(format!(
                        "a pull request for this branch was already merged: {url}"
                    ))
                }
                Some("OPEN") => {
                    let number = pr["number"].to_string();
                    self.gh_step(
                        "publish:pr-edit",
                        [
                            "pr",
                            "edit",
                            &number,
                            "--title",
                            &draft.title,
                            "--body-file",
                            &body_arg,
                        ],
                    )?;
                    return Ok(Some(url));
                }
                _ => {}
            }
        }
        let created = self.gh_step(
            "publish:pr-create",
            [
                "pr",
                "create",
                "--draft",
                "--base",
                &record.base_branch,
                "--head",
                &info.branch,
                "--title",
                &draft.title,
                "--body-file",
                &body_arg,
            ],
        )?;
        created
            .iter()
            .rev()
            .map(|line| line.trim())
            .find(|line| line.starts_with("https://"))
            .map(|url| Some(url.to_string()))
            .ok_or_else(|| "gh did not report the pull request URL".into())
    }

    fn note(&self, text: &str) {
        self.journal.push(EventKind::Output {
            step: "publish".into(),
            stream: "stdout".into(),
            text: text.into(),
        });
    }

    /// A git command the app runs with the owner credentials, shown in the run log.
    fn app_step(
        &self,
        name: &str,
        executable: &str,
        args: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let worktree = self.worktree()?;
        let command = CommandSpec {
            executable: executable.into(),
            args,
            ..CommandSpec::default()
        };
        self.checked(name, &command, &[], &worktree)
    }

    fn gh_step<const N: usize>(&self, name: &str, args: [&str; N]) -> Result<Vec<String>, String> {
        let worktree = self.worktree()?;
        let gh = &self.env.gh;
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let mut env = gh.env.clone();
        let mut argv = gh.prefix_args.clone();
        match &gh.args_env {
            Some(var) => env.push((var.clone(), serde_json::to_string(&args).unwrap())),
            None => argv.extend(args),
        }
        let command = CommandSpec {
            executable: gh.executable.display().to_string(),
            args: argv,
            ..CommandSpec::default()
        };
        self.checked(name, &command, &env, &worktree)
    }

    fn checked(
        &self,
        name: &str,
        command: &CommandSpec,
        env: &[(String, String)],
        cwd: &Path,
    ) -> Result<Vec<String>, String> {
        let mut step = Step::new(name, command, cwd, CHECK_TIMEOUT);
        step.env = env;
        step.keep_secrets = true;
        match run_step(self.journal, self.control, &step)? {
            StepOutcome::Exited(0) => Ok(self.journal.step_lines(name)),
            StepOutcome::Exited(code) => {
                let lines = self.journal.step_lines(name);
                let last = lines.last().cloned().unwrap_or_default();
                Err(format!("{name} failed (exit code {code}): {last}"))
            }
            StepOutcome::Cancelled => Err("stopped".into()),
            StepOutcome::TimedOut | StepOutcome::OverBudget => Err(format!("{name} timed out")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    /// `pass`, `fail`, `pending`, `skipping` or `cancel` (gh's bucket).
    pub bucket: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    pub checks: Vec<CiCheck>,
    /// True only when there is at least one check and none is pending or failing.
    pub all_passed: bool,
}

fn run_gh(gh: &AgentLauncher, args: &[&str], cwd: &Path) -> Result<std::process::Output, String> {
    let program = super::exec::resolve_executable(&gh.executable.display().to_string())
        .ok_or("gh is not installed or not on PATH")?;
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let mut command = std::process::Command::new(program);
    command.current_dir(cwd).args(&gh.prefix_args);
    match &gh.args_env {
        Some(var) => {
            command.env(var, serde_json::to_string(&args).unwrap());
        }
        None => {
            command.args(&args);
        }
    }
    command.envs(gh.env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    super::exec::hide_console(&mut command);
    command.output().map_err(|e| e.to_string())
}

/// CI state of the run's Draft PR, from `gh pr checks` (non-zero exits mean failing/pending,
/// so the JSON on stdout is what counts).
pub fn pr_ci_status(env: &AgentEnv, record: &super::run::RunRecord) -> Result<CiStatus, String> {
    let url = record
        .pr_url
        .as_deref()
        .ok_or("this run has no pull request yet")?;
    let cwd = PathBuf::from(&record.repo_path);
    let output = run_gh(
        &env.gh,
        &["pr", "checks", url, "--json", "name,bucket"],
        &cwd,
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let checks: Vec<CiCheck> = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line.trim()).ok())
        .unwrap_or_default();
    let all_passed = !checks.is_empty()
        && checks
            .iter()
            .all(|check| check.bucket == "pass" || check.bucket == "skipping");
    Ok(CiStatus { checks, all_passed })
}

/// Marks the Draft PR ready for review, only after the app itself sees every CI check pass.
pub fn mark_pr_ready(env: &AgentEnv, record: &super::run::RunRecord) -> Result<CiStatus, String> {
    let status = pr_ci_status(env, record)?;
    if status.checks.is_empty() {
        return Err("CI reported no checks for this pull request yet".into());
    }
    if !status.all_passed {
        let open: Vec<&str> = status
            .checks
            .iter()
            .filter(|check| check.bucket != "pass" && check.bucket != "skipping")
            .map(|check| check.name.as_str())
            .collect();
        return Err(format!("CI has not passed yet: {}", open.join(", ")));
    }
    let url = record.pr_url.as_deref().unwrap_or_default();
    let output = run_gh(
        &env.gh,
        &["pr", "ready", url],
        &PathBuf::from(&record.repo_path),
    )?;
    if !output.status.success() {
        return Err(format!(
            "gh pr ready failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(status)
}

/// The PR body in the team template (Thai). The testing section comes only from the checks
/// the app ran itself on this revision; the agent cannot claim results.
fn pr_body(record: &super::run::RunRecord, draft: &PrDraft) -> String {
    let commands = &record.commands;
    let shown = |name: &str| {
        [
            ("build", &commands.build),
            ("lint", &commands.lint),
            ("test", &commands.test),
            ("install", &commands.install),
        ]
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .and_then(|(_, command)| command.as_ref())
        .map(|command| {
            std::iter::once(command.executable.as_str())
                .chain(command.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
    };
    let testing = if record.checks.is_empty() {
        "- [ ] ยังไม่มีคำสั่งตรวจ (build / lint / test) ที่ตั้งไว้ใน Setup".to_string()
    } else {
        record
            .checks
            .iter()
            .map(|check| {
                let mark = if check.status == "passed" { "x" } else { " " };
                let result = if check.status == "passed" {
                    "ผ่าน"
                } else {
                    "ไม่ผ่าน"
                };
                let command = shown(&check.name)
                    .map(|command| format!(" (`{command}`)"))
                    .unwrap_or_default();
                format!(
                    "- [{mark}] `{}`{command} {result} — JiraSync Hub รันบน revision นี้",
                    check.name
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let related = match &record.jira_url {
        Some(url) => format!("- Jira: [{}]({url})", record.issue_key),
        None => format!("- Jira: {}", record.issue_key),
    };
    format!(
        "## สรุป\n{}\n\n## เหตุผล\n{}\n\n## การเปลี่ยนแปลง\n{}\n\n## การทดสอบ\n{testing}\n\n## ผลกระทบ\n{}\n\n## ที่เกี่ยวข้อง\n{related}\n",
        draft.summary, draft.reason, draft.changes, draft.impact
    )
}

/// Identifies the exact change: tracked diff against HEAD plus every untracked file.
pub fn tree_digest(worktree: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(git(
        &["diff", "HEAD", "--binary"],
        worktree,
        Duration::from_secs(60),
    )?);
    let untracked = git(
        &["ls-files", "--others", "--exclude-standard"],
        worktree,
        Duration::from_secs(30),
    )?;
    for file in untracked.lines() {
        hasher.update(file.as_bytes());
        hasher.update(fs::read(worktree.join(file)).unwrap_or_default());
    }
    Ok(hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn unavailable(reason: &str) -> AgentReview {
    AgentReview {
        verdict: "unavailable".into(),
        summary: reason.chars().take(500).collect(),
        findings: Vec::new(),
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

#[cfg(test)]
#[path = "eval_tests.rs"]
mod eval_tests;
