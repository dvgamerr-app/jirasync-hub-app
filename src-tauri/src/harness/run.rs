// Run manager: one active run for the whole app. Each run has a journal on disk
// (`runs/<id>/run.json` + `events.ndjson`); every event is written there before the UI sees
// it, so a reload can replay from a sequence number without applying anything twice.
// Every step is a process the app starts itself, streamed live and stoppable as a tree.
use super::agent::{mark_pr_ready, pr_ci_status, AgentEnv, AgentRun, CheckResult, CiStatus};
use super::bindings::RepoBinding;
use super::claude;
use super::docker::{EnvVar, ServiceSpec};
use super::exec::{hide_console, resolve_executable};
use super::repo::{CommandSpec, RepoCommands};
use super::tools::AgentReview;
use super::worktree::{self, CreateWorktree, WorktreeInfo};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const AGENT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Secrets of the owner's own tools that a run's processes never need.
const STRIPPED_ENV: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    #[default]
    Preparing,
    Installing,
    /// The agent explores read-only and submits a plan.
    Planning,
    /// Waiting for the owner to approve or revise the plan.
    AwaitingPlan,
    /// The agent implements the approved plan.
    Running,
    /// The app runs the final checks itself.
    Verifying,
    /// An independent reviewer agent reads the change (read-only).
    Reviewing,
    /// Checks passed; waiting for the owner to accept or ask for changes.
    ReadyForReview,
    /// Accepted: the app commits, pushes and opens the Draft PR.
    Publishing,
    /// The owner accepted the change.
    Completed,
    /// Workspace is ready (worktree + env + install) without an agent.
    Prepared,
    /// A raw agent command exited 0 (tests only). Not "done": review still decides that.
    Finished,
    Failed,
    Cancelled,
    /// The app stopped while the run was busy; never resumed automatically.
    Interrupted,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Prepared
                | Self::Finished
                | Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
        )
    }

    /// Nothing is running; the run waits for an owner decision.
    pub fn is_waiting(self) -> bool {
        matches!(self, Self::AwaitingPlan | Self::ReadyForReview)
    }

    /// A process of this run may be running right now.
    pub fn is_busy(self) -> bool {
        !self.is_terminal() && !self.is_waiting()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunRecord {
    pub run_id: String,
    pub task_id: String,
    pub project_id: String,
    pub issue_key: String,
    pub repo_path: String,
    pub status: RunStatus,
    pub worktree: Option<WorktreeInfo>,
    pub worktree_removed: bool,
    pub created_at: u64,
    pub ended_at: Option<u64>,
    pub error: Option<String>,
    /// "agent" when a coding agent works on the task, "prepare" for a workspace only.
    pub mode: String,
    /// Commands from the binding when the run started (kept so later steps use the same ones).
    pub commands: RepoCommands,
    pub session_id: Option<String>,
    pub context_digest: Option<String>,
    pub plan: Option<String>,
    /// Agent working time so far (time the app spent executing is not counted).
    pub ai_ms: u64,
    /// Repair rounds used after failed checks.
    pub attempts: u32,
    pub checks: Vec<CheckResult>,
    pub changed_files: Vec<String>,
    pub progress: Option<String>,
    /// Verdict of the independent reviewer agent on the latest change.
    pub review: Option<AgentReview>,
    /// Env files copied into the worktree; never committed even if the repo does not ignore them.
    pub copy_env: Vec<String>,
    /// Service containers and per-run env values from the binding when the run started.
    pub services: Vec<ServiceSpec>,
    pub env_overrides: Vec<EnvVar>,
    pub base_branch: String,
    pub jira_url: Option<String>,
    /// Digest of the worktree changes the last checks ran on (stale checks are re-run).
    pub verified_digest: Option<String>,
    pub pr_url: Option<String>,
    /// The Draft PR was marked ready for review after CI passed.
    pub pr_ready: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EventKind {
    Status {
        status: RunStatus,
        message: Option<String>,
    },
    StepStart {
        step: String,
        command: String,
    },
    Output {
        step: String,
        stream: String,
        text: String,
    },
    StepEnd {
        step: String,
        exit_code: Option<i32>,
        duration_ms: u64,
    },
    /// The app decided a permission request from the agent.
    Permission {
        tool: String,
        decision: String,
    },
    /// What the agent said or did (text, tool use, plan, final result), from its event stream.
    Agent {
        kind: String,
        text: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: String,
    pub seq: u64,
    pub at: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

pub type Emit = Arc<dyn Fn(&RunEvent) + Send + Sync>;

struct JournalState {
    record: RunRecord,
    seq: u64,
    events: File,
}

/// Owns a run's files. All writes go through one lock so the sequence never has gaps.
pub(super) struct Journal {
    dir: PathBuf,
    state: Mutex<JournalState>,
    emit: Emit,
}

impl Journal {
    pub(super) fn create(dir: PathBuf, record: RunRecord, emit: Emit) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let events = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("events.ndjson"))
            .map_err(|e| e.to_string())?;
        let journal = Self {
            dir,
            state: Mutex::new(JournalState {
                record,
                seq: 0,
                events,
            }),
            emit,
        };
        journal.save()?;
        Ok(journal)
    }

    fn open(dir: PathBuf, emit: Emit) -> Result<Self, String> {
        let record = read_record(&dir)?;
        let seq = read_events(&dir, 0, usize::MAX)?
            .last()
            .map(|event| event.seq)
            .unwrap_or(0);
        let events = OpenOptions::new()
            .append(true)
            .open(dir.join("events.ndjson"))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            dir,
            state: Mutex::new(JournalState {
                record,
                seq,
                events,
            }),
            emit,
        })
    }

    fn save(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        write_record(&self.dir, &state.record)
    }

    pub(super) fn push(&self, kind: EventKind) {
        let event = {
            let mut state = self.state.lock().unwrap();
            state.seq += 1;
            let event = RunEvent {
                run_id: state.record.run_id.clone(),
                seq: state.seq,
                at: now_ms(),
                kind,
            };
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(state.events, "{line}");
                let _ = state.events.flush();
            }
            event
        };
        (self.emit)(&event);
    }

    pub(super) fn set_status(&self, status: RunStatus, error: Option<String>) {
        {
            let mut state = self.state.lock().unwrap();
            state.record.status = status;
            if error.is_some() {
                state.record.error = error.clone();
            }
            if status.is_terminal() {
                state.record.ended_at = Some(now_ms());
            }
            let _ = write_record(&self.dir, &state.record);
        }
        self.push(EventKind::Status {
            status,
            message: error,
        });
    }

    pub(super) fn update(&self, change: impl FnOnce(&mut RunRecord)) {
        let mut state = self.state.lock().unwrap();
        change(&mut state.record);
        let _ = write_record(&self.dir, &state.record);
    }

    /// Output lines of one step, read back from the journal on disk.
    pub(super) fn step_lines(&self, step: &str) -> Vec<String> {
        read_events(&self.dir, 0, usize::MAX)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|event| match event.kind {
                EventKind::Output { step: s, text, .. } if s == step => Some(text),
                _ => None,
            })
            .collect()
    }

    pub(super) fn record(&self) -> RunRecord {
        self.state.lock().unwrap().record.clone()
    }
}

fn write_record(dir: &Path, record: &RunRecord) -> Result<(), String> {
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    let temp = dir.join("run.json.tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, dir.join("run.json")).map_err(|e| e.to_string())
}

fn read_record(dir: &Path) -> Result<RunRecord, String> {
    let text = fs::read_to_string(dir.join("run.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", dir.display()))
}

fn read_events(dir: &Path, after_seq: u64, limit: usize) -> Result<Vec<RunEvent>, String> {
    let file = match File::open(dir.join("events.ndjson")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    Ok(BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<RunEvent>(&line).ok())
        .filter(|event| event.seq > after_seq)
        .take(limit)
        .collect())
}

/// Kills a process and everything it started (agents spawn shells, test runners, servers).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        if let Some(taskkill) = resolve_executable("taskkill") {
            let mut command = Command::new(taskkill);
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            hide_console(&mut command);
            let _ = command.status();
        }
    }
    #[cfg(not(windows))]
    {
        // Each step runs in its own process group (see `spawn_step`).
        for signal in ["-TERM", "-KILL"] {
            let _ = Command::new("kill")
                .args([signal, &format!("-{pid}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

/// Cancellation and the process trees a run owns (the agent, commands it asked for, dev).
#[derive(Default)]
pub(super) struct Control {
    cancel: AtomicBool,
    pids: Mutex<Vec<u32>>,
}

impl Control {
    pub(super) fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let pids = self.pids.lock().unwrap().clone();
        for pid in pids {
            kill_tree(pid);
        }
    }

    pub(super) fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn track(&self, pid: u32) {
        self.pids.lock().unwrap().push(pid);
    }

    fn untrack(&self, pid: u32) {
        self.pids.lock().unwrap().retain(|tracked| *tracked != pid);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StepOutcome {
    Exited(i32),
    Cancelled,
    TimedOut,
    /// Stopped because the AI-time budget ran out.
    OverBudget,
}

/// Turns one stdout line into journal events (e.g. Claude's stream-json); `None` = plain line.
pub(super) type LineParser = fn(&str, &str) -> Option<Vec<EventKind>>;

pub(super) struct Step<'a> {
    pub name: &'a str,
    pub command: &'a CommandSpec,
    pub cwd: &'a Path,
    pub timeout: Duration,
    pub env: &'a [(String, String)],
    pub parse_stdout: Option<LineParser>,
    /// Keep the owner credentials in the env (git push / gh run by the app, never the agent).
    pub keep_secrets: bool,
    /// Checked while the step runs; true stops it as over budget.
    pub over_budget: Option<&'a (dyn Fn() -> bool + Sync)>,
}

impl<'a> Step<'a> {
    pub(super) fn new(
        name: &'a str,
        command: &'a CommandSpec,
        cwd: &'a Path,
        timeout: Duration,
    ) -> Self {
        Self {
            name,
            command,
            cwd,
            timeout,
            env: &[],
            parse_stdout: None,
            keep_secrets: false,
            over_budget: None,
        }
    }
}

fn spawn_streamed(
    journal: &Arc<Journal>,
    control: &Control,
    step: &Step,
) -> Result<(std::process::Child, std::sync::mpsc::Receiver<()>, usize), String> {
    let command = step.command;
    let name = step.name;
    let program = resolve_executable(&command.executable).ok_or_else(|| {
        format!(
            "{name}: `{}` is not installed or not on PATH",
            command.executable
        )
    })?;
    let shown = std::iter::once(command.executable.as_str())
        .chain(command.args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    journal.push(EventKind::StepStart {
        step: name.into(),
        command: shown,
    });

    let mut process = Command::new(&program);
    process
        .args(&command.args)
        .current_dir(step.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1");
    if !step.keep_secrets {
        for name in STRIPPED_ENV {
            process.env_remove(name);
        }
    }
    for (key, value) in step.env {
        process.env(key, value);
    }
    hide_console(&mut process);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = process
        .spawn()
        .map_err(|e| format!("{name}: could not start {}: {e}", program.display()))?;
    control.track(child.id());

    let pipes: Vec<(&str, Box<dyn std::io::Read + Send>)> = [
        (
            "stdout",
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ),
        (
            "stderr",
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ),
    ]
    .into_iter()
    .filter_map(|(stream, pipe)| pipe.map(|pipe| (stream, pipe)))
    .collect();

    // A reader ends when every process holding its pipe has exited, children included.
    let (done, finished) = std::sync::mpsc::channel::<()>();
    let reader_count = pipes.len();
    for (stream, pipe) in pipes {
        let journal = journal.clone();
        let name = name.to_string();
        let parse = step.parse_stdout.filter(|_| stream == "stdout");
        let done = done.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buffer = Vec::new();
            while reader.read_until(b'\n', &mut buffer).unwrap_or(0) > 0 {
                let text = String::from_utf8_lossy(&buffer)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                match parse.and_then(|parse| parse(&name, &text)) {
                    Some(events) => events.into_iter().for_each(|event| journal.push(event)),
                    None => journal.push(EventKind::Output {
                        step: name.clone(),
                        stream: stream.into(),
                        text,
                    }),
                }
                buffer.clear();
            }
            let _ = done.send(());
        });
    }
    Ok((child, finished, reader_count))
}

/// Runs one command to completion, streaming each output line into the journal.
pub(super) fn run_step(
    journal: &Arc<Journal>,
    control: &Control,
    step: &Step,
) -> Result<StepOutcome, String> {
    if control.cancelled() {
        return Ok(StepOutcome::Cancelled);
    }
    let started = Instant::now();
    let (mut child, finished, reader_count) = spawn_streamed(journal, control, step)?;
    let deadline = started + step.timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if control.cancelled() {
                    StepOutcome::Cancelled
                } else {
                    StepOutcome::Exited(status.code().unwrap_or(-1))
                };
            }
            Ok(None) => {}
            Err(_) => break StepOutcome::Exited(-1),
        }
        let over_budget = step.over_budget.is_some_and(|check| check());
        if control.cancelled() || over_budget || Instant::now() >= deadline {
            let outcome = if control.cancelled() {
                StepOutcome::Cancelled
            } else if over_budget {
                StepOutcome::OverBudget
            } else {
                StepOutcome::TimedOut
            };
            kill_tree(child.id());
            let _ = child.wait();
            break outcome;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    control.untrack(child.id());
    // After a stop the tree is already killed; after a normal exit a background child
    // (e.g. a server the step started) may keep the pipe open, so do not wait forever.
    let grace = Instant::now() + Duration::from_secs(5);
    let mut ended = 0;
    while ended < reader_count {
        let left = grace.saturating_duration_since(Instant::now());
        if finished.recv_timeout(left).is_err() {
            journal.push(EventKind::Output {
                step: step.name.into(),
                stream: "stderr".into(),
                text: "a background process this step started is still running".into(),
            });
            break;
        }
        ended += 1;
    }
    journal.push(EventKind::StepEnd {
        step: step.name.into(),
        exit_code: match outcome {
            StepOutcome::Exited(code) => Some(code),
            _ => None,
        },
        duration_ms: started.elapsed().as_millis() as u64,
    });
    Ok(outcome)
}

/// A long-running process (the dev server) owned by a run until the run ends or stops.
pub(super) struct Background {
    child: std::process::Child,
}

impl Background {
    pub(super) fn start(
        journal: &Arc<Journal>,
        control: &Control,
        step: &Step,
    ) -> Result<Self, String> {
        let (child, _finished, _readers) = spawn_streamed(journal, control, step)?;
        Ok(Self { child })
    }

    pub(super) fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub(super) fn stop(mut self, control: &Control) {
        kill_tree(self.child.id());
        let _ = self.child.wait();
        control.untrack(self.child.id());
    }
}

pub struct StartRun {
    pub task_id: String,
    pub issue_key: String,
    pub binding: RepoBinding,
    /// Task snapshot (markdown) for a coding agent; `None` only prepares the workspace.
    pub context: Option<String>,
    /// A raw command run after install instead of the agent (tests only).
    pub agent: Option<CommandSpec>,
    /// Link to the Jira issue, for the pull request.
    pub jira_url: Option<String>,
}

/// What the owner decided at a gate of an agent run.
pub enum Decision {
    ApprovePlan,
    RevisePlan(String),
    /// From review, or to continue a failed/stopped run in the same session.
    RequestChanges(String),
    Accept,
}

struct Active {
    run_id: String,
    control: Arc<Control>,
}

#[derive(Clone)]
pub struct RunManager {
    root: PathBuf,
    active: Arc<Mutex<Option<Active>>>,
    emit: Emit,
    agent: Option<Arc<AgentEnv>>,
}

const MAX_FEEDBACK_CHARS: usize = 8000;

/// Records how a run's background work ended and frees the one-run slot.
fn finish(
    journal: &Journal,
    control: &Control,
    slot: &Mutex<Option<Active>>,
    result: Result<RunStatus, String>,
) {
    let (status, error) = match result {
        Ok(status) => (status, None),
        Err(_) if control.cancelled() => (RunStatus::Cancelled, None),
        Err(error) => (RunStatus::Failed, Some(error)),
    };
    journal.set_status(status, error);
    *slot.lock().unwrap() = None;
}

static RUN_COUNTER: AtomicU32 = AtomicU32::new(0);

fn new_run_id() -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(now_ms().to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(RUN_COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

impl RunManager {
    /// Opens the runs folder and marks runs that were active when the app stopped as
    /// interrupted. Their processes are not trusted or resumed (a PID may be reused).
    pub fn new(root: PathBuf, emit: Emit) -> Self {
        let manager = Self {
            root,
            active: Arc::new(Mutex::new(None)),
            emit,
            agent: None,
        };
        // Runs waiting for the owner keep waiting; only busy ones were cut off.
        for record in manager.list(usize::MAX) {
            if record.status.is_busy() {
                if let Ok(journal) =
                    Journal::open(manager.run_dir(&record.run_id), manager.emit.clone())
                {
                    journal.set_status(
                        RunStatus::Interrupted,
                        Some("the app closed while this run was active".into()),
                    );
                }
            }
        }
        manager
    }

    /// Enables coding-agent runs (Claude, or a fake agent in tests).
    pub fn with_agent(mut self, env: AgentEnv) -> Self {
        self.agent = Some(Arc::new(env));
        self
    }

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.root.join(run_id)
    }

    fn claim(&self, run_id: &str) -> Result<Arc<Control>, String> {
        let mut active = self.active.lock().unwrap();
        if let Some(current) = active.as_ref() {
            return Err(format!(
                "another run ({}) is active; stop it or wait for it to finish",
                current.run_id
            ));
        }
        let control = Arc::new(Control::default());
        *active = Some(Active {
            run_id: run_id.into(),
            control: control.clone(),
        });
        Ok(control)
    }

    /// Continues an agent run after an owner decision, in the same session and worktree.
    pub fn resume(&self, run_id: &str, decision: Decision) -> Result<RunRecord, String> {
        let dir = self.checked_dir(run_id)?;
        let env = self
            .agent
            .clone()
            .ok_or("coding-agent runs are not available")?;
        let journal = Arc::new(Journal::open(dir.clone(), self.emit.clone())?);
        let record = journal.record();
        if record.mode != "agent" {
            return Err("this run only prepared a workspace".into());
        }
        let feedback = |text: &str| -> Result<String, String> {
            let text = text.trim();
            if text.is_empty() {
                return Err("write what should change".into());
            }
            if text.chars().count() > MAX_FEEDBACK_CHARS {
                return Err(format!("keep it under {MAX_FEEDBACK_CHARS} characters"));
            }
            Ok(text.to_string())
        };
        let status = record.status;
        let can_continue = matches!(
            status,
            RunStatus::ReadyForReview
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::Interrupted
        ) && record.session_id.is_some()
            && record.worktree.is_some()
            && !record.worktree_removed;
        enum Next {
            Plan(Option<String>),
            Implement(String),
            Publish,
        }
        let next = match decision {
            Decision::Accept if status == RunStatus::ReadyForReview => Next::Publish,
            Decision::ApprovePlan if status == RunStatus::AwaitingPlan => {
                Next::Implement(claude::IMPLEMENT_PROMPT.into())
            }
            Decision::RevisePlan(text) if status == RunStatus::AwaitingPlan => {
                Next::Plan(Some(feedback(&text)?))
            }
            Decision::RequestChanges(text) if can_continue => {
                Next::Implement(claude::changes_prompt(&feedback(&text)?))
            }
            _ => return Err(format!("that is not possible while the run is {status:?}")),
        };
        let control = self.claim(run_id)?;
        journal.update(|record| {
            record.error = None;
            record.ended_at = None;
        });
        let slot = self.active.clone();
        std::thread::spawn(move || {
            let run = AgentRun {
                journal: &journal,
                control: &control,
                env: &env,
                run_dir: &dir,
            };
            let result = match next {
                Next::Plan(feedback) => run.plan(feedback.as_deref()),
                Next::Implement(prompt) => run.implement(prompt),
                Next::Publish => run.publish(),
            };
            finish(&journal, &control, &slot, result);
        });
        Ok(record)
    }

    fn checked_dir(&self, run_id: &str) -> Result<PathBuf, String> {
        if !worktree::is_valid_run_id(run_id) {
            return Err("invalid run id".into());
        }
        let dir = self.run_dir(run_id);
        dir.join("run.json")
            .is_file()
            .then_some(dir)
            .ok_or_else(|| format!("run {run_id} not found"))
    }

    pub fn active_run_id(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.run_id.clone())
    }

    pub fn start(&self, request: StartRun) -> Result<RunRecord, String> {
        if !worktree::is_valid_issue_key(&request.issue_key) {
            return Err(format!("\"{}\" is not a Jira issue key", request.issue_key));
        }
        let env = match &request.context {
            Some(_) => Some(
                self.agent
                    .clone()
                    .ok_or("coding-agent runs are not available")?,
            ),
            None => None,
        };
        let run_id = new_run_id();
        let control = self.claim(&run_id)?;
        let record = RunRecord {
            run_id: run_id.clone(),
            task_id: request.task_id.clone(),
            project_id: request.binding.project_id.clone(),
            issue_key: request.issue_key.clone(),
            repo_path: request.binding.repo_path.clone(),
            status: RunStatus::Preparing,
            created_at: now_ms(),
            mode: if env.is_some() { "agent" } else { "prepare" }.into(),
            commands: request.binding.commands.clone(),
            copy_env: request.binding.copy_env.clone(),
            services: request.binding.services.clone(),
            env_overrides: request.binding.env_overrides.clone(),
            base_branch: request.binding.base_branch.clone(),
            jira_url: request.jira_url.clone(),
            ..RunRecord::default()
        };
        let dir = self.run_dir(&run_id);
        let journal = match Journal::create(dir.clone(), record.clone(), self.emit.clone()) {
            Ok(journal) => Arc::new(journal),
            Err(error) => {
                *self.active.lock().unwrap() = None;
                return Err(error);
            }
        };
        journal.push(EventKind::Status {
            status: RunStatus::Preparing,
            message: None,
        });

        let slot = self.active.clone();
        std::thread::spawn(move || {
            let result = pipeline(&journal, &control, &request).and_then(|status| {
                match (&env, &request.context) {
                    (Some(env), Some(context)) if status == RunStatus::Prepared => {
                        let run = AgentRun {
                            journal: &journal,
                            control: &control,
                            env,
                            run_dir: &dir,
                        };
                        run.write_context(context)?;
                        run.plan(None)
                    }
                    _ => Ok(status),
                }
            });
            finish(&journal, &control, &slot, result);
        });
        Ok(record)
    }

    pub fn stop(&self, run_id: &str) -> Result<(), String> {
        let active = self.active.lock().unwrap();
        match active.as_ref() {
            Some(current) if current.run_id == run_id => {
                current.control.stop();
                Ok(())
            }
            _ => Err(format!("run {run_id} is not active")),
        }
    }

    /// CI checks of the run's Draft PR.
    pub fn pr_checks(&self, run_id: &str) -> Result<CiStatus, String> {
        let env = self
            .agent
            .clone()
            .ok_or("coding-agent runs are not available")?;
        let record = read_record(&self.checked_dir(run_id)?)?;
        pr_ci_status(&env, &record)
    }

    /// Draft → ready for review, only when every CI check passed (checked again here).
    pub fn mark_pr_ready(&self, run_id: &str) -> Result<RunRecord, String> {
        let env = self
            .agent
            .clone()
            .ok_or("coding-agent runs are not available")?;
        let journal = Journal::open(self.checked_dir(run_id)?, self.emit.clone())?;
        let record = journal.record();
        if record.status != RunStatus::Completed {
            return Err("only an accepted run has a pull request to mark ready".into());
        }
        mark_pr_ready(&env, &record)?;
        journal.update(|record| record.pr_ready = true);
        journal.push(EventKind::Output {
            step: "publish".into(),
            stream: "stdout".into(),
            text: "pull request marked ready for review (CI passed)".into(),
        });
        Ok(journal.record())
    }

    pub fn list(&self, limit: usize) -> Vec<RunRecord> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut records: Vec<RunRecord> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| read_record(&entry.path()).ok())
            .collect();
        records.sort_by_key(|record| std::cmp::Reverse(record.created_at));
        records.truncate(limit);
        records
    }

    pub fn events(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<RunEvent>, String> {
        read_events(&self.checked_dir(run_id)?, after_seq, limit)
    }

    /// Deletes a finished run's worktree. Uncommitted work blocks it unless confirmed.
    pub fn remove_worktree(
        &self,
        run_id: &str,
        discard_changes: bool,
    ) -> Result<RunRecord, String> {
        if self.active_run_id().as_deref() == Some(run_id) {
            return Err("stop the run before removing its worktree".into());
        }
        let journal = Journal::open(self.checked_dir(run_id)?, self.emit.clone())?;
        let record = journal.record();
        let info = record
            .worktree
            .as_ref()
            .filter(|_| !record.worktree_removed)
            .ok_or("this run has no worktree to remove")?;
        worktree::remove(
            Path::new(&record.repo_path),
            Path::new(&info.path),
            discard_changes,
        )?;
        journal.update(|record| record.worktree_removed = true);
        Ok(journal.record())
    }
}

fn pipeline(
    journal: &Arc<Journal>,
    control: &Control,
    request: &StartRun,
) -> Result<RunStatus, String> {
    let binding = &request.binding;
    let run_id = journal.record().run_id;
    journal.push(EventKind::StepStart {
        step: "worktree".into(),
        command: format!("git worktree add (from origin/{})", binding.base_branch),
    });
    let started = Instant::now();
    let info = worktree::create(CreateWorktree {
        repo: Path::new(&binding.repo_path),
        base_branch: &binding.base_branch,
        worktree_root: Path::new(&binding.worktree_root),
        issue_key: &request.issue_key,
        run_id: &run_id,
        copy_env: &binding.copy_env,
    });
    journal.push(EventKind::StepEnd {
        step: "worktree".into(),
        exit_code: Some(if info.is_ok() { 0 } else { 1 }),
        duration_ms: started.elapsed().as_millis() as u64,
    });
    let info = info?;
    let summary = format!(
        "{} on {} from {}{}",
        info.path,
        info.branch,
        &info.base_sha[..info.base_sha.len().min(12)],
        if info.copied_env.is_empty() {
            String::new()
        } else {
            format!(" · copied {}", info.copied_env.join(", "))
        }
    );
    journal.push(EventKind::Output {
        step: "worktree".into(),
        stream: "stdout".into(),
        text: summary,
    });
    if !info.missing_env.is_empty() {
        journal.push(EventKind::Output {
            step: "worktree".into(),
            stream: "stderr".into(),
            text: format!(
                "not found in the repo, not copied: {}",
                info.missing_env.join(", ")
            ),
        });
    }
    let cwd = PathBuf::from(&info.path);
    journal.update(|record| record.worktree = Some(info));

    if control.cancelled() {
        return Ok(RunStatus::Cancelled);
    }
    if let Some(install) = &binding.commands.install {
        journal.set_status(RunStatus::Installing, None);
        match run_step(
            journal,
            control,
            &Step::new("install", install, &cwd, INSTALL_TIMEOUT),
        )? {
            StepOutcome::Exited(0) => {}
            StepOutcome::Exited(code) => return Err(format!("install failed (exit code {code})")),
            StepOutcome::Cancelled => return Ok(RunStatus::Cancelled),
            StepOutcome::TimedOut | StepOutcome::OverBudget => {
                return Err("install timed out".into())
            }
        }
    }
    let Some(agent) = &request.agent else {
        return Ok(RunStatus::Prepared);
    };
    journal.set_status(RunStatus::Running, None);
    match run_step(
        journal,
        control,
        &Step::new("agent", agent, &cwd, AGENT_TIMEOUT),
    )? {
        StepOutcome::Exited(0) => Ok(RunStatus::Finished),
        StepOutcome::Exited(code) => Err(format!("agent exited with code {code}")),
        StepOutcome::Cancelled => Ok(RunStatus::Cancelled),
        StepOutcome::TimedOut | StepOutcome::OverBudget => Err("agent timed out".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::repo::RepoCommands;
    use crate::harness::testutil::{run_git, TempDir};

    struct Fixture {
        _upstream: TempDir,
        clone: TempDir,
        worktrees: TempDir,
        runs: TempDir,
        events: Arc<Mutex<Vec<RunEvent>>>,
    }

    impl Fixture {
        fn new() -> Self {
            let upstream = TempDir::new("run-upstream");
            upstream.init_repo("main");
            upstream.write(".gitignore", ".env\n");
            upstream.write("README.md", "hello\n");
            upstream.commit("chore: init");
            let clone = TempDir::new("run-clone");
            run_git(
                clone.path().parent().unwrap(),
                &[
                    "clone",
                    "-q",
                    &upstream.path().display().to_string(),
                    &clone.path().display().to_string(),
                ],
            );
            clone.write(".env", "PORT=1\n");
            Self {
                _upstream: upstream,
                clone,
                worktrees: TempDir::new("run-wt"),
                runs: TempDir::new("run-journal"),
                events: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn manager(&self) -> RunManager {
            let sink = self.events.clone();
            RunManager::new(
                self.runs.path().to_path_buf(),
                Arc::new(move |event: &RunEvent| sink.lock().unwrap().push(event.clone())),
            )
        }

        fn binding(&self, install: Option<CommandSpec>) -> RepoBinding {
            RepoBinding {
                project_id: "proj-acc1-PRJ".into(),
                repo_path: self.clone.path().display().to_string(),
                base_branch: "main".into(),
                worktree_root: self.worktrees.path().display().to_string(),
                commands: RepoCommands {
                    install,
                    ..RepoCommands::default()
                },
                copy_env: vec![".env".into()],
                services: vec![],
                env_overrides: vec![],
                updated_at: 0,
            }
        }
    }

    fn cmd(executable: &str, args: &[&str]) -> CommandSpec {
        CommandSpec {
            executable: executable.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    /// A command that runs ~30s and starts a child process holding the output pipe.
    fn long_tree() -> CommandSpec {
        if cfg!(windows) {
            cmd(
                "cmd",
                &["/c", "ping -n 30 127.0.0.1 >nul & ping -n 30 127.0.0.1"],
            )
        } else {
            cmd("sh", &["-c", "sleep 30 & sleep 30"])
        }
    }

    fn start(manager: &RunManager, binding: RepoBinding, agent: Option<CommandSpec>) -> RunRecord {
        manager
            .start(StartRun {
                task_id: "task-acc1-PRJ-1".into(),
                issue_key: "PRJ-1".into(),
                binding,
                agent,
                jira_url: None,
                context: None,
            })
            .unwrap()
    }

    fn wait_terminal(manager: &RunManager, run_id: &str, within: Duration) -> RunRecord {
        let deadline = Instant::now() + within;
        loop {
            let record = manager
                .list(usize::MAX)
                .into_iter()
                .find(|r| r.run_id == run_id)
                .unwrap();
            if record.status.is_terminal() && manager.active_run_id().is_none() {
                return record;
            }
            assert!(Instant::now() < deadline, "run still {:?}", record.status);
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn statuses(events: &[RunEvent]) -> Vec<RunStatus> {
        events
            .iter()
            .filter_map(|e| match e.kind {
                EventKind::Status { status, .. } => Some(status),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn prepares_workspace_and_journals_every_event_in_order() {
        let fx = Fixture::new();
        let manager = fx.manager();
        let run = start(&manager, fx.binding(Some(cmd("git", &["--version"]))), None);
        let done = wait_terminal(&manager, &run.run_id, Duration::from_secs(60));

        assert_eq!(done.status, RunStatus::Prepared, "{:?}", done.error);
        let worktree = done.worktree.clone().unwrap();
        assert!(Path::new(&worktree.path).join(".env").exists());
        assert_eq!(worktree.branch, format!("ai/PRJ-1-{}", run.run_id));

        let journal = manager.events(&run.run_id, 0, usize::MAX).unwrap();
        assert_eq!(
            statuses(&journal),
            vec![
                RunStatus::Preparing,
                RunStatus::Installing,
                RunStatus::Prepared
            ]
        );
        assert!(journal.iter().any(|e| matches!(&e.kind,
            EventKind::Output { step, text, .. } if step == "install" && text.starts_with("git version"))));
        let seqs: Vec<u64> = journal.iter().map(|e| e.seq).collect();
        assert_eq!(
            seqs,
            (1..=journal.len() as u64).collect::<Vec<_>>(),
            "no gaps"
        );
        let emitted = fx
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect::<Vec<_>>();
        assert_eq!(emitted, seqs, "UI sees exactly what the journal holds");

        let replay = manager.events(&run.run_id, 3, usize::MAX).unwrap();
        assert_eq!(
            replay.first().unwrap().seq,
            4,
            "replay starts after the cursor"
        );
    }

    #[test]
    fn failed_install_fails_the_run_and_keeps_the_worktree() {
        let fx = Fixture::new();
        let manager = fx.manager();
        let run = start(
            &manager,
            fx.binding(Some(cmd("git", &["not-a-command"]))),
            None,
        );
        let done = wait_terminal(&manager, &run.run_id, Duration::from_secs(60));
        assert_eq!(done.status, RunStatus::Failed);
        assert!(done.error.unwrap().contains("install failed (exit code 1)"));
        assert!(Path::new(&done.worktree.unwrap().path).exists());

        let missing = start(
            &manager,
            fx.binding(Some(cmd("not-a-tool-4f2a", &[]))),
            None,
        );
        let done = wait_terminal(&manager, &missing.run_id, Duration::from_secs(60));
        assert!(
            done.error.unwrap().contains("not installed"),
            "missing tool is explained"
        );
    }

    #[test]
    fn only_one_run_at_a_time_and_stop_kills_the_whole_tree() {
        let fx = Fixture::new();
        let manager = fx.manager();
        let run = start(&manager, fx.binding(None), Some(long_tree()));

        let deadline = Instant::now() + Duration::from_secs(60);
        while !statuses(&fx.events.lock().unwrap()).contains(&RunStatus::Running) {
            assert!(Instant::now() < deadline, "agent step never started");
            std::thread::sleep(Duration::from_millis(50));
        }
        let busy = manager
            .start(StartRun {
                task_id: "task-acc1-PRJ-2".into(),
                issue_key: "PRJ-2".into(),
                binding: fx.binding(None),
                agent: None,
                jira_url: None,
                context: None,
            })
            .unwrap_err();
        assert!(busy.contains("another run"), "{busy}");

        let stopped_at = Instant::now();
        manager.stop(&run.run_id).unwrap();
        // The grandchild holds the output pipe; the run only ends once it is gone too.
        let done = wait_terminal(&manager, &run.run_id, Duration::from_secs(15));
        assert_eq!(done.status, RunStatus::Cancelled);
        assert!(
            stopped_at.elapsed() < Duration::from_secs(4),
            "did not wait out the grace period"
        );
        let journal = manager.events(&run.run_id, 0, usize::MAX).unwrap();
        assert!(
            !journal.iter().any(|e| matches!(&e.kind,
                EventKind::Output { text, .. } if text.contains("still running"))),
            "the grandchild was killed with its parent"
        );
        assert!(manager.stop(&run.run_id).is_err(), "nothing left to stop");
    }

    #[test]
    fn worktree_removal_respects_uncommitted_work() {
        let fx = Fixture::new();
        let manager = fx.manager();
        let run = start(&manager, fx.binding(None), None);
        let done = wait_terminal(&manager, &run.run_id, Duration::from_secs(60));
        let path = PathBuf::from(done.worktree.unwrap().path);
        fs::write(path.join("README.md"), "agent change\n").unwrap();

        let error = manager.remove_worktree(&run.run_id, false).unwrap_err();
        assert!(error.contains("uncommitted"), "{error}");
        assert!(path.exists());
        let removed = manager.remove_worktree(&run.run_id, true).unwrap();
        assert!(removed.worktree_removed && !path.exists());
        assert!(
            manager.remove_worktree(&run.run_id, true).is_err(),
            "already removed"
        );
    }

    #[test]
    fn restart_marks_active_runs_interrupted_without_resuming() {
        let fx = Fixture::new();
        let dir = fx.runs.path().join("abc123def456");
        let record = RunRecord {
            run_id: "abc123def456".into(),
            task_id: "task-acc1-PRJ-1".into(),
            project_id: "proj-acc1-PRJ".into(),
            issue_key: "PRJ-1".into(),
            repo_path: fx.clone.path().display().to_string(),
            status: RunStatus::Installing,
            worktree: None,
            worktree_removed: false,
            created_at: 1,
            ended_at: None,
            error: None,
            ..RunRecord::default()
        };
        Journal::create(dir, record, Arc::new(|_| {})).unwrap();
        let finished_dir = fx.runs.path().join("fff000fff000");
        let mut finished = read_record(&fx.runs.path().join("abc123def456")).unwrap();
        finished.run_id = "fff000fff000".into();
        finished.status = RunStatus::Prepared;
        Journal::create(finished_dir, finished, Arc::new(|_| {})).unwrap();

        let manager = fx.manager();
        let runs = manager.list(usize::MAX);
        let interrupted = runs.iter().find(|r| r.run_id == "abc123def456").unwrap();
        assert_eq!(interrupted.status, RunStatus::Interrupted);
        assert!(interrupted.error.as_deref().unwrap().contains("app closed"));
        let untouched = runs.iter().find(|r| r.run_id == "fff000fff000").unwrap();
        assert_eq!(
            untouched.status,
            RunStatus::Prepared,
            "finished runs stay as they were"
        );
        assert!(manager.active_run_id().is_none(), "nothing is resumed");
    }

    #[test]
    fn events_serialize_with_camel_case_fields_for_the_webview() {
        let event = RunEvent {
            run_id: "abc123".into(),
            seq: 1,
            at: 2,
            kind: EventKind::StepEnd {
                step: "install".into(),
                exit_code: Some(0),
                duration_ms: 5,
            },
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"runId": "abc123", "seq": 1, "at": 2, "type": "step_end",
                "step": "install", "exitCode": 0, "durationMs": 5})
        );
    }

    #[test]
    fn rejects_bad_ids() {
        let fx = Fixture::new();
        let manager = fx.manager();
        assert!(manager.events("../etc", 0, 10).is_err());
        let error = manager
            .start(StartRun {
                task_id: "t".into(),
                issue_key: "bad key".into(),
                binding: fx.binding(None),
                agent: None,
                jira_url: None,
                context: None,
            })
            .unwrap_err();
        assert!(error.contains("issue key"));
        assert!(
            manager.list(10).is_empty(),
            "a rejected start leaves no run behind"
        );
    }
}
