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
    if let Ok(log) = std::env::var("JIRASYNC_FAKE_AGENT_LOG") {
        let mut previous = fs::read_to_string(&log).unwrap_or_default();
        previous.push_str(&format!(
            "{raw}
"
        ));
        fs::write(&log, previous).unwrap();
    }
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

    if prompt.contains("independent reviewer") {
        let review = match std::env::var("JIRASYNC_FAKE_REVIEW").as_deref() {
            Ok("silent") => return,
            Ok("concerns") => json!({
                "verdict": "concerns",
                "summary": "result.txt is written but nothing tests the error path",
                "findings": [{ "file": "result.txt", "issue": "no test covers a failing result" }]
            }),
            _ => json!({ "verdict": "approve", "summary": "matches the task; test passes" }),
        };
        call("submit_review", review);
        return;
    }
    if prompt.contains("pull request") {
        let english = std::env::var("JIRASYNC_FAKE_DRAFT").as_deref() == Ok("english");
        let reply = call(
            "submit_pr_draft",
            json!({
                "title": "feat(result): write pass into result",
                "commitMessage": "feat(result): write pass into result\n\nThe task asks for PASS in result.txt.",
                "summary": if english { "- write PASS" } else { "- เขียน PASS ลง result.txt" },
                "reason": "งานใน ticket ต้องการค่า PASS",
                "changes": "- เพิ่มไฟล์ `result.txt`",
                "impact": "- Breaking change: ไม่มี\n- DB migration: ไม่มี\n- Config change: ไม่มี"
            }),
        );
        println!(
            "{}",
            json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": format!("draft: {}", reply["result"]["content"][0]["text"])}
            ]}})
        );
        return;
    }
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

const FAKE_GH_ARGS: &str = "JIRASYNC_FAKE_GH_ARGS";

/// Not a real test: the stand-in for `gh` during publishing. Logs its arguments and answers
/// `pr list` from `JIRASYNC_FAKE_GH_LIST` (default: no PR yet).
#[test]
fn fake_gh_entry() {
    let Ok(raw) = std::env::var(FAKE_GH_ARGS) else {
        return;
    };
    let args: Vec<String> = serde_json::from_str(&raw).unwrap();
    let log = std::env::var("JIRASYNC_FAKE_GH_LOG").unwrap();
    let mut previous = fs::read_to_string(&log).unwrap_or_default();
    previous.push_str(&format!("{raw}\n"));
    fs::write(&log, previous).unwrap();
    match (args[0].as_str(), args[1].as_str()) {
        ("pr", "list") => println!(
            "{}",
            std::env::var("JIRASYNC_FAKE_GH_LIST").unwrap_or_else(|_| "[]".into())
        ),
        ("pr", "create") => println!("https://github.com/acme/service/pull/42"),
        ("pr", "checks") => println!(
            "{}",
            std::env::var("JIRASYNC_FAKE_GH_CHECKS").unwrap_or_else(|_| "[]".into())
        ),
        _ => println!("ok"),
    }
}

struct Fixture {
    upstream: TempDir,
    clone: TempDir,
    worktrees: TempDir,
    runs: TempDir,
    gh_log: TempDir,
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
    run_git(clone.path(), &["config", "user.name", "owner"]);
    run_git(
        clone.path(),
        &["config", "user.email", "owner@example.invalid"],
    );
    Fixture {
        upstream,
        clone,
        worktrees: TempDir::new("agent-wt"),
        runs: TempDir::new("agent-runs"),
        gh_log: TempDir::new("agent-gh"),
    }
}

impl Fixture {
    fn agent_calls(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.gh_log.path().join("agent.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn gh_calls(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.gh_log.path().join("gh.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn self_launcher(entry: &str, args_env: &str, env: Vec<(String, String)>) -> AgentLauncher {
    AgentLauncher {
        executable: std::env::current_exe().unwrap(),
        prefix_args: [entry, "--exact", "--nocapture"].map(String::from).to_vec(),
        args_env: Some(args_env.into()),
        env,
    }
}

fn manager(fx: &Fixture, env: &[(&str, &str)], budget: Duration) -> RunManager {
    let mut env: Vec<(String, String)> = env
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    env.push((
        "JIRASYNC_FAKE_GH_LOG".into(),
        fx.gh_log.path().join("gh.log").display().to_string(),
    ));
    env.push((
        "JIRASYNC_FAKE_AGENT_LOG".into(),
        fx.gh_log.path().join("agent.log").display().to_string(),
    ));
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
    let mut agent = AgentEnv::new(
        self_launcher(
            "harness::agent::tests::fake_agent_entry",
            FAKE_ARGS,
            env.clone(),
        ),
        skills,
        budget,
    );
    agent.gh = self_launcher("harness::agent::tests::fake_gh_entry", FAKE_GH_ARGS, env);
    RunManager::new(fx.runs.path().to_path_buf(), Arc::new(|_| {})).with_agent(agent)
}

/// Runs a task up to `ready_for_review`.
fn reviewed(manager: &RunManager, fx: &Fixture) -> RunRecord {
    let run = start(manager, fx);
    settle(manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let record = settle(manager, &run.run_id);
    assert_eq!(
        record.status,
        RunStatus::ReadyForReview,
        "{:?}",
        record.error
    );
    record
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
        services: vec![],
        env_overrides: vec![],
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
            jira_url: None,
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
    assert_eq!(reviewed.review.as_ref().unwrap().verdict, "approve");

    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    assert!(events.iter().any(|e| matches!(&e.kind,
        EventKind::Agent { kind, text } if kind == "tool" && text == "run test")));
    assert!(events.iter().any(|e| matches!(&e.kind,
        EventKind::StepEnd { step, exit_code: Some(0), .. } if step == "verify:test")));

    assert!(manager.resume(&run.run_id, Decision::ApprovePlan).is_err());
    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let published = settle(&manager, &run.run_id);
    assert_eq!(
        published.status,
        RunStatus::Completed,
        "{:?}",
        published.error
    );
    assert_eq!(
        published.pr_url.as_deref(),
        Some("https://github.com/acme/service/pull/42")
    );
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
            jira_url: None,
        })
        .unwrap();
    assert_eq!(settle(&manager, &run.run_id).status, RunStatus::Prepared);
    let error = manager
        .resume(&run.run_id, Decision::ApprovePlan)
        .unwrap_err();
    assert!(error.contains("only prepared a workspace"), "{error}");
}

#[test]
fn accept_commits_pushes_and_opens_a_draft_pr() {
    let fx = fixture();
    // Not ignored by the repo: the app must still never commit the env file it copied in.
    fx.clone.write(".env", "SECRET=1\n");
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let mut binding_with_env = binding(&fx);
    binding_with_env.copy_env = vec![".env".into()];
    let run = manager
        .start(StartRun {
            task_id: "task-acc1-PRJ-9".into(),
            issue_key: "PRJ-9".into(),
            binding: binding_with_env,
            context: Some("# PRJ-9\n".into()),
            agent: None,
            jira_url: Some("https://acme.atlassian.net/browse/PRJ-9".into()),
        })
        .unwrap();
    settle(&manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    assert_eq!(
        settle(&manager, &run.run_id).status,
        RunStatus::ReadyForReview
    );
    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let done = settle(&manager, &run.run_id);
    assert_eq!(done.status, RunStatus::Completed, "{:?}", done.error);

    let branch = done.worktree.clone().unwrap().branch;
    let pushed = run_git(
        fx.upstream.path(),
        &["log", "-1", "--format=%s%n%b", &branch],
    );
    assert!(
        pushed.starts_with("feat(result): write pass into result"),
        "{pushed}"
    );
    assert!(!pushed.to_lowercase().contains("co-authored-by"));
    let files = run_git(
        fx.upstream.path(),
        &["show", "--name-only", "--format=", &branch],
    );
    assert_eq!(
        files.trim(),
        "result.txt",
        "the copied .env is not committed"
    );

    let calls = fx.gh_calls();
    let create = calls.iter().find(|call| call[1] == "create").unwrap();
    let flag = |name: &str| create[create.iter().position(|a| a == name).unwrap() + 1].clone();
    assert!(create.contains(&"--draft".to_string()));
    assert_eq!(flag("--base"), "main");
    assert_eq!(flag("--head"), branch);
    assert_eq!(flag("--title"), "feat(result): write pass into result");
    let body = fs::read_to_string(flag("--body-file")).unwrap();
    for section in [
        "## สรุป",
        "## เหตุผล",
        "## การเปลี่ยนแปลง",
        "## การทดสอบ",
        "## ผลกระทบ",
    ] {
        assert!(body.contains(section), "{section}");
    }
    assert!(
        body.contains("- [x] `test`"),
        "testing comes from the app checks:\n{body}"
    );
    assert!(body.contains("[PRJ-9](https://acme.atlassian.net/browse/PRJ-9)"));
}

#[test]
fn an_open_pr_is_updated_and_a_merged_one_is_not_reused() {
    let fx = fixture();
    let open = r#"[{"number":5,"state":"OPEN","url":"https://github.com/acme/service/pull/5"}]"#;
    let manager_open = manager(
        &fx,
        &[("JIRASYNC_FAKE_GH_LIST", open)],
        Duration::from_secs(600),
    );
    let run = reviewed(&manager_open, &fx);
    manager_open.resume(&run.run_id, Decision::Accept).unwrap();
    let done = settle(&manager_open, &run.run_id);
    assert_eq!(
        done.pr_url.as_deref(),
        Some("https://github.com/acme/service/pull/5")
    );
    let calls = fx.gh_calls();
    assert!(calls.iter().any(|call| call[1] == "edit" && call[2] == "5"));
    assert!(
        !calls.iter().any(|call| call[1] == "create"),
        "no duplicate PR"
    );

    let fx = fixture();
    let merged =
        r#"[{"number":3,"state":"MERGED","url":"https://github.com/acme/service/pull/3"}]"#;
    let manager_merged = manager(
        &fx,
        &[("JIRASYNC_FAKE_GH_LIST", merged)],
        Duration::from_secs(600),
    );
    let run = reviewed(&manager_merged, &fx);
    manager_merged
        .resume(&run.run_id, Decision::Accept)
        .unwrap();
    let blocked = settle(&manager_merged, &run.run_id);
    assert_eq!(
        blocked.status,
        RunStatus::ReadyForReview,
        "stays reviewable"
    );
    assert!(blocked.error.unwrap().contains("already merged"));
    assert!(blocked.pr_url.is_none());
}

#[test]
fn a_draft_that_breaks_the_convention_publishes_nothing() {
    let fx = fixture();
    let manager = manager(
        &fx,
        &[("JIRASYNC_FAKE_DRAFT", "english")],
        Duration::from_secs(600),
    );
    let run = reviewed(&manager, &fx);
    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let blocked = settle(&manager, &run.run_id);
    assert_eq!(blocked.status, RunStatus::ReadyForReview);
    assert!(blocked
        .error
        .unwrap()
        .contains("did not submit a pull request draft"));
    let branch = blocked.worktree.unwrap().branch;
    let remote = run_git(fx.upstream.path(), &["branch", "--list", &branch]);
    assert!(remote.is_empty(), "nothing was pushed");
    assert!(fx.gh_calls().is_empty());
}

#[test]
fn a_change_made_after_the_checks_is_checked_again_before_publishing() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let run = reviewed(&manager, &fx);
    let worktree = PathBuf::from(run.worktree.clone().unwrap().path);
    fs::write(worktree.join("result.txt"), "FAIL").unwrap();

    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let blocked = settle(&manager, &run.run_id);
    assert_eq!(blocked.status, RunStatus::ReadyForReview);
    let error = blocked.error.clone().unwrap();
    assert!(
        error.contains("checks fail on the current change: test"),
        "{error}"
    );
    assert_eq!(
        blocked.checks[0].status, "failed",
        "the stale pass was replaced"
    );
    assert!(fx.gh_calls().is_empty(), "nothing was published");
}

#[test]
fn an_independent_reviewer_reports_concerns_without_deciding() {
    let fx = fixture();
    let manager = manager(
        &fx,
        &[("JIRASYNC_FAKE_REVIEW", "concerns")],
        Duration::from_secs(600),
    );
    let run = reviewed(&manager, &fx);
    let review = run.review.clone().unwrap();
    assert_eq!(review.verdict, "concerns");
    assert_eq!(review.findings[0].file, "result.txt");
    assert_eq!(
        run.status,
        RunStatus::ReadyForReview,
        "the owner still decides"
    );

    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    let sessions: Vec<String> = events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::StepStart { step, command } if step == "agent" => Some(command.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(sessions.len(), 3, "plan, implement, review");
    let calls = fx.agent_calls();
    let session_of = |args: &Vec<String>, flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args[i + 1].clone())
    };
    let owner_session = run.session_id.clone().unwrap();
    assert_eq!(
        session_of(&calls[1], "--resume").as_deref(),
        Some(owner_session.as_str())
    );
    let reviewer = session_of(&calls[2], "--session-id").expect("reviewer starts a new session");
    assert_ne!(
        reviewer, owner_session,
        "the reviewer never resumes the author session"
    );
    assert!(session_of(&calls[2], "--resume").is_none());
    assert!(
        sessions
            .iter()
            .all(|command| command.contains("fake_agent_entry")),
        "every agent step is an app-started process"
    );
    assert!(events.iter().any(|e| matches!(
        &e.kind,
        EventKind::Status {
            status: RunStatus::Reviewing,
            ..
        }
    )));
}

#[test]
fn a_reviewer_that_does_not_answer_does_not_block_the_owner() {
    let fx = fixture();
    let manager = manager(
        &fx,
        &[("JIRASYNC_FAKE_REVIEW", "silent")],
        Duration::from_secs(600),
    );
    let run = reviewed(&manager, &fx);
    let review = run.review.unwrap();
    assert_eq!(review.verdict, "unavailable");
    assert!(review.summary.contains("without submitting a review"));
}

fn start_with(manager: &RunManager, binding: RepoBinding) -> RunRecord {
    manager
        .start(StartRun {
            task_id: "task-acc1-PRJ-7".into(),
            issue_key: "PRJ-7".into(),
            binding,
            context: Some("# PRJ-7\n".into()),
            agent: None,
            jira_url: None,
        })
        .unwrap()
}

#[test]
fn migrations_and_run_env_values_are_applied_before_the_agent_works() {
    let fx = fixture();
    fx.clone.write(".env", "# mine\nPORT=3000\nAPI_KEY=keep\n");
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let mut binding = binding(&fx);
    binding.copy_env = vec![".env".into()];
    binding.commands.migrate = Some(CommandSpec {
        executable: "git".into(),
        args: vec!["--version".into()],
    });
    binding.env_overrides = vec![crate::harness::docker::EnvVar {
        key: "PORT".into(),
        value: "{run.port}".into(),
    }];
    let run = start_with(&manager, binding);
    settle(&manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let done = settle(&manager, &run.run_id);
    assert_eq!(done.status, RunStatus::ReadyForReview, "{:?}", done.error);

    let env = fs::read_to_string(PathBuf::from(done.worktree.unwrap().path).join(".env")).unwrap();
    assert!(env.contains("API_KEY=keep") && env.contains("# mine"));
    let port = env
        .lines()
        .find_map(|line| line.strip_prefix("PORT="))
        .unwrap();
    assert_ne!(port, "3000", "the run gets its own port, not the owner's");
    let base = fs::read_to_string(fx.clone.path().join(".env")).unwrap();
    assert!(
        base.contains("PORT=3000"),
        "the base repo .env is untouched"
    );

    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    let order: Vec<&str> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::StepStart { step, .. } => Some(step.as_str()),
            _ => None,
        })
        .collect();
    let migrate = order.iter().position(|step| *step == "migrate").unwrap();
    let agent = order.iter().rposition(|step| *step == "agent").unwrap();
    assert!(
        migrate < agent,
        "migrations run before the agent implements: {order:?}"
    );
    assert_eq!(order.iter().filter(|step| **step == "migrate").count(), 1);
}

#[test]
fn a_failed_migration_stops_before_the_agent_changes_anything() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let mut binding = binding(&fx);
    binding.commands.migrate = Some(CommandSpec {
        executable: "git".into(),
        args: vec!["not-a-command".into()],
    });
    let run = start_with(&manager, binding);
    settle(&manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let failed = settle(&manager, &run.run_id);
    assert_eq!(failed.status, RunStatus::Failed);
    assert!(failed.error.unwrap().contains("migrate failed"));
    let worktree = PathBuf::from(failed.worktree.unwrap().path);
    assert!(!worktree.join("result.txt").exists(), "the agent never ran");
}

/// Needs a local Docker engine: `cargo test --lib real_docker_services_live_only_while_implementing -- --ignored`.
#[test]
#[ignore]
fn real_docker_services_live_only_while_implementing() {
    let fx = fixture();
    let manager = manager(&fx, &[], Duration::from_secs(600));
    let mut binding = binding(&fx);
    binding.services = vec![crate::harness::docker::ServiceSpec {
        name: "cache".into(),
        image: "redis:7-alpine".into(),
        port: 6379,
        env: vec![],
        healthcheck: vec!["CMD".into(), "redis-cli".into(), "ping".into()],
    }];
    binding.env_overrides = vec![crate::harness::docker::EnvVar {
        key: "REDIS_URL".into(),
        value: "redis://{services.cache.host}:{services.cache.port}".into(),
    }];
    let run = start_with(&manager, binding);
    settle(&manager, &run.run_id);
    manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
    let done = settle(&manager, &run.run_id);
    assert_eq!(done.status, RunStatus::ReadyForReview, "{:?}", done.error);

    let env = fs::read_to_string(PathBuf::from(done.worktree.unwrap().path).join(".env")).unwrap();
    assert!(env.contains("REDIS_URL=redis://127.0.0.1:"), "{env}");
    let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
    let lines: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Output { step, text, .. } if step == "services" => Some(text.clone()),
            _ => None,
        })
        .collect();
    println!("{lines:#?}");
    assert!(lines
        .iter()
        .any(|line| line.starts_with("cache (redis:7-alpine) ready on 127.0.0.1:")));
    assert!(lines
        .iter()
        .any(|line| line == "service containers removed"));
    let docker = crate::harness::docker::DockerEndpoint::from_context().unwrap();
    assert_eq!(
        crate::harness::docker::remove_leftovers(&docker).unwrap(),
        0,
        "nothing is left running after the step"
    );
}

fn published(manager: &RunManager, fx: &Fixture) -> RunRecord {
    let run = reviewed(manager, fx);
    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let done = settle(manager, &run.run_id);
    assert_eq!(done.status, RunStatus::Completed, "{:?}", done.error);
    done
}

#[test]
fn a_draft_pr_becomes_ready_only_after_ci_passes() {
    for (checks, why) in [
        ("[]", "no CI checks yet"),
        (
            r#"[{"name":"build","bucket":"pass"},{"name":"e2e","bucket":"pending"}]"#,
            "pending",
        ),
        (r#"[{"name":"build","bucket":"fail"}]"#, "failing"),
    ] {
        let fx = fixture();
        let manager = manager(
            &fx,
            &[("JIRASYNC_FAKE_GH_CHECKS", checks)],
            Duration::from_secs(600),
        );
        let run = published(&manager, &fx);
        let status = manager.pr_checks(&run.run_id).unwrap();
        assert!(!status.all_passed, "{why}");
        assert!(manager.mark_pr_ready(&run.run_id).is_err(), "{why}");
        assert!(
            !fx.gh_calls().iter().any(|call| call[1] == "ready"),
            "{why}"
        );
    }

    let fx = fixture();
    let green = r#"[{"name":"build","bucket":"pass"},{"name":"docs","bucket":"skipping"}]"#;
    let manager = manager(
        &fx,
        &[("JIRASYNC_FAKE_GH_CHECKS", green)],
        Duration::from_secs(600),
    );
    let run = published(&manager, &fx);
    assert!(manager.pr_checks(&run.run_id).unwrap().all_passed);
    let ready = manager.mark_pr_ready(&run.run_id).unwrap();
    assert!(ready.pr_ready);
    let calls = fx.gh_calls();
    let call = calls.iter().find(|call| call[1] == "ready").unwrap();
    assert_eq!(call[2], "https://github.com/acme/service/pull/42");
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
    run_git(clone.path(), &["config", "user.name", "owner"]);
    run_git(
        clone.path(),
        &["config", "user.email", "owner@example.invalid"],
    );
    let worktrees = TempDir::new("real-wt");
    let runs = TempDir::new("real-runs");
    let gh_log = TempDir::new("real-gh");
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
    let mut env = AgentEnv::new(
        AgentLauncher::claude(PathBuf::from("claude")),
        skills,
        Duration::from_secs(600),
    );
    env.model = Some("haiku".into());
    // Real Claude drafts the PR; publishing pushes to the local upstream and a fake gh.
    let gh_env = vec![(
        "JIRASYNC_FAKE_GH_LOG".to_string(),
        gh_log.path().join("gh.log").display().to_string(),
    )];
    env.gh = self_launcher("harness::agent::tests::fake_gh_entry", FAKE_GH_ARGS, gh_env);
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
        services: vec![],
        env_overrides: vec![],
        updated_at: 0,
    };
    let run = manager
        .start(StartRun {
            task_id: "task-acc1-DEMO-1".into(),
            issue_key: "DEMO-1".into(),
            binding,
            context: Some("# DEMO-1: implement sum\n\nImplement `sum` in src/sum.ts so the unit test passes.\n".into()),
            agent: None,
            jira_url: None,
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

    manager.resume(&run.run_id, Decision::Accept).unwrap();
    let published = settle(&manager, &run.run_id);
    let body =
        fs::read_to_string(runs.path().join(&run.run_id).join("pr-body.md")).unwrap_or_default();
    println!("PR BODY:\n{body}");
    assert_eq!(
        published.status,
        RunStatus::Completed,
        "{:?}",
        published.error
    );
    let branch = published.worktree.unwrap().branch;
    let subject = run_git(upstream.path(), &["log", "-1", "--format=%s", &branch]);
    println!("COMMIT: {subject}");
    assert!(crate::harness::tools::is_conventional_header(&subject));
    assert!(body.contains("- [x] `test`"));
}
