// Codex adapter (Phase 3): talks to `codex app-server` over stdio (newline-delimited JSON-RPC).
// Codex has no flag to remove its shell tool, so the harness rule "the agent has no shell" is
// enforced through approvals instead: every command Codex wants to run is declined by the app,
// file changes are accepted only inside the worktree, and execution goes through the same
// harness MCP tools Claude uses.
use super::claude::AgentLauncher;
use super::tools::is_protected;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// The owner personal Codex setup (hooks, plugins, apps, skills) never runs inside a harness
/// run; the app provides the only skills and tools, like `--restricted` does for Claude.
pub const ISOLATION: &[&str] = &[
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "skill_search",
    "--disable",
    "remote_plugin",
    "--disable",
    "plugin_discovery_prefetch",
    "--disable",
    "skill_mcp_dependency_install",
    "--enable",
    "skip_host_skill_discovery",
];

/// What the app decided about one approval request, for the run journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub kind: String,
    pub detail: String,
    pub allowed: bool,
}

pub struct AppServer {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
    /// Paths of file-change items, by item id (approvals only carry the id).
    file_items: HashMap<String, Vec<String>>,
}

pub struct TurnPolicy<'a> {
    pub worktree: &'a Path,
    /// False while planning or reviewing: no file changes at all.
    pub allow_file_changes: bool,
}

#[derive(Debug, Default)]
pub struct TurnReport {
    pub status: String,
    pub decisions: Vec<Decision>,
    pub messages: Vec<String>,
}

impl AppServer {
    pub fn start(
        launcher: &AgentLauncher,
        cwd: &Path,
        env: &[(String, String)],
    ) -> Result<Self, String> {
        let cli: Vec<String> = std::iter::once("app-server")
            .chain(ISOLATION.iter().copied())
            .map(str::to_string)
            .collect();
        let mut command = Command::new(&launcher.executable);
        command.args(&launcher.prefix_args);
        match &launcher.args_env {
            Some(name) => {
                command.env(name, serde_json::to_string(&cli).unwrap());
            }
            None => {
                command.args(&cli);
            }
        }
        command
            .envs(launcher.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        super::exec::hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start codex app-server: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (send, messages) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if send.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        let mut server = Self {
            child,
            stdin,
            messages,
            next_id: 1,
            file_items: HashMap::new(),
        };
        server.call(
            "initialize",
            json!({ "clientInfo": { "name": "jirasync-hub", "version": env!("CARGO_PKG_VERSION") } }),
            Duration::from_secs(60),
        )?;
        server.send(&json!({ "method": "initialized" }))?;
        Ok(server)
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{message}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    /// Sends a request and waits for its response; other messages are dropped here.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = self
                .messages
                .recv_timeout(left)
                .map_err(|_| format!("codex did not answer {method}"))?;
            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(format!("codex {method} failed: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    /// Runs one turn to completion, answering every approval request by the harness rules.
    pub fn run_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        policy: &TurnPolicy,
        on_event: &mut dyn FnMut(&str, &Value),
        stop: &dyn Fn() -> Option<&'static str>,
        timeout: Duration,
    ) -> Result<TurnReport, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({
            "id": id,
            "method": "turn/start",
            "params": { "threadId": thread_id, "input": [{ "type": "text", "text": text }] }
        }))?;
        let mut report = TurnReport::default();
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("the Codex turn timed out".into());
            }
            // Wake up regularly so Stop and the working-time budget take effect mid-turn.
            if let Some(reason) = stop() {
                report.status = reason.into();
                return Ok(report);
            }
            let tick = left.min(Duration::from_millis(200));
            let message = match self.messages.recv_timeout(tick) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err("codex app-server exited".into()),
            };
            let method = message.get("method").and_then(Value::as_str).unwrap_or("");
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            match (message.get("id"), method) {
                (Some(request_id), method) if !method.is_empty() => {
                    if method == "mcpServer/elicitation/request" {
                        on_event("elicitation", &params);
                    }
                    let (result, decision) = self.answer(method, &params, policy);
                    if let Some(decision) = decision {
                        on_event(
                            "decision",
                            &json!({ "kind": decision.kind, "detail": decision.detail, "allowed": decision.allowed }),
                        );
                        report.decisions.push(decision);
                    }
                    self.send(&json!({ "id": request_id, "result": result }))?;
                }
                (_, "item/started") | (_, "item/completed") => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                        let paths = item
                            .get("changes")
                            .and_then(Value::as_array)
                            .map(|changes| {
                                changes
                                    .iter()
                                    .filter_map(|c| {
                                        c.get("path").and_then(Value::as_str).map(str::to_string)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                            self.file_items.insert(item_id.to_string(), paths);
                        }
                    }
                    if method == "item/completed" {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                                report.messages.push(text.to_string());
                            }
                        }
                    }
                    on_event(method, &item);
                }
                (_, "turn/completed") => {
                    report.status = params
                        .pointer("/turn/status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_string();
                    return Ok(report);
                }
                (_, "error") => on_event("error", &params),
                (_, method) if !method.is_empty() => on_event(method, &params),
                _ => {}
            }
        }
    }

    fn answer(
        &self,
        method: &str,
        params: &Value,
        policy: &TurnPolicy,
    ) -> (Value, Option<Decision>) {
        match method {
            // The agent has no shell: the app runs commands through the harness tools only.
            "item/commandExecution/requestApproval" | "execCommandApproval" => {
                let command = params
                    .get("command")
                    .map(|c| match c {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                (
                    json!({ "decision": "decline" }),
                    Some(Decision {
                        kind: "command".into(),
                        detail: command,
                        allowed: false,
                    }),
                )
            }
            "item/fileChange/requestApproval" | "applyPatchApproval" => {
                let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
                let paths = self.file_items.get(item_id).cloned().unwrap_or_default();
                let inside = !paths.is_empty()
                    && paths.iter().all(|path| {
                        within(policy.worktree, path)
                            && !is_protected(&relative_to(policy.worktree, path))
                    });
                let allowed = policy.allow_file_changes && inside;
                (
                    json!({ "decision": if allowed { "accept" } else { "decline" } }),
                    Some(Decision {
                        kind: "file".into(),
                        detail: paths.join(", "),
                        allowed,
                    }),
                )
            }
            // Codex asks before each MCP tool call; only the app own harness server is allowed
            // (which tools a phase may use is enforced by the harness tools themselves).
            "mcpServer/elicitation/request" => {
                let server = params
                    .get("serverName")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let allowed = server == "harness";
                let content = defaults(params.get("requestedSchema"));
                let result = if allowed {
                    json!({ "action": "accept", "content": content })
                } else {
                    json!({ "action": "decline" })
                };
                (
                    result,
                    Some(Decision {
                        kind: "mcp".into(),
                        detail: server.into(),
                        allowed,
                    }),
                )
            }
            // Anything else (permission escalation, user input) is refused.
            other => (
                json!({ "decision": "decline" }),
                Some(Decision {
                    kind: other.into(),
                    detail: String::new(),
                    allowed: false,
                }),
            ),
        }
    }
}

impl AppServer {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        // Codex may have started helpers (MCP clients, sandboxes): stop the whole tree.
        super::run::kill_tree(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Default answers for a form elicitation (Codex asks a yes/no style question per tool call).
fn defaults(schema: Option<&Value>) -> Value {
    let mut content = serde_json::Map::new();
    if let Some(properties) = schema
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object)
    {
        for (name, property) in properties {
            let value = property.get("default").cloned().unwrap_or_else(|| {
                match property.get("type").and_then(Value::as_str) {
                    Some("boolean") => json!(true),
                    Some("number") | Some("integer") => json!(0),
                    _ => property
                        .get("enum")
                        .and_then(|e| e.get(0))
                        .cloned()
                        .unwrap_or(json!("")),
                }
            });
            content.insert(name.clone(), value);
        }
    }
    Value::Object(content)
}

fn relative_to(worktree: &Path, path: &str) -> String {
    let candidate = Path::new(path);
    candidate
        .strip_prefix(worktree)
        .unwrap_or(candidate)
        .to_string_lossy()
        .replace('\\', "/")
}

/// True when `path` (absolute or relative to the worktree) stays inside it and avoids .git.
pub fn within(worktree: &Path, path: &str) -> bool {
    let candidate = Path::new(path);
    let full: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        worktree.join(candidate)
    };
    let Ok(relative) = full.strip_prefix(worktree) else {
        return false;
    };
    relative
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
        && relative
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() != ".git")
}

/// `thread/start` params: the worktree, untrusted approvals (so commands ask first), and the
/// app's MCP server with the run token passed through an env var, never on the command line.
pub fn thread_params(
    worktree: &Path,
    mcp_url: &str,
    token_env: &str,
    writable: bool,
    instructions: &str,
) -> Value {
    json!({
        "cwd": worktree.display().to_string(),
        "approvalPolicy": "untrusted",
        "sandbox": if writable { "workspace-write" } else { "read-only" },
        "developerInstructions": instructions,
        "config": {
            "mcp_servers": {
                "harness": { "url": mcp_url, "bearer_token_env_var": token_env }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_changes_must_stay_inside_the_worktree() {
        let worktree = Path::new(if cfg!(windows) {
            "C:\\wt\\abc"
        } else {
            "/wt/abc"
        });
        assert!(within(worktree, "src/sum.ts"));
        assert!(within(
            worktree,
            &worktree.join("src/sum.ts").display().to_string()
        ));
        assert!(!within(worktree, "../other/x.ts"));
        assert!(!within(worktree, ".git/config"));
        assert!(!within(
            worktree,
            if cfg!(windows) {
                "C:\\Windows\\x"
            } else {
                "/etc/passwd"
            }
        ));
    }

    /// Spends real Codex quota: `cargo test --lib real_codex_app_server_probe -- --ignored --nocapture`.
    /// Proves the app MCP over HTTP, declined shell commands and worktree-only file changes.
    #[test]
    #[ignore]
    fn real_codex_app_server_probe() {
        use crate::harness::mcp::McpServer;
        use crate::harness::repo::{CommandSpec, RepoCommands};
        use crate::harness::run::{Control, Journal, RunRecord};
        use crate::harness::testutil::TempDir;
        use crate::harness::tools::{Phase, RunTools};
        use std::sync::Arc;

        let repo = TempDir::new("codex-probe");
        repo.init_repo("main");
        repo.write(
            "package.json",
            r#"{"name":"probe","private":true,"scripts":{"test":"bun test"}}"#,
        );
        repo.write("src/sum.ts", "export function sum(a: number, b: number): number {\n  throw new Error(\"not implemented\");\n}\n");
        repo.write("src/sum.test.ts", "import { expect, test } from \"bun:test\";\nimport { sum } from \"./sum\";\ntest(\"sum\", () => expect(sum(2, 3)).toBe(5));\n");
        repo.commit("chore: probe");
        let journal_dir = TempDir::new("codex-probe-journal");
        let journal = Arc::new(
            Journal::create(
                journal_dir.path().join("abc123"),
                RunRecord {
                    run_id: "abc123".into(),
                    ..RunRecord::default()
                },
                Arc::new(|_| {}),
            )
            .unwrap(),
        );
        let tools = Arc::new(RunTools::new(
            journal.clone(),
            Arc::new(Control::default()),
            repo.path().to_path_buf(),
            RepoCommands {
                test: Some(CommandSpec {
                    executable: "bun".into(),
                    args: vec!["test".into()],
                    ..CommandSpec::default()
                }),
                ..RepoCommands::default()
            },
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills"),
        ));
        tools.set_phase(Phase::Implementing);
        let mcp = McpServer::start().unwrap();
        let token = mcp.register(tools.clone());
        let url = mcp.client_config(&token)["mcpServers"]["harness"]["url"]
            .as_str()
            .unwrap()
            .to_string();

        let codex = crate::harness::exec::resolve_executable("codex").expect("codex on PATH");
        let mut server = AppServer::start(
            &crate::harness::claude::AgentLauncher::plain(codex),
            repo.path(),
            &[("JIRASYNC_MCP_TOKEN".into(), token)],
        )
        .unwrap();
        let thread = server
            .call(
                "thread/start",
                thread_params(repo.path(), &url, "JIRASYNC_MCP_TOKEN", true, "probe"),
                Duration::from_secs(120),
            )
            .unwrap();
        let thread_id = thread
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        println!("thread {thread_id}");
        let policy = TurnPolicy {
            worktree: repo.path(),
            allow_file_changes: true,
        };
        let prompt = "Do these steps in order and keep it short.\n\
1. Call the MCP tool `run` from the `harness` server with {\"command\": \"test\"} and note the status.\n\
2. Try to run `bun test` yourself in the shell once (it is fine if that is refused).\n\
3. Edit src/sum.ts so sum returns a + b.\n\
4. Call the harness `run` tool with command test again.\n\
5. Reply with the two statuses from the harness tool.";
        let report = server
            .run_turn(
                &thread_id,
                prompt,
                &policy,
                &mut |kind, value| {
                    if kind != "item/agentMessage/delta" {
                        println!(
                            "[{kind}] {}",
                            value.to_string().chars().take(220).collect::<String>()
                        );
                    }
                },
                &|| None,
                Duration::from_secs(480),
            )
            .unwrap();
        println!("status: {}", report.status);
        for decision in &report.decisions {
            println!("decision: {decision:?}");
        }
        println!("messages: {:?}", report.messages);
        let harness_runs: Vec<String> = journal.step_names();
        println!("harness steps: {harness_runs:?}");
        println!(
            "sum.ts:\n{}",
            std::fs::read_to_string(repo.path().join("src/sum.ts")).unwrap()
        );
        assert!(
            harness_runs
                .iter()
                .any(|step| step.starts_with("agent:test")),
            "Codex reached the app MCP tools"
        );
        assert!(
            report
                .decisions
                .iter()
                .all(|d| d.kind != "command" || !d.allowed),
            "no shell command was allowed"
        );
    }

    #[test]
    fn thread_params_keep_the_token_off_the_command_line() {
        let params = thread_params(
            Path::new("/wt/abc"),
            "http://127.0.0.1:1/mcp",
            "JIRASYNC_MCP_TOKEN",
            false,
            "harness rules",
        );
        assert_eq!(params["approvalPolicy"], "untrusted");
        assert_eq!(params["sandbox"], "read-only");
        assert_eq!(params["developerInstructions"], "harness rules");
        let server = &params["config"]["mcp_servers"]["harness"];
        assert_eq!(server["bearer_token_env_var"], "JIRASYNC_MCP_TOKEN");
        assert!(!params.to_string().contains("Bearer "));
    }
}
