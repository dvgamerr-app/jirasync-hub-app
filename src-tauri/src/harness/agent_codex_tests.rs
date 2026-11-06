// The agent pipeline with Codex as the provider. The "codex app-server" is this test binary
// run again as a child (`fake_codex_entry`): it speaks the app-server JSON-RPC on stdio, asks
// for a shell command and for file changes the way Codex does, and calls the app's real MCP
// server, so the approval rules are exercised end to end without spending quota.
use super::*;
use std::io::{BufRead, Write as _};

const FAKE_CODEX_ARGS: &str = "JIRASYNC_FAKE_CODEX_ARGS";
const FAKE_CODEX_LOG: &str = "JIRASYNC_FAKE_CODEX_LOG";

fn note(line: String) {
    if let Ok(log) = std::env::var(FAKE_CODEX_LOG) {
        let mut previous = fs::read_to_string(&log).unwrap_or_default();
        previous.push_str(&line);
        previous.push('\n');
        fs::write(&log, previous).unwrap();
    }
}

fn send(message: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{message}").unwrap();
    out.flush().unwrap();
}

/// Not a real test: it only acts when the app started it as `codex app-server`.
#[test]
fn fake_codex_entry() {
    if std::env::var(FAKE_CODEX_ARGS).is_err() {
        return;
    }
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut thread = Value::Null;
    let thread_id = format!("thr-{}", std::process::id());
    while let Some(Ok(line)) = lines.next() {
        let message: Value = serde_json::from_str(&line).unwrap();
        let method = message["method"].as_str().unwrap_or("").to_string();
        let id = message.get("id").cloned();
        match method.as_str() {
            "thread/start" | "thread/resume" => {
                thread = message["params"].clone();
                let id_used = thread["threadId"]
                    .as_str()
                    .unwrap_or(&thread_id)
                    .to_string();
                note(format!(
                    "{method} {id_used} sandbox={}",
                    thread["sandbox"].as_str().unwrap_or("")
                ));
                send(json!({ "id": id, "result": { "thread": { "id": id_used } } }));
            }
            "turn/start" => {
                send(json!({ "id": id, "result": { "turn": { "id": "turn-1" } } }));
                if std::env::var("JIRASYNC_FAKE_CODEX_HANG").is_ok() {
                    loop {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
                let prompt = message["params"]["input"][0]["text"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let worktree = PathBuf::from(thread["cwd"].as_str().unwrap());
                let server = &thread["config"]["mcp_servers"]["harness"];
                let port: u16 = server["url"]
                    .as_str()
                    .unwrap()
                    .trim_end_matches("/mcp")
                    .rsplit(':')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                let token =
                    std::env::var(server["bearer_token_env_var"].as_str().unwrap()).unwrap();
                let call = |name: &str, arguments: Value| {
                    rpc(
                        port,
                        &token,
                        "tools/call",
                        json!({ "name": name, "arguments": arguments }),
                    )
                };
                // Ask the app for something and read its answer (the next line on stdin).
                let mut ask = |request_id: u64, method: &str, params: Value| -> Value {
                    send(json!({ "id": request_id, "method": method, "params": params }));
                    let reply: Value =
                        serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                    reply["result"].clone()
                };
                let shell = ask(
                    900,
                    "item/commandExecution/requestApproval",
                    json!({ "command": "bun test", "itemId": "c1", "threadId": thread_id, "turnId": "turn-1" }),
                );
                note(format!("shell {}", shell["decision"]));
                let mut try_edit = |request_id: u64, relative: &str| -> bool {
                    let path = worktree.join(relative);
                    let item_id = format!("f{request_id}");
                    send(json!({ "method": "item/started", "params": { "item": {
                        "id": item_id, "type": "fileChange",
                        "changes": [{ "path": path.display().to_string() }]
                    } } }));
                    let answer = ask(
                        request_id,
                        "item/fileChange/requestApproval",
                        json!({ "itemId": item_id, "threadId": thread_id, "turnId": "turn-1" }),
                    );
                    note(format!("file {relative} {}", answer["decision"]));
                    answer["decision"] == "accept"
                };

                if prompt.contains("independent reviewer") {
                    call(
                        "submit_review",
                        json!({ "verdict": "approve", "summary": "matches the task" }),
                    );
                } else if prompt.contains("pull request") {
                    call(
                        "submit_pr_draft",
                        json!({
                            "title": "feat(result): write pass into result",
                            "commitMessage": "feat(result): write pass into result",
                            "summary": "- เขียน PASS ลง result.txt",
                            "reason": "งานใน ticket ต้องการค่า PASS",
                            "changes": "- เพิ่มไฟล์ `result.txt`",
                            "impact": "- Breaking change: ไม่มี\n- DB migration: ไม่มี\n- Config change: ไม่มี"
                        }),
                    );
                } else if thread["sandbox"] == "read-only" {
                    try_edit(901, "result.txt");
                    call(
                        "submit_plan",
                        json!({ "plan": "Write PASS into result.txt" }),
                    );
                } else {
                    try_edit(902, ".claude/settings.json");
                    if try_edit(903, "result.txt") {
                        fs::write(worktree.join("result.txt"), "PASS").unwrap();
                        fs::write(worktree.join(".harness/progress.md"), "wrote PASS\n").unwrap();
                    }
                    let reply = call("run", json!({ "command": "test" }));
                    note(format!(
                        "run test {}",
                        reply["result"]["content"][0]["text"]
                            .as_str()
                            .unwrap_or("")
                            .contains("\"passed\"")
                    ));
                }
                send(json!({ "method": "item/completed", "params": { "item": {
                    "type": "agentMessage", "text": "done"
                } } }));
                send(
                    json!({ "method": "turn/completed", "params": { "turn": { "status": "completed" } } }),
                );
            }
            _ => {
                if id.is_some() {
                    send(json!({ "id": id, "result": {} }));
                }
            }
        }
    }
}

fn codex_manager(fx: &Fixture, extra: &[(&str, &str)]) -> RunManager {
    let mut env = vec![
        (
            "JIRASYNC_FAKE_GH_LOG".to_string(),
            fx.gh_log.path().join("gh.log").display().to_string(),
        ),
        (
            FAKE_CODEX_LOG.to_string(),
            fx.gh_log.path().join("codex.log").display().to_string(),
        ),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
    let mut agent = AgentEnv::new(
        AgentLauncher::plain(PathBuf::from("claude-must-not-run")),
        skills,
        Duration::from_secs(600),
    );
    agent.codex = self_launcher(
        "harness::agent::tests::codex::fake_codex_entry",
        FAKE_CODEX_ARGS,
        env.clone(),
    );
    agent.gh = self_launcher("harness::agent::tests::fake_gh_entry", FAKE_GH_ARGS, env);
    RunManager::new(fx.runs.path().to_path_buf(), Arc::new(|_| {})).with_agent(agent)
}

#[test]
fn codex_runs_the_same_gates_without_a_shell() {
    let fx = fixture();
    let manager = codex_manager(&fx, &[]);
    let run = manager
        .start(StartRun {
            task_id: "task-acc1-PRJ-9".into(),
            issue_key: "PRJ-9".into(),
            binding: binding(&fx),
            context: Some("# PRJ-9: write PASS\n\nPut PASS into result.txt.\n".into()),
            agent: None,
            jira_url: None,
            provider: "codex".into(),
            owner_message: None,
        })
        .unwrap();

    let planned = settle(&manager, &run.run_id);
    assert_eq!(
        planned.status,
        RunStatus::AwaitingPlan,
        "{:?}",
        planned.error
    );
    assert_eq!(planned.provider, "codex");
    assert_eq!(planned.plan.as_deref(), Some("Write PASS into result.txt"));
    let worktree = PathBuf::from(planned.worktree.clone().unwrap().path);
    assert!(
        !worktree.join("result.txt").exists(),
        "no file change while planning"
    );
    let thread = planned
        .session_id
        .clone()
        .expect("the Codex thread is kept");

    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let reviewed = settle(&manager, &run.run_id);
    assert_eq!(
        reviewed.status,
        RunStatus::ReadyForReview,
        "{:?}",
        reviewed.error
    );
    assert_eq!(reviewed.changed_files, vec!["result.txt".to_string()]);
    assert_eq!(reviewed.checks[0].status, "passed");
    assert!(
        !worktree.join(".claude").exists(),
        "protected file change refused"
    );
    assert_eq!(
        reviewed.review.as_ref().map(|r| r.verdict.as_str()),
        Some("approve")
    );

    let log = fs::read_to_string(fx.gh_log.path().join("codex.log")).unwrap();
    println!("{log}");
    let lines: Vec<&str> = log.lines().collect();
    assert!(lines.contains(&format!("thread/start {thread} sandbox=read-only").as_str()));
    assert!(
        lines.contains(&format!("thread/resume {thread} sandbox=workspace-write").as_str()),
        "implementing resumes the planning thread with write access"
    );
    assert!(
        lines
            .iter()
            .filter(|line| line.starts_with("thread/start") && !line.contains(&thread))
            .count()
            >= 1,
        "the reviewer gets its own thread"
    );
    assert!(lines
        .iter()
        .filter(|l| l.starts_with("shell"))
        .all(|l| *l == "shell \"decline\""));
    assert!(
        lines.contains(&"file result.txt \"decline\""),
        "planning cannot edit"
    );
    assert!(lines.contains(&"file .claude/settings.json \"decline\""));
    assert!(lines.contains(&"file result.txt \"accept\""));
    assert!(
        lines.contains(&"run test true"),
        "the agent reached the app's tools"
    );

    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    assert!(events.iter().any(|e| matches!(&e.kind,
        EventKind::Permission { tool, decision } if tool == "Shell bun test" && decision == "deny")));

    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let published = settle(&manager, &run.run_id);
    assert_eq!(
        published.status,
        RunStatus::Completed,
        "{:?}",
        published.error
    );
}

#[test]
fn stopping_a_codex_turn_ends_the_run_as_cancelled() {
    let fx = fixture();
    // A Codex that never finishes its turn: only Stop can end it.
    let manager = codex_manager(&fx, &[("JIRASYNC_FAKE_CODEX_HANG", "1")]);
    let run = manager
        .start(StartRun {
            task_id: "task-acc1-PRJ-10".into(),
            issue_key: "PRJ-10".into(),
            binding: binding(&fx),
            context: Some("# PRJ-10\n".into()),
            agent: None,
            jira_url: None,
            provider: "codex".into(),
            owner_message: None,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while manager
        .list(usize::MAX)
        .iter()
        .find(|r| r.run_id == run.run_id)
        .map(|r| r.status)
        != Some(RunStatus::Planning)
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(500));
    manager.stop(&run.run_id).unwrap();
    let stopped = settle(&manager, &run.run_id);
    assert_eq!(stopped.status, RunStatus::Cancelled, "{:?}", stopped.error);
}
