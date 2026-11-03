// The tools a run exposes to its agent over MCP, and the permission handler the agent's CLI
// asks before using any tool. The agent has no shell: everything that executes goes through
// `run`, which the app performs itself and records in the run journal for the owner to see.
use super::bindings::is_safe_relative_path;
use super::exec::git;
use super::mcp::ToolHost;
use super::repo::{CommandSpec, RepoCommands};
use super::run::{run_step, Background, Control, EventKind, Journal, Step, StepOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CHECK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const DEV_READY_TIMEOUT: Duration = Duration::from_secs(60);
const TAIL_LINES: usize = 40;
const MAX_PLAN_CHARS: usize = 20_000;
/// Files the agent may never write: git internals, tool configuration, and the task snapshot.
const PROTECTED: &[&str] = &[".git", ".claude", ".codex", ".mcp.json", ".harness/task.md"];

/// True for git internals, agent tool configuration and the task snapshot (relative path).
pub fn is_protected(relative: &str) -> bool {
    let relative = relative.replace('\\', "/");
    PROTECTED
        .iter()
        .any(|blocked| relative == *blocked || relative.starts_with(&format!("{blocked}/")))
}

/// The agent's draft for publishing. The app adds the testing section (from its own checks)
/// and the Jira link itself; the agent never writes test results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrDraft {
    /// English, conventional commit (`feat: ...`).
    pub title: String,
    /// English commit message; first line is a conventional commit header.
    pub commit_message: String,
    /// Thai sections of the PR body.
    pub summary: String,
    pub reason: String,
    pub changes: String,
    pub impact: String,
}

const COMMIT_TYPES: &[&str] = &[
    "feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci", "style", "revert",
];

/// `type(scope)!: subject` in ASCII, at most 72 characters.
pub fn is_conventional_header(line: &str) -> bool {
    let Some((head, subject)) = line.split_once(": ") else {
        return false;
    };
    let head = head.strip_suffix('!').unwrap_or(head);
    let kind = match head.split_once('(') {
        Some((kind, scope)) => {
            let Some(scope) = scope.strip_suffix(')') else {
                return false;
            };
            if scope.is_empty()
                || !scope
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return false;
            }
            kind
        }
        None => head,
    };
    COMMIT_TYPES.contains(&kind)
        && !subject.trim().is_empty()
        && line.is_ascii()
        && line.chars().count() <= 72
}

fn has_thai(text: &str) -> bool {
    text.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c))
}

/// Mechanical rules from the team PR convention: English title and commit, Thai body,
/// no AI attribution anywhere.
pub fn validate_pr_draft(arguments: &Value) -> Result<PrDraft, String> {
    let field = |name: &str| -> Result<String, String> {
        let value = arguments
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if value.is_empty() {
            return Err(format!("{name} is required"));
        }
        if value.chars().count() > 8000 {
            return Err(format!("{name} is too long"));
        }
        let lower = value.to_lowercase();
        if lower.contains("co-authored-by") || lower.contains("generated with") {
            return Err(format!("{name} must not contain AI attribution"));
        }
        Ok(value)
    };
    let draft = PrDraft {
        title: field("title")?,
        commit_message: field("commitMessage")?,
        summary: field("summary")?,
        reason: field("reason")?,
        changes: field("changes")?,
        impact: field("impact")?,
    };
    if !is_conventional_header(&draft.title) {
        return Err("title must be an English conventional commit header, e.g. \"feat: add sum\" (ASCII, ≤ 72 chars)".into());
    }
    let header = draft.commit_message.lines().next().unwrap_or("");
    if !is_conventional_header(header) || !draft.commit_message.is_ascii() {
        return Err(
            "commitMessage must be English and start with a conventional commit header".into(),
        );
    }
    for (name, text) in [
        ("summary", &draft.summary),
        ("reason", &draft.reason),
        ("changes", &draft.changes),
    ] {
        if !has_thai(text) {
            return Err(format!("{name} must be written in Thai"));
        }
    }
    Ok(draft)
}

/// What an independent reviewer agent found. It informs the owner; it never decides.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentReview {
    /// `approve`, `concerns`, or `unavailable` when the reviewer could not run.
    pub verdict: String,
    pub summary: String,
    pub findings: Vec<ReviewFinding>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewFinding {
    pub file: String,
    pub issue: String,
}

const MAX_FINDINGS: usize = 20;

pub fn validate_review(arguments: &Value) -> Result<AgentReview, String> {
    let verdict = arguments
        .get("verdict")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !["approve", "concerns"].contains(&verdict) {
        return Err("verdict must be \"approve\" or \"concerns\"".into());
    }
    let summary = arguments
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if summary.is_empty() || summary.chars().count() > 4000 {
        return Err("summary is required (at most 4000 characters)".into());
    }
    let findings: Vec<ReviewFinding> = arguments
        .get("findings")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_FINDINGS)
                .filter_map(|item| {
                    let issue = item.get("issue").and_then(Value::as_str)?.trim();
                    (!issue.is_empty()).then(|| ReviewFinding {
                        file: item
                            .get("file")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(300)
                            .collect(),
                        issue: issue.chars().take(1000).collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if verdict == "concerns" && findings.is_empty() {
        return Err("list at least one finding when the verdict is \"concerns\"".into());
    }
    Ok(AgentReview {
        verdict: verdict.into(),
        summary: summary.into(),
        findings,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Phase {
    /// Read-only: explore and `submit_plan`.
    Planning = 0,
    /// Edit files and ask the app to run checks.
    Implementing = 1,
    /// Read-only review of the finished change (reviewer agent).
    Reviewing = 2,
    /// Read-only: write the commit message and pull request draft with `submit_pr_draft`.
    Drafting = 3,
}

pub struct RunTools {
    journal: Arc<Journal>,
    control: Arc<Control>,
    worktree: PathBuf,
    commands: RepoCommands,
    skills_dir: PathBuf,
    phase: AtomicU8,
    plan: Mutex<Option<String>>,
    pr_draft: Mutex<Option<PrDraft>>,
    review: Mutex<Option<AgentReview>>,
    dev: Mutex<Option<(Background, u16)>>,
    exec_ms: AtomicU64,
    calls: AtomicU32,
}

impl RunTools {
    pub fn new(
        journal: Arc<Journal>,
        control: Arc<Control>,
        worktree: PathBuf,
        commands: RepoCommands,
        skills_dir: PathBuf,
    ) -> Self {
        Self {
            journal,
            control,
            worktree,
            commands,
            skills_dir,
            phase: AtomicU8::new(Phase::Planning as u8),
            plan: Mutex::new(None),
            pr_draft: Mutex::new(None),
            review: Mutex::new(None),
            dev: Mutex::new(None),
            exec_ms: AtomicU64::new(0),
            calls: AtomicU32::new(0),
        }
    }

    pub fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::SeqCst);
    }

    fn phase(&self) -> Phase {
        match self.phase.load(Ordering::SeqCst) {
            0 => Phase::Planning,
            1 => Phase::Implementing,
            2 => Phase::Reviewing,
            _ => Phase::Drafting,
        }
    }

    /// The pull request draft submitted in the drafting step, if any.
    /// The independent review submitted in the reviewing step, if any.
    pub fn take_review(&self) -> Option<AgentReview> {
        self.review.lock().unwrap().take()
    }

    pub fn take_pr_draft(&self) -> Option<PrDraft> {
        self.pr_draft.lock().unwrap().take()
    }

    /// The plan submitted in the last planning round, if any (taking it clears it).
    pub fn take_plan(&self) -> Option<String> {
        self.plan.lock().unwrap().take()
    }

    /// Time spent executing commands for the agent; excluded from its working-time budget.
    pub fn exec_ms(&self) -> u64 {
        self.exec_ms.load(Ordering::SeqCst)
    }

    /// Stops the dev server, if the agent started one. Called when the run ends.
    pub fn shutdown(&self) {
        if let Some((dev, _)) = self.dev.lock().unwrap().take() {
            dev.stop(&self.control);
        }
    }

    fn in_worktree(&self, file: &str) -> Option<String> {
        let path = Path::new(file);
        let relative = if path.is_absolute() {
            path.strip_prefix(&self.worktree).ok()?.to_path_buf()
        } else {
            path.to_path_buf()
        };
        let normal = relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
        (normal && relative.components().next().is_some())
            .then(|| relative.to_string_lossy().replace('\\', "/"))
    }

    fn allowed_tools(&self) -> &'static [&'static str] {
        match self.phase() {
            Phase::Planning => &["skill_list", "skill_get", "git", "get_log", "submit_plan"],
            Phase::Implementing => &["skill_list", "skill_get", "git", "get_log", "run"],
            Phase::Reviewing => &["skill_list", "skill_get", "git", "get_log", "submit_review"],
            Phase::Drafting => &[
                "skill_list",
                "skill_get",
                "git",
                "get_log",
                "submit_pr_draft",
            ],
        }
    }

    fn decide(&self, tool: &str, input: &Value) -> Result<(), String> {
        if let Some(name) = tool.strip_prefix("mcp__harness__") {
            return if self.allowed_tools().contains(&name) {
                Ok(())
            } else {
                Err(format!("{name} is not available while {:?}", self.phase()))
            };
        }
        match tool {
            "Read" | "Glob" | "Grep" => Ok(()),
            "Edit" | "Write" | "NotebookEdit" => {
                if self.phase() != Phase::Implementing {
                    return Err("files cannot be changed before the owner approves the plan".into());
                }
                let file = input
                    .get("file_path")
                    .or_else(|| input.get("notebook_path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let relative = self
                    .in_worktree(file)
                    .ok_or("only files inside the run worktree can be changed")?;
                if is_protected(&relative) {
                    return Err(format!("{relative} is protected in a harness run"));
                }
                Ok(())
            }
            _ => Err(format!(
                "{tool} is not available in a harness run; use the harness tools"
            )),
        }
    }

    /// Permission handler for `--permission-prompt-tool mcp__harness__approve`.
    fn approve(&self, arguments: &Value) -> String {
        let tool = arguments
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let input = arguments.get("input").cloned().unwrap_or(json!({}));
        let decision = self.decide(tool, &input);
        self.journal.push(EventKind::Permission {
            tool: tool.into(),
            decision: if decision.is_ok() { "allow" } else { "deny" }.into(),
        });
        match decision {
            Ok(()) => json!({ "behavior": "allow", "updatedInput": input }),
            Err(message) => json!({ "behavior": "deny", "message": message }),
        }
        .to_string()
    }

    fn skills(&self) -> Vec<(String, String)> {
        let Ok(entries) = fs::read_dir(&self.skills_dir) else {
            return Vec::new();
        };
        let mut skills: Vec<(String, String)> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("SKILL.md").is_file())
            .map(|entry| {
                let text = fs::read_to_string(entry.path().join("SKILL.md")).unwrap_or_default();
                let description = text
                    .lines()
                    .find_map(|line| line.strip_prefix("description:"))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    description,
                )
            })
            .collect();
        skills.sort();
        skills
    }

    fn skill_get(&self, arguments: &Value) -> Result<String, String> {
        let name = arguments.get("name").and_then(Value::as_str).unwrap_or("");
        if !self.skills().iter().any(|(skill, _)| skill == name) {
            return Err(format!("unknown skill \"{name}\""));
        }
        let file = arguments
            .get("file")
            .and_then(Value::as_str)
            .unwrap_or("SKILL.md");
        if !is_safe_relative_path(file) {
            return Err(format!("\"{file}\" is not a file of skill {name}"));
        }
        fs::read_to_string(self.skills_dir.join(name).join(file))
            .map_err(|_| format!("skill {name} has no file \"{file}\""))
    }

    fn git(&self, arguments: &Value) -> Result<String, String> {
        let args: &[&str] = match arguments.get("op").and_then(Value::as_str).unwrap_or("") {
            "status" => &["status", "--short", "--branch"],
            "diff" => &["diff", "--stat", "--patch"],
            "log" => &["log", "--oneline", "-n", "20"],
            "show" => &["show", "--stat", "HEAD"],
            other => {
                return Err(format!(
                    "op \"{other}\" must be one of status, diff, log, show"
                ))
            }
        };
        git(args, &self.worktree, Duration::from_secs(30))
    }

    fn get_log(&self, arguments: &Value) -> Result<String, String> {
        let log_id = arguments.get("logId").and_then(Value::as_str).unwrap_or("");
        if !(log_id == "dev" || log_id.starts_with("agent:")) {
            return Err("logId must come from a run result (or be \"dev\")".into());
        }
        let lines = self.journal.step_lines(log_id);
        let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = arguments
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .min(500) as usize;
        Ok(json!({
            "logId": log_id,
            "totalLines": lines.len(),
            "offset": offset,
            "lines": lines.iter().skip(offset).take(limit).cloned().collect::<Vec<_>>().join("\n"),
        })
        .to_string())
    }

    fn timed<T>(&self, work: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let result = work();
        self.exec_ms
            .fetch_add(started.elapsed().as_millis() as u64, Ordering::SeqCst);
        result
    }

    fn execute(&self, command: &str, spec: &CommandSpec) -> Result<String, String> {
        let step = format!(
            "agent:{command}#{}",
            self.calls.fetch_add(1, Ordering::SeqCst) + 1
        );
        let outcome = self.timed(|| {
            run_step(
                &self.journal,
                &self.control,
                &Step::new(&step, spec, &self.worktree, CHECK_TIMEOUT),
            )
        })?;
        let lines = self.journal.step_lines(&step);
        let tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
        let (status, exit_code) = match outcome {
            StepOutcome::Exited(0) => ("passed", Some(0)),
            StepOutcome::Exited(code) => ("failed", Some(code)),
            StepOutcome::Cancelled => ("stopped", None),
            StepOutcome::TimedOut | StepOutcome::OverBudget => ("timed_out", None),
        };
        Ok(json!({ "status": status, "exitCode": exit_code, "logId": step, "totalLines": lines.len(), "tail": tail }).to_string())
    }

    fn start_dev(&self) -> Result<String, String> {
        let spec = self
            .commands
            .dev
            .clone()
            .ok_or("this repository has no dev command in Setup")?;
        let mut dev = self.dev.lock().unwrap();
        if let Some((process, port)) = dev.as_mut() {
            if process.is_running() {
                return Ok(
                    json!({ "status": "running", "baseUrl": format!("http://127.0.0.1:{port}") })
                        .to_string(),
                );
            }
        }
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .map_err(|e| e.to_string())?
            .port();
        let env = [("PORT".to_string(), port.to_string())];
        let mut step = Step::new("dev", &spec, &self.worktree, CHECK_TIMEOUT);
        step.env = &env;
        let mut process = Background::start(&self.journal, &self.control, &step)?;
        let ready = self.timed(|| {
            let deadline = Instant::now() + DEV_READY_TIMEOUT;
            while Instant::now() < deadline && process.is_running() {
                if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            false
        });
        if !ready {
            process.stop(&self.control);
            let lines = self.journal.step_lines("dev");
            return Err(format!(
                "dev did not listen on port {port} (it must read the PORT env var). Last output:\n{}",
                lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n")
            ));
        }
        *dev = Some((process, port));
        Ok(json!({ "status": "running", "baseUrl": format!("http://127.0.0.1:{port}"), "logId": "dev" }).to_string())
    }

    fn run(&self, arguments: &Value) -> Result<String, String> {
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("");
        match command {
            "dev" => self.start_dev(),
            "hurl" => {
                let port = self
                    .dev
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, port)| *port)
                    .ok_or("start dev first: run with command \"dev\"")?;
                let files: Vec<String> = arguments
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|files| files.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                if files.is_empty() {
                    return Err("files: list the .hurl files to run".into());
                }
                let mut args = vec![
                    "--test".to_string(),
                    "--no-color".into(),
                    "--variable".into(),
                    format!("base_url=http://127.0.0.1:{port}"),
                ];
                for file in files {
                    let relative = self
                        .in_worktree(&file)
                        .filter(|relative| relative.ends_with(".hurl"))
                        .ok_or_else(|| format!("{file} is not a .hurl file in the worktree"))?;
                    args.push(relative);
                }
                self.execute("hurl", &CommandSpec { executable: "hurl".into(), args })
            }
            "build" | "test" | "lint" => {
                let spec = match command {
                    "build" => self.commands.build.clone(),
                    "test" => self.commands.test.clone(),
                    _ => self.commands.lint.clone(),
                }
                .ok_or_else(|| format!("this repository has no {command} command in Setup"))?;
                self.execute(command, &spec)
            }
            "install" => Err("dependencies are installed by the app; edit the manifest and say so in your report".into()),
            other => Err(format!("unknown command \"{other}\"; use build, test, lint, dev or hurl")),
        }
    }

    fn submit_plan(&self, arguments: &Value) -> Result<String, String> {
        let plan = arguments
            .get("plan")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if plan.is_empty() {
            return Err("plan is empty".into());
        }
        if plan.chars().count() > MAX_PLAN_CHARS {
            return Err(format!("plan is longer than {MAX_PLAN_CHARS} characters"));
        }
        self.journal.push(EventKind::Agent {
            kind: "plan".into(),
            text: plan.into(),
        });
        *self.plan.lock().unwrap() = Some(plan.into());
        Ok(
            "Plan received. Stop now: the owner reviews it and you continue only after approval."
                .into(),
        )
    }
}

impl ToolHost for RunTools {
    fn tools(&self) -> Vec<Value> {
        let string = json!({ "type": "string" });
        let all = vec![
            json!({ "name": "skill_list", "description": "List the skills JiraSync Hub provides for this run. These are the only skills available.", "inputSchema": { "type": "object", "properties": {} } }),
            json!({ "name": "skill_get", "description": "Load a skill from JiraSync Hub: SKILL.md by default, or a file it links to (e.g. references/hurl.md).", "inputSchema": { "type": "object", "properties": { "name": string, "file": string }, "required": ["name"] } }),
            json!({ "name": "git", "description": "Read-only git information for the worktree.", "inputSchema": { "type": "object", "properties": { "op": { "type": "string", "enum": ["status", "diff", "log", "show"] } }, "required": ["op"] } }),
            json!({ "name": "get_log", "description": "Read a page of the full output of an earlier run (its logId) or of the dev server (\"dev\").", "inputSchema": { "type": "object", "properties": { "logId": string, "offset": { "type": "number" }, "limit": { "type": "number" } }, "required": ["logId"] } }),
            json!({ "name": "run", "description": "Ask the app to execute a project command in the worktree: build, test, lint, dev (starts the dev server) or hurl (runs .hurl files against dev). The owner sees it live. Returns status, exitCode, logId and the output tail.", "inputSchema": { "type": "object", "properties": { "command": { "type": "string", "enum": ["build", "test", "lint", "dev", "hurl"] }, "files": { "type": "array", "items": string } }, "required": ["command"] } }),
            json!({ "name": "submit_plan", "description": "Submit your implementation plan (markdown: goal, files to change, steps, checks to run) for the owner to approve. Only during planning.", "inputSchema": { "type": "object", "properties": { "plan": string }, "required": ["plan"] } }),
            json!({ "name": "submit_review", "description": "Submit your independent review of the change: verdict approve or concerns, a short summary, and findings (file + issue) for anything that does not match the task, is risky, or is untested. Only while reviewing.", "inputSchema": { "type": "object", "properties": { "verdict": { "type": "string", "enum": ["approve", "concerns"] }, "summary": string, "findings": { "type": "array", "items": { "type": "object", "properties": { "file": string, "issue": string }, "required": ["issue"] } } }, "required": ["verdict", "summary"] } }),
            json!({ "name": "submit_pr_draft", "description": "Submit the commit message and pull request text for the accepted change. title and commitMessage: English conventional commit (feat: ..., fix: ...). summary, reason, changes, impact: Thai markdown bullets grounded in the actual diff. Do not write test results or AI attribution; the app adds the testing section from its own checks.", "inputSchema": { "type": "object", "properties": { "title": string, "commitMessage": string, "summary": string, "reason": string, "changes": string, "impact": string }, "required": ["title", "commitMessage", "summary", "reason", "changes", "impact"] } }),
            json!({ "name": "approve", "description": "Permission handler used by the app. Not for the agent.", "inputSchema": { "type": "object", "properties": { "tool_name": string, "input": { "type": "object" }, "tool_use_id": string }, "required": ["tool_name", "input"] } }),
        ];
        let allowed = self.allowed_tools();
        all.into_iter()
            .filter(|tool| {
                let name = tool["name"].as_str().unwrap_or("");
                name == "approve" || allowed.contains(&name)
            })
            .collect()
    }

    fn call(&self, name: &str, arguments: Value) -> Result<String, String> {
        if name == "approve" {
            return Ok(self.approve(&arguments));
        }
        if !self.allowed_tools().contains(&name) {
            return Err(format!("{name} is not available while {:?}", self.phase()));
        }
        match name {
            "skill_list" => Ok(json!({
                "skills": self.skills().into_iter().map(|(name, description)| json!({ "name": name, "description": description })).collect::<Vec<_>>()
            })
            .to_string()),
            "skill_get" => self.skill_get(&arguments),
            "git" => self.git(&arguments),
            "get_log" => self.get_log(&arguments),
            "run" => self.run(&arguments),
            "submit_plan" => self.submit_plan(&arguments),
            "submit_review" => {
                let review = validate_review(&arguments)?;
                self.journal.push(EventKind::Agent {
                    kind: "review".into(),
                    text: format!("{}: {}", review.verdict, review.summary),
                });
                *self.review.lock().unwrap() = Some(review);
                Ok("Review received. Stop now.".into())
            }
            "submit_pr_draft" => {
                let draft = validate_pr_draft(&arguments)?;
                self.journal.push(EventKind::Agent {
                    kind: "pr_draft".into(),
                    text: draft.title.clone(),
                });
                *self.pr_draft.lock().unwrap() = Some(draft);
                Ok("Draft received. Stop now: the app commits, pushes and opens the Draft PR.".into())
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::exec::resolve_executable;
    use crate::harness::run::{RunRecord, RunStatus};
    use crate::harness::testutil::TempDir;

    struct Fixture {
        repo: TempDir,
        _journal_dir: TempDir,
        tools: RunTools,
    }

    fn cmd(executable: &str, args: &[&str]) -> CommandSpec {
        CommandSpec {
            executable: executable.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn fixture(commands: RepoCommands) -> Fixture {
        let repo = TempDir::new("tools-repo");
        repo.init_repo("main");
        repo.write("README.md", "hello\n");
        repo.commit("chore: init");
        let journal_dir = TempDir::new("tools-journal");
        let record = RunRecord {
            run_id: "abc123".into(),
            task_id: "t".into(),
            project_id: "p".into(),
            issue_key: "PRJ-1".into(),
            repo_path: repo.path().display().to_string(),
            status: RunStatus::Running,
            worktree: None,
            worktree_removed: false,
            created_at: 0,
            ended_at: None,
            error: None,
            ..RunRecord::default()
        };
        let journal = Arc::new(
            Journal::create(journal_dir.path().join("abc123"), record, Arc::new(|_| {})).unwrap(),
        );
        let tools = RunTools::new(
            journal,
            Arc::new(Control::default()),
            repo.path().to_path_buf(),
            commands,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills"),
        );
        Fixture {
            repo,
            _journal_dir: journal_dir,
            tools,
        }
    }

    fn names(tools: &RunTools) -> Vec<String> {
        tools
            .tools()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn decision(tools: &RunTools, tool: &str, input: Value) -> String {
        let reply = tools
            .call("approve", json!({ "tool_name": tool, "input": input }))
            .unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        reply["behavior"].as_str().unwrap().to_string()
    }

    fn parse(reply: Result<String, String>) -> Value {
        serde_json::from_str(&reply.unwrap()).unwrap()
    }

    #[test]
    fn planning_is_read_only_and_collects_the_plan() {
        let fx = fixture(RepoCommands {
            test: Some(cmd("git", &["--version"])),
            ..RepoCommands::default()
        });
        let tools = &fx.tools;
        assert!(names(tools).contains(&"submit_plan".to_string()));
        assert!(
            !names(tools).contains(&"run".to_string()),
            "no execution while planning"
        );
        assert!(tools.call("run", json!({ "command": "test" })).is_err());
        let readme = fx.repo.path().join("README.md").display().to_string();
        assert_eq!(
            decision(tools, "Edit", json!({ "file_path": readme })),
            "deny"
        );
        assert_eq!(
            decision(tools, "Read", json!({ "file_path": readme })),
            "allow"
        );

        assert!(tools.call("submit_plan", json!({ "plan": "  " })).is_err());
        tools
            .call("submit_plan", json!({ "plan": "1. change README" }))
            .unwrap();
        assert_eq!(tools.take_plan().as_deref(), Some("1. change README"));
        assert_eq!(tools.take_plan(), None, "taking the plan clears it");

        tools.set_phase(Phase::Implementing);
        assert!(!names(tools).contains(&"submit_plan".to_string()));
        assert!(tools.call("submit_plan", json!({ "plan": "x" })).is_err());
        assert_eq!(
            decision(tools, "Edit", json!({ "file_path": readme })),
            "allow"
        );
    }

    #[test]
    fn permission_handler_keeps_writes_inside_the_worktree() {
        let fx = fixture(RepoCommands::default());
        let tools = &fx.tools;
        tools.set_phase(Phase::Implementing);
        let inside = |relative: &str| fx.repo.path().join(relative).display().to_string();
        for allowed in ["src/a.ts", ".harness/progress.md", ".harness/http/x.hurl"] {
            let verdict = decision(tools, "Write", json!({ "file_path": inside(allowed) }));
            assert_eq!(verdict, "allow", "{allowed}");
        }
        assert_eq!(
            decision(tools, "Write", json!({ "file_path": "src/relative.ts" })),
            "allow"
        );
        for denied in [
            ".git/config",
            ".claude/settings.json",
            ".mcp.json",
            ".harness/task.md",
        ] {
            let verdict = decision(tools, "Write", json!({ "file_path": inside(denied) }));
            assert_eq!(verdict, "deny", "{denied}");
        }
        let outside = fx.repo.path().parent().unwrap().join("outside.txt");
        let outside = outside.display().to_string();
        assert_eq!(
            decision(tools, "Write", json!({ "file_path": outside })),
            "deny"
        );
        assert_eq!(
            decision(tools, "Write", json!({ "file_path": "../escape.txt" })),
            "deny"
        );
        assert_eq!(decision(tools, "Bash", json!({ "command": "ls" })), "deny");
        assert_eq!(
            decision(tools, "WebFetch", json!({ "url": "https://x" })),
            "deny"
        );
        assert_eq!(decision(tools, "mcp__harness__run", json!({})), "allow");
        assert_eq!(
            decision(tools, "mcp__harness__submit_plan", json!({})),
            "deny"
        );
    }

    #[test]
    fn run_executes_only_bound_commands_and_reports_the_tail() {
        let fx = fixture(RepoCommands {
            test: Some(cmd("git", &["--version"])),
            build: Some(cmd("git", &["not-a-command"])),
            ..RepoCommands::default()
        });
        let tools = &fx.tools;
        tools.set_phase(Phase::Implementing);

        let passed = parse(tools.call("run", json!({ "command": "test" })));
        assert_eq!(passed["status"], "passed");
        assert!(passed["tail"].as_str().unwrap().starts_with("git version"));
        let log = parse(tools.call("get_log", json!({ "logId": passed["logId"] })));
        assert_eq!(log["totalLines"], 1);

        let failed = parse(tools.call("run", json!({ "command": "build" })));
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["exitCode"], 1);

        for command in ["lint", "install", "rm -rf /", "hurl"] {
            let result = tools.call("run", json!({ "command": command }));
            assert!(result.is_err(), "{command}");
        }
        let escape = tools.call("get_log", json!({ "logId": "../../etc/passwd" }));
        assert!(escape.is_err());
        assert!(
            tools.exec_ms() > 0,
            "execution time is tracked for the budget"
        );
    }

    #[test]
    fn skills_come_only_from_the_app() {
        let fx = fixture(RepoCommands::default());
        let tools = &fx.tools;
        let list = parse(tools.call("skill_list", json!({})));
        assert_eq!(list["skills"][0]["name"], "harness");
        let skill = tools
            .call("skill_get", json!({ "name": "harness" }))
            .unwrap();
        assert!(skill.contains("# Working in a JiraSync Hub run"));
        let reference = tools
            .call(
                "skill_get",
                json!({ "name": "harness", "file": "references/hurl.md" }),
            )
            .unwrap();
        assert!(reference.contains("Hurl reference"));
        let escape = tools.call(
            "skill_get",
            json!({ "name": "harness", "file": "../../Cargo.toml" }),
        );
        assert!(escape.is_err());
        assert!(tools.call("skill_get", json!({ "name": "nope" })).is_err());
    }

    #[test]
    fn dev_server_and_hurl_run_through_the_app() {
        if resolve_executable("bun").is_none() || resolve_executable("hurl").is_none() {
            eprintln!("skipped: needs bun and hurl on PATH");
            return;
        }
        let server = "Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({ ok: true }) }); console.log(\"listening\")";
        let fx = fixture(RepoCommands {
            dev: Some(cmd("bun", &["-e", server])),
            ..RepoCommands::default()
        });
        let tools = &fx.tools;
        tools.set_phase(Phase::Implementing);
        let early = tools.call("run", json!({ "command": "hurl", "files": ["a.hurl"] }));
        assert!(early.unwrap_err().contains("start dev first"));

        let dev = parse(tools.call("run", json!({ "command": "dev" })));
        assert_eq!(dev["status"], "running");
        fx.repo.write(
            ".harness/http/ok.hurl",
            "GET {{base_url}}/\nHTTP 200\n[Asserts]\njsonpath \"$.ok\" == true\n",
        );
        fx.repo
            .write(".harness/http/bad.hurl", "GET {{base_url}}/\nHTTP 404\n");
        let ok = parse(tools.call(
            "run",
            json!({ "command": "hurl", "files": [".harness/http/ok.hurl"] }),
        ));
        assert_eq!(ok["status"], "passed", "{ok}");
        let bad = parse(tools.call(
            "run",
            json!({ "command": "hurl", "files": [".harness/http/bad.hurl"] }),
        ));
        assert_eq!(bad["exitCode"], 4, "assert failure is reported, not hidden");
        let escape = tools.call("run", json!({ "command": "hurl", "files": ["../x.hurl"] }));
        assert!(escape.is_err());
        let dev_log = tools.journal.step_lines("dev");
        assert!(
            dev_log.iter().any(|line| line == "listening"),
            "dev log is readable"
        );

        let address = dev["baseUrl"]
            .as_str()
            .unwrap()
            .trim_start_matches("http://")
            .to_string();
        tools.shutdown();
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            TcpStream::connect(address).is_err(),
            "dev server stops with the run"
        );
    }

    fn draft(overrides: Value) -> Value {
        let mut base = json!({
            "title": "feat(sum): implement sum",
            "commitMessage": "feat(sum): implement sum\n\nReturn a + b instead of throwing.",
            "summary": "- เพิ่มการคำนวณ `sum`",
            "reason": "ฟังก์ชันเดิม throw error ทำให้ test ไม่ผ่าน",
            "changes": "- แก้ `src/sum.ts` ให้คืนค่า `a + b`",
            "impact": "- Breaking change: ไม่มี"
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    #[test]
    fn pr_drafts_follow_the_team_convention() {
        let ok = validate_pr_draft(&draft(json!({}))).unwrap();
        assert_eq!(ok.title, "feat(sum): implement sum");
        for (field, value, reason) in [
            ("title", "เพิ่ม sum", "title must be English"),
            ("title", "implement sum", "title needs a conventional type"),
            ("title", "feature: add sum", "unknown type"),
            (
                "commitMessage",
                "add sum",
                "commit needs a conventional header",
            ),
            ("commitMessage", "feat: เพิ่ม sum", "commit must be English"),
            ("summary", "- add sum", "body must be Thai"),
            ("changes", "", "empty section"),
            (
                "impact",
                "- ไม่มี\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
                "no AI attribution",
            ),
        ] {
            let result = validate_pr_draft(&draft(json!({ field: value })));
            assert!(result.is_err(), "{reason}");
        }
        assert!(is_conventional_header("fix!: drop the old api"));
        assert!(!is_conventional_header(&format!(
            "feat: {}",
            "x".repeat(80)
        )));
    }

    #[test]
    fn pr_draft_tool_is_only_available_while_drafting() {
        let fx = fixture(RepoCommands::default());
        let tools = &fx.tools;
        tools.set_phase(Phase::Implementing);
        assert!(tools.call("submit_pr_draft", draft(json!({}))).is_err());
        tools.set_phase(Phase::Drafting);
        assert!(
            !names(tools).contains(&"run".to_string()),
            "drafting cannot execute"
        );
        let readme = fx.repo.path().join("README.md").display().to_string();
        assert_eq!(
            decision(tools, "Edit", json!({ "file_path": readme })),
            "deny"
        );
        let rejected = tools.call("submit_pr_draft", draft(json!({ "summary": "- add sum" })));
        assert!(rejected.unwrap_err().contains("Thai"));
        assert!(
            tools.take_pr_draft().is_none(),
            "a rejected draft is not kept"
        );
        tools.call("submit_pr_draft", draft(json!({}))).unwrap();
        assert_eq!(
            tools.take_pr_draft().unwrap().title,
            "feat(sum): implement sum"
        );
    }
}
