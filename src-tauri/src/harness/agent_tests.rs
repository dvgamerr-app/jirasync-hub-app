// Tests for the agent pipeline. The "agent" is this test binary run again as a child process
// (`fake_agent_entry`): it reads the CLI flags the app built, talks to the app's real MCP
// server, and prints stream-json, so the whole flow runs without spending tokens.
use super::*;
use crate::harness::bindings::RepoBinding;
use crate::harness::mcp::tests::rpc;
use crate::harness::repo::RepoCommands;
use crate::harness::run::{Decision, RunManager, RunRecord, StartRun};
use crate::harness::testutil::{run_git, TempDir};
use serde_json::{json, Value};

const FAKE_ARGS: &str = "JIRASYNC_FAKE_AGENT_ARGS";

/// Not a real test: it only acts when the app started it as the agent process.
#[test]
fn fake_agent_entry() {
    let Ok(raw) = std::env::var(FAKE_ARGS) else {
        return;
    };
    let args: Vec<String> = serde_json::from_str(&raw).unwrap();
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .map(|index| args[index + 1].clone())
            .unwrap_or_default()
    };
    let prompt = flag("-p");
    let config: Value =
        serde_json::from_str(&fs::read_to_string(flag("--mcp-config")).unwrap()).unwrap();
    let server = &config["mcpServers"]["harness"];
    let url = server["url"].as_str().unwrap();
    let port: u16 = url
        .trim_end_matches("/mcp")
        .rsplit(':')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let token = server["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .trim_start_matches("Bearer ")
        .to_string();
    let call = |name: &str, arguments: Value| {
        rpc(
            port,
            &token,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    };
    println!(
        "{}",
        json!({"type": "system", "subtype": "init", "model": "fake", "tools": []})
    );

    if !flag("--tools").contains("Edit") {
        let summary: String = prompt.chars().take(80).collect();
        call(
            "submit_plan",
            json!({ "plan": format!("Write PASS into result.txt ({summary})") }),
        );
        println!(
            "{}",
            json!({"type": "result", "subtype": "success", "num_turns": 2, "total_cost_usd": 0.0})
        );
        return;
    }
    if std::env::var("JIRASYNC_FAKE_SLOW").is_ok() {
        std::thread::sleep(Duration::from_secs(4));
    }
    let first = prompt.contains("approved your plan");
    let content = match std::env::var("JIRASYNC_FAKE_RESULT").as_deref() {
        Ok("FAIL") => "FAIL",
        Ok("FAIL_FIRST") if first => "FAIL",
        _ => "PASS",
    };
    fs::write("result.txt", content).unwrap();
    fs::write(
        ".harness/progress.md",
        format!("wrote {content} into result.txt\n"),
    )
    .unwrap();
    let reply = call("run", json!({ "command": "test" }));
    let said = reply["result"]["content"][0]["text"].to_string();
    println!(
        "{}",
        json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "mcp__harness__run", "input": {"command": "test"}},
            {"type": "text", "text": format!("test said {said}")}
        ]}})
    );
    println!(
        "{}",
        json!({"type": "result", "subtype": "success", "num_turns": 3, "total_cost_usd": 0.0})
    );
}

struct Fixture {
    _upstream: TempDir,
    clone: TempDir,
    worktrees: TempDir,
    runs: TempDir,
}

fn fixture() -> Fixture {
    let upstream = TempDir::new("agent-upstream");
    upstream.init_repo("main");
    upstream.write("README.md", "hello\n");
    upstream.commit("chore: init");
    let clone = TempDir::new("agent-clone");
    run_git(
        clone.path().parent().unwrap(),
        &[
            "clone",
            "-q",
            &upstream.path().display().to_string(),
            &clone.path().display().to_string(),
        ],
    );
    Fixture {
        _upstream: upstream,
        clone,
        worktrees: TempDir::new("agent-wt"),
        runs: TempDir::new("agent-runs"),
    }
}

fn manager(fx: &Fixture, env: &[(&str, &str)], budget: Duration) -> RunManager {
    let launcher = AgentLauncher {
        executable: std::env::current_exe().unwrap(),
        prefix_args: [
            "harness::agent::tests::fake_agent_entry",
            "--exact",
            "--nocapture",
        ]
        .map(String::from)
        .to_vec(),
        args_env: Some(FAKE_ARGS.into()),
        env: env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    };
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
    RunManager::new(fx.runs.path().to_path_buf(), Arc::new(|_| {}))
        .with_agent(AgentEnv::new(launcher, skills, budget))
}

fn binding(fx: &Fixture) -> RepoBinding {
    RepoBinding {
        project_id: "proj-acc1-PRJ".into(),
        repo_path: fx.clone.path().display().to_string(),
        base_branch: "main".into(),
        worktree_root: fx.worktrees.path().display().to_string(),
        commands: RepoCommands {
            test: Some(CommandSpec {
                executable: "git".into(),
                args: ["grep", "--untracked", "-q", "PASS", "--", "result.txt"]
                    .map(String::from)
                    .to_vec(),
            }),
            ..RepoCommands::default()
        },
        copy_env: vec![],
        updated_at: 0,
    }
}

fn start(manager: &RunManager, fx: &Fixture) -> RunRecord {
    manager
        .start(StartRun {
            task_id: "task-acc1-PRJ-7".into(),
            issue_key: "PRJ-7".into(),
            binding: binding(fx),
            context: Some("# PRJ-7: write PASS\n\nPut PASS into result.txt.\n".into()),
            agent: None,
        })
        .unwrap()
}

fn settle(manager: &RunManager, run_id: &str) -> RunRecord {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let record = manager
            .list(usize::MAX)
            .into_iter()
            .find(|record| record.run_id == run_id)
            .unwrap();
        if !record.status.is_busy() && manager.active_run_id().is_none() {
            return record;
        }
        assert!(Instant::now() < deadline, "still {:?}", record.status);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn plan_approve_implement_verify_review_accept() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let run = start(&manager, &fx);

    let planned = settle(&manager, &run.run_id);
    assert_eq!(
        planned.status,
        RunStatus::AwaitingPlan,
        "{:?}",
        planned.error
    );
    assert!(planned.plan.as_deref().unwrap().starts_with("Write PASS"));
    let worktree = PathBuf::from(planned.worktree.clone().unwrap().path);
    let task = fs::read_to_string(worktree.join(".harness/task.md")).unwrap();
    assert!(task.contains("PRJ-7"));
    assert!(
        !worktree.join("result.txt").exists(),
        "nothing written before approval"
    );
    assert!(
        changed_files(&worktree).unwrap().is_empty(),
        ".harness/ stays out of git"
    );
    let session = planned.session_id.clone().unwrap();
    assert!(planned.context_digest.is_some());

    assert!(
        manager.resume(&run.run_id, Decision::Accept).is_err(),
        "a plan cannot be accepted as a change"
    );
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let reviewed = settle(&manager, &run.run_id);
    assert_eq!(
        reviewed.status,
        RunStatus::ReadyForReview,
        "{:?}",
        reviewed.error
    );
    assert_eq!(
        reviewed.session_id.as_deref(),
        Some(session.as_str()),
        "the same session is resumed"
    );
    assert_eq!(reviewed.checks.len(), 1);
    assert_eq!(reviewed.checks[0].name, "test");
    assert_eq!(reviewed.checks[0].status, "passed");
    assert_eq!(reviewed.changed_files, vec!["result.txt".to_string()]);
    assert!(reviewed.progress.as_deref().unwrap().contains("PASS"));
    assert_eq!(reviewed.attempts, 0);

    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    assert!(events.iter().any(|e| matches!(&e.kind,
        EventKind::Agent { kind, text } if kind == "tool" && text == "run test")));
    assert!(events.iter().any(|e| matches!(&e.kind,
        EventKind::StepEnd { step, exit_code: Some(0), .. } if step == "verify:test")));

    assert!(manager.resume(&run.run_id, Decision::ApprovePlan).is_err());
    let accepted = manager.resume(&run.run_id, Decision::Accept).unwrap();
    assert_eq!(accepted.status, RunStatus::Completed);
}

#[test]
fn failed_checks_get_repair_rounds_then_stop() {
    let fx = fixture();
    let flaky = manager(
        &fx,
        &[("JIRASYNC_FAKE_RESULT", "FAIL_FIRST")],
        Duration::from_secs(600),
    );
    let run = start(&flaky, &fx);
    settle(&flaky, &run.run_id);
    flaky.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let repaired = settle(&flaky, &run.run_id);
    assert_eq!(
        repaired.status,
        RunStatus::ReadyForReview,
        "{:?}",
        repaired.error
    );
    assert_eq!(repaired.attempts, 1, "one repair round fixed it");

    let fx = fixture();
    let broken = manager(
        &fx,
        &[("JIRASYNC_FAKE_RESULT", "FAIL")],
        Duration::from_secs(600),
    );
    let run = start(&broken, &fx);
    settle(&broken, &run.run_id);
    broken.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let failed = settle(&broken, &run.run_id);
    assert_eq!(failed.status, RunStatus::Failed);
    assert_eq!(failed.attempts, MAX_REPAIRS);
    let error = failed.error.clone().unwrap();
    assert!(
        error.contains("checks still fail after 2 repair rounds: test"),
        "{error}"
    );
    assert_eq!(failed.checks[0].status, "failed", "the real result is kept");

    let empty = broken.resume(&run.run_id, Decision::RequestChanges("  ".into()));
    assert!(empty.is_err());
    broken
        .resume(
            &run.run_id,
            Decision::RequestChanges("try a different approach".into()),
        )
        .unwrap();
    let again = settle(&broken, &run.run_id);
    assert_eq!(
        again.status,
        RunStatus::Failed,
        "continues, and stays honest"
    );
}

#[test]
fn owner_can_revise_the_plan_before_any_change() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let run = start(&manager, &fx);
    settle(&manager, &run.run_id);
    assert!(manager
        .resume(&run.run_id, Decision::RevisePlan(String::new()))
        .is_err());
    manager
        .resume(
            &run.run_id,
            Decision::RevisePlan("also cover the error case".into()),
        )
        .unwrap();
    let revised = settle(&manager, &run.run_id);
    assert_eq!(revised.status, RunStatus::AwaitingPlan);
    assert!(
        revised.plan.unwrap().contains("also cover the error case"),
        "the feedback reached the agent"
    );
}

#[test]
fn the_working_time_budget_stops_a_slow_agent() {
    let fx = fixture();
    let manager = manager(&fx, &[("JIRASYNC_FAKE_SLOW", "1")], Duration::from_secs(1));
    let run = start(&manager, &fx);
    settle(&manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let stopped = settle(&manager, &run.run_id);
    assert_eq!(stopped.status, RunStatus::Failed);
    let error = stopped.error.unwrap();
    assert!(error.contains("working-time budget"), "{error}");
}

#[test]
fn prepare_only_runs_cannot_be_resumed_as_agent_runs() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let run = manager
        .start(StartRun {
            task_id: "t".into(),
            issue_key: "PRJ-8".into(),
            binding: binding(&fx),
            context: None,
            agent: None,
        })
        .unwrap();
    assert_eq!(settle(&manager, &run.run_id).status, RunStatus::Prepared);
    let error = manager
        .resume(&run.run_id, Decision::ApprovePlan)
        .unwrap_err();
    assert!(error.contains("only prepared a workspace"), "{error}");
}

/// Spends real tokens (haiku): `cargo test --lib real_claude_plans_then_implements -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_claude_plans_then_implements() {
    let upstream = TempDir::new("real-upstream");
    upstream.init_repo("main");
    upstream.write(".gitignore", "node_modules\n");
    upstream.write(
        "package.json",
        r#"{"name":"fixture","private":true,"scripts":{"test":"bun test"}}"#,
    );
    upstream.write(
        "src/sum.ts",
        "export function sum(a: number, b: number): number {\n  throw new Error(\"not implemented\");\n}\n",
    );
    upstream.write(
        "src/sum.test.ts",
        "import { expect, test } from \"bun:test\";\nimport { sum } from \"./sum\";\n\ntest(\"sum\", () => {\n  expect(sum(2, 3)).toBe(5);\n});\n",
    );
    upstream.commit("chore: fixture");
    let clone = TempDir::new("real-clone");
    run_git(
        clone.path().parent().unwrap(),
        &[
            "clone",
            "-q",
            &upstream.path().display().to_string(),
            &clone.path().display().to_string(),
        ],
    );
    let worktrees = TempDir::new("real-wt");
    let runs = TempDir::new("real-runs");
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
    let mut env = AgentEnv::new(
        AgentLauncher::claude(PathBuf::from("claude")),
        skills,
        Duration::from_secs(600),
    );
    env.model = Some("haiku".into());
    let manager = RunManager::new(runs.path().to_path_buf(), Arc::new(|_| {})).with_agent(env);
    let binding = RepoBinding {
        project_id: "proj-acc1-DEMO".into(),
        repo_path: clone.path().display().to_string(),
        base_branch: "main".into(),
        worktree_root: worktrees.path().display().to_string(),
        commands: RepoCommands {
            test: Some(CommandSpec {
                executable: "bun".into(),
                args: vec!["test".into()],
            }),
            ..RepoCommands::default()
        },
        copy_env: vec![],
        updated_at: 0,
    };
    let run = manager
        .start(StartRun {
            task_id: "task-acc1-DEMO-1".into(),
            issue_key: "DEMO-1".into(),
            binding,
            context: Some("# DEMO-1: implement sum\n\nImplement `sum` in src/sum.ts so the unit test passes.\n".into()),
            agent: None,
        })
        .unwrap();
    let planned = settle(&manager, &run.run_id);
    println!("PLAN:\n{}", planned.plan.clone().unwrap_or_default());
    assert_eq!(
        planned.status,
        RunStatus::AwaitingPlan,
        "{:?}",
        planned.error
    );
    let worktree = PathBuf::from(planned.worktree.clone().unwrap().path);
    assert!(
        changed_files(&worktree).unwrap().is_empty(),
        "planning changed nothing"
    );

    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let reviewed = settle(&manager, &run.run_id);
    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    for event in &events {
        if let EventKind::Agent { kind, text } = &event.kind {
            println!("[{kind}] {}", text.lines().next().unwrap_or(""));
        }
        if let EventKind::Permission { tool, decision } = &event.kind {
            println!("[permission] {tool} {decision}");
        }
    }
    println!(
        "ai_ms={} checks={:?} changed={:?}",
        reviewed.ai_ms, reviewed.checks, reviewed.changed_files
    );
    assert_eq!(
        reviewed.status,
        RunStatus::ReadyForReview,
        "{:?}",
        reviewed.error
    );
    assert!(reviewed.changed_files.contains(&"src/sum.ts".to_string()));
    assert!(!events.iter().any(|e| matches!(&e.kind,
        EventKind::Agent { kind, text } if kind == "tool" && text.starts_with("Bash"))));
}
