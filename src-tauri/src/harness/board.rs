// Board tools over MCP (Phase 5): lets an external MCP client (another Claude/Codex session,
// an IDE) see the tasks the owner made ready and ask for runs, through the same app core.
// It can never start work itself: a request waits in the app until the owner approves it.
// Access is a separate token the owner enables in Setup, scoped to an expiry; the app must be
// open (the server lives in the app process). Data comes from what the WebView publishes:
// ready tasks only, with the same snapshot as Copy for AI and never the local note.
use super::mcp::ToolHost;
use super::run::{now_ms, RunManager, RunRecord};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

const MAX_CONTEXT_CHARS: usize = 200_000;
const MAX_NOTE_CHARS: usize = 2_000;
const MAX_REPORT_CHARS: usize = 8_000;
const MAX_PENDING: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoardTask {
    pub task_id: String,
    pub project_id: String,
    pub issue_key: String,
    pub title: String,
    /// The task snapshot (markdown) an agent would receive; no local note.
    pub context: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub request_id: String,
    pub task_id: String,
    pub issue_key: String,
    pub provider: String,
    pub note: String,
    /// pending | approved | declined
    pub status: String,
    pub created_at: u64,
}

pub type RequestSink = Arc<dyn Fn(&RunRequest) + Send + Sync>;

pub struct BoardHost {
    runs: RunManager,
    expires_at: u64,
    tasks: Mutex<Vec<BoardTask>>,
    requests: Mutex<Vec<RunRequest>>,
    report_keys: Mutex<HashSet<String>>,
    on_request: RequestSink,
}

fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

impl BoardHost {
    pub fn new(runs: RunManager, expires_at: u64, on_request: RequestSink) -> Self {
        Self {
            runs,
            expires_at,
            tasks: Mutex::default(),
            requests: Mutex::default(),
            report_keys: Mutex::default(),
            on_request,
        }
    }

    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }

    /// Replaces the ready tasks (the WebView publishes them whenever the board changes).
    pub fn publish(&self, tasks: Vec<BoardTask>) {
        let tasks = tasks
            .into_iter()
            .map(|mut task| {
                task.context = clip(&task.context, MAX_CONTEXT_CHARS);
                task
            })
            .collect();
        *self.tasks.lock().unwrap() = tasks;
    }

    pub fn requests(&self) -> Vec<RunRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// The owner decision on a request. Approving does not start anything by itself: the app
    /// starts the run through the same start path as its own buttons.
    pub fn resolve(&self, request_id: &str, approve: bool) -> Result<RunRequest, String> {
        let mut requests = self.requests.lock().unwrap();
        let request = requests
            .iter_mut()
            .find(|request| request.request_id == request_id)
            .ok_or("this request no longer exists")?;
        if request.status != "pending" {
            return Err(format!("this request was already {}", request.status));
        }
        request.status = if approve { "approved" } else { "declined" }.into();
        Ok(request.clone())
    }

    fn ready(&self, task_id: &str) -> Option<BoardTask> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.task_id == task_id)
            .cloned()
    }

    /// A client may read runs of tasks it can see now or has asked to run.
    fn in_scope(&self, task_id: &str) -> bool {
        self.ready(task_id).is_some()
            || self
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request.task_id == task_id)
    }

    fn latest_run(&self, task_id: &str) -> Option<RunRecord> {
        self.runs
            .list(200)
            .into_iter()
            .find(|run| run.task_id == task_id)
    }

    fn task_id(arguments: &Value) -> Result<String, String> {
        arguments
            .get("taskId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "taskId is required (from tasks_list_ready)".into())
    }

    fn request_run(&self, arguments: &Value) -> Result<String, String> {
        let task_id = Self::task_id(arguments)?;
        let task = self
            .ready(&task_id)
            .ok_or("this task is not ready for agents (the owner decides which tasks are)")?;
        let provider = arguments
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("claude");
        if !["claude", "codex"].contains(&provider) {
            return Err("provider must be claude or codex".into());
        }
        let note = clip(
            arguments.get("note").and_then(Value::as_str).unwrap_or(""),
            MAX_NOTE_CHARS,
        );
        let mut requests = self.requests.lock().unwrap();
        // Asking again for the same task returns the open request instead of queueing more.
        if let Some(open) = requests
            .iter()
            .find(|request| request.task_id == task_id && request.status == "pending")
        {
            return Ok(json!({ "request": open, "duplicate": true }).to_string());
        }
        if requests.iter().filter(|r| r.status == "pending").count() >= MAX_PENDING {
            return Err("too many requests are waiting for the owner".into());
        }
        let request = RunRequest {
            request_id: format!("req-{}-{}", now_ms(), requests.len() + 1),
            task_id,
            issue_key: task.issue_key,
            provider: provider.into(),
            note,
            status: "pending".into(),
            created_at: now_ms(),
        };
        requests.push(request.clone());
        drop(requests);
        (self.on_request)(&request);
        Ok(json!({
            "request": request,
            "message": "Queued. Nothing starts until the owner approves it in JiraSync Hub.",
        })
        .to_string())
    }

    fn get_run(&self, arguments: &Value) -> Result<String, String> {
        let task_id = Self::task_id(arguments)?;
        if !self.in_scope(&task_id) {
            return Err("this task is not visible to board clients".into());
        }
        let request = self
            .requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|request| request.task_id == task_id)
            .cloned();
        let run = self.latest_run(&task_id).map(|run| {
            json!({
                "runId": run.run_id,
                "status": run.status,
                "provider": run.provider,
                "plan": run.plan,
                "checks": run.checks,
                "changedFiles": run.changed_files,
                "review": run.review.map(|review| review.verdict),
                "prUrl": run.pr_url,
                "error": run.error,
            })
        });
        Ok(json!({ "request": request, "run": run }).to_string())
    }

    fn report(&self, arguments: &Value) -> Result<String, String> {
        let task_id = Self::task_id(arguments)?;
        if !self.in_scope(&task_id) {
            return Err("this task is not visible to board clients".into());
        }
        let text = arguments
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            return Err("text is empty".into());
        }
        let key = arguments
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or("key is required so a retried report is not added twice")?;
        let run = self
            .latest_run(&task_id)
            .ok_or("this task has no run to report on yet")?;
        let unique = format!("{}:{key}", run.run_id);
        if self.report_keys.lock().unwrap().contains(&unique) {
            return Ok(json!({ "added": false, "duplicate": true }).to_string());
        }
        self.runs
            .add_report(&run.run_id, &clip(text, MAX_REPORT_CHARS))?;
        self.report_keys.lock().unwrap().insert(unique);
        Ok(json!({ "added": true, "runId": run.run_id }).to_string())
    }
}

impl ToolHost for BoardHost {
    fn tools(&self) -> Vec<Value> {
        let string = json!({ "type": "string" });
        let task =
            json!({ "type": "object", "properties": { "taskId": string }, "required": ["taskId"] });
        vec![
            json!({ "name": "tasks_list_ready", "description": "Tasks the owner made ready for coding agents in JiraSync Hub (AI Board To Do, project bound to a repository).", "inputSchema": { "type": "object", "properties": {} } }),
            json!({ "name": "tasks_get_context", "description": "The task snapshot (markdown) and its revision for one ready task.", "inputSchema": task.clone() }),
            json!({ "name": "runs_request", "description": "Ask JiraSync Hub to run its coding agent on a ready task. It only queues a request: the owner approves it in the app before anything starts.", "inputSchema": { "type": "object", "properties": { "taskId": string, "provider": { "type": "string", "enum": ["claude", "codex"] }, "note": string }, "required": ["taskId"] } }),
            json!({ "name": "runs_get", "description": "The request and the latest run of a task you can see: status, plan, checks run by the app, changed files, reviewer verdict, PR link.", "inputSchema": task }),
            json!({ "name": "runs_report", "description": "Attach a short report to the latest run of a task (shown to the owner in the run log). It cannot change checks or status. Use a unique key per report so retries are not added twice.", "inputSchema": { "type": "object", "properties": { "taskId": string, "key": string, "text": string }, "required": ["taskId", "key", "text"] } }),
        ]
    }

    fn call(&self, name: &str, arguments: Value) -> Result<String, String> {
        if now_ms() >= self.expires_at {
            return Err("board access expired; the owner can enable it again in Setup".into());
        }
        match name {
            "tasks_list_ready" => {
                let tasks: Vec<Value> = self
                    .tasks
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|task| json!({ "taskId": task.task_id, "issueKey": task.issue_key, "title": task.title }))
                    .collect();
                Ok(json!({ "tasks": tasks }).to_string())
            }
            "tasks_get_context" => {
                let task_id = Self::task_id(&arguments)?;
                let task = self
                    .ready(&task_id)
                    .ok_or("this task is not ready for agents")?;
                Ok(json!({
                    "taskId": task.task_id,
                    "issueKey": task.issue_key,
                    "revision": digest(&task.context),
                    "context": task.context,
                })
                .to_string())
            }
            "runs_request" => self.request_run(&arguments),
            "runs_get" => self.get_run(&arguments),
            "runs_report" => self.report(&arguments),
            other => Err(format!("unknown tool {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::mcp::tests::rpc;
    use crate::harness::mcp::McpServer;
    use crate::harness::testutil::TempDir;

    fn task(id: &str, key: &str) -> BoardTask {
        BoardTask {
            task_id: id.into(),
            project_id: "proj-acc1-PRJ".into(),
            issue_key: key.into(),
            title: format!("Work on {key}"),
            context: format!("# {key}\n\nDo the thing.\n"),
        }
    }

    fn host(runs: &TempDir, expires_at: u64) -> (Arc<BoardHost>, Arc<Mutex<Vec<RunRequest>>>) {
        let seen: Arc<Mutex<Vec<RunRequest>>> = Arc::default();
        let sink = seen.clone();
        let manager = RunManager::new(runs.path().to_path_buf(), Arc::new(|_| {}));
        let host = Arc::new(BoardHost::new(
            manager,
            expires_at,
            Arc::new(move |request: &RunRequest| sink.lock().unwrap().push(request.clone())),
        ));
        host.publish(vec![task("task-acc1-PRJ-1", "PRJ-1")]);
        (host, seen)
    }

    fn call(host: &BoardHost, name: &str, arguments: Value) -> Result<Value, String> {
        host.call(name, arguments)
            .map(|text| serde_json::from_str(&text).unwrap())
    }

    #[test]
    fn clients_see_only_ready_tasks_and_cannot_start_work() {
        let runs = TempDir::new("board-runs");
        let (host, seen) = host(&runs, now_ms() + 60_000);

        let listed = call(&host, "tasks_list_ready", json!({})).unwrap();
        assert_eq!(listed["tasks"][0]["issueKey"], "PRJ-1");
        assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);
        let context = call(
            &host,
            "tasks_get_context",
            json!({ "taskId": "task-acc1-PRJ-1" }),
        )
        .unwrap();
        assert!(context["context"].as_str().unwrap().starts_with("# PRJ-1"));
        assert_eq!(context["revision"].as_str().unwrap().len(), 16);
        assert!(call(
            &host,
            "tasks_get_context",
            json!({ "taskId": "task-acc1-PRJ-2" })
        )
        .is_err());

        let first = call(
            &host,
            "runs_request",
            json!({ "taskId": "task-acc1-PRJ-1", "provider": "codex", "note": "please" }),
        )
        .unwrap();
        assert_eq!(first["request"]["status"], "pending");
        assert_eq!(first["request"]["provider"], "codex");
        let again = call(
            &host,
            "runs_request",
            json!({ "taskId": "task-acc1-PRJ-1" }),
        )
        .unwrap();
        assert_eq!(
            again["duplicate"], true,
            "no second request for the same task"
        );
        assert_eq!(seen.lock().unwrap().len(), 1, "the owner is told once");
        assert!(
            host.runs.list(10).is_empty(),
            "a request never starts a run"
        );
        assert!(call(
            &host,
            "runs_request",
            json!({ "taskId": "task-acc1-PRJ-2" })
        )
        .is_err());
        assert!(call(
            &host,
            "runs_request",
            json!({ "taskId": "task-acc1-PRJ-1", "provider": "bash" })
        )
        .is_err());

        let request_id = first["request"]["requestId"].as_str().unwrap();
        assert_eq!(host.resolve(request_id, false).unwrap().status, "declined");
        assert!(host.resolve(request_id, true).is_err(), "decided once");
    }

    #[test]
    fn scope_follows_ready_tasks_and_requests() {
        let runs = TempDir::new("board-scope");
        let (host, _) = host(&runs, now_ms() + 60_000);
        assert!(call(&host, "runs_get", json!({ "taskId": "task-acc1-PRJ-9" })).is_err());
        let got = call(&host, "runs_get", json!({ "taskId": "task-acc1-PRJ-1" })).unwrap();
        assert!(got["run"].is_null());

        call(
            &host,
            "runs_request",
            json!({ "taskId": "task-acc1-PRJ-1" }),
        )
        .unwrap();
        // Once its run starts the task leaves To Do, but the client keeps following it.
        host.publish(vec![]);
        assert!(call(&host, "runs_get", json!({ "taskId": "task-acc1-PRJ-1" })).is_ok());
        assert!(call(
            &host,
            "tasks_get_context",
            json!({ "taskId": "task-acc1-PRJ-1" })
        )
        .is_err());
        assert!(call(
            &host,
            "runs_report",
            json!({ "taskId": "task-acc1-PRJ-1", "key": "k", "text": "x" })
        )
        .unwrap_err()
        .contains("no run"));
    }

    #[test]
    fn reports_reach_the_run_log_once_and_change_nothing_else() {
        use crate::harness::run::{EventKind, Journal, RunStatus};
        let runs = TempDir::new("board-report");
        let record = RunRecord {
            run_id: "abc123def456".into(),
            task_id: "task-acc1-PRJ-1".into(),
            status: RunStatus::AwaitingPlan,
            created_at: 1,
            ..RunRecord::default()
        };
        Journal::create(runs.path().join("abc123def456"), record, Arc::new(|_| {})).unwrap();
        let (host, _) = host(&runs, now_ms() + 60_000);

        let report =
            json!({ "taskId": "task-acc1-PRJ-1", "key": "r1", "text": "I checked the API docs" });
        assert_eq!(
            call(&host, "runs_report", report.clone()).unwrap()["added"],
            true
        );
        assert_eq!(
            call(&host, "runs_report", report).unwrap()["duplicate"],
            true
        );
        assert!(call(
            &host,
            "runs_report",
            json!({ "taskId": "task-acc1-PRJ-1", "text": "no key" })
        )
        .is_err());

        let events = host.runs.events("abc123def456", 0, usize::MAX).unwrap();
        let reports: Vec<_> = events
            .iter()
            .filter(
                |e| matches!(&e.kind, EventKind::Agent { kind, .. } if kind == "external_report"),
            )
            .collect();
        assert_eq!(reports.len(), 1);
        let run = host.runs.list(10).remove(0);
        assert_eq!(
            run.status,
            RunStatus::AwaitingPlan,
            "a report never changes the run"
        );
        assert!(run.checks.is_empty());
        let got = call(&host, "runs_get", json!({ "taskId": "task-acc1-PRJ-1" })).unwrap();
        assert_eq!(got["run"]["status"], "awaiting_plan");
    }

    /// Spends real tokens (haiku): `cargo test --lib real_claude_uses_board_tools -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_uses_board_tools() {
        let runs = TempDir::new("board-real");
        let (host, seen) = host(&runs, now_ms() + 600_000);
        let server = McpServer::start().unwrap();
        let token = server.register(host.clone());
        let config = runs.path().join("board-mcp.json");
        std::fs::write(&config, server.client_config(&token).to_string()).unwrap();
        let claude = crate::harness::exec::resolve_executable("claude").expect("claude on PATH");
        let output = std::process::Command::new(claude)
            .args([
                "-p",
                "Use the jirasync board tools: list the ready tasks, read the context of the first one, then request a run for it with provider codex and note \"from probe\". Reply with the issue key and the request status.",
                "--output-format",
                "json",
                "--strict-mcp-config",
                "--mcp-config",
                &config.display().to_string(),
                "--allowedTools",
                "mcp__harness__tasks_list_ready mcp__harness__tasks_get_context mcp__harness__runs_request",
                "--tools",
                "",
                "--model",
                "haiku",
                "--max-budget-usd",
                "0.2",
            ])
            .current_dir(runs.path())
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        println!("{text}");
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1, "the client queued exactly one request");
        assert_eq!(requests[0].issue_key, "PRJ-1");
        assert_eq!(requests[0].provider, "codex");
        assert_eq!(requests[0].status, "pending");
        assert!(
            host.runs.list(10).is_empty(),
            "nothing started without the owner"
        );
    }

    #[test]
    fn expired_access_answers_nothing() {
        let runs = TempDir::new("board-expired");
        let (host, _) = host(&runs, now_ms().saturating_sub(1));
        let error = call(&host, "tasks_list_ready", json!({})).unwrap_err();
        assert!(error.contains("expired"));
    }

    #[test]
    fn served_over_the_app_mcp_server_with_its_own_token() {
        let runs = TempDir::new("board-mcp");
        let (host, _) = host(&runs, now_ms() + 60_000);
        let server = McpServer::start().unwrap();
        let token = server.register(host);
        let listed = rpc(server.port(), &token, "tools/list", json!({}));
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "tasks_list_ready",
                "tasks_get_context",
                "runs_request",
                "runs_get",
                "runs_report"
            ]
        );
        let ready = rpc(
            server.port(),
            &token,
            "tools/call",
            json!({ "name": "tasks_list_ready", "arguments": {} }),
        );
        assert!(ready["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("PRJ-1"));
        server.unregister(&token);
    }
}
