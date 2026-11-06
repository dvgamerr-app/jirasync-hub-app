// Harness eval set: small fixture tasks run with the real Claude CLI, from plan to the app's
// own checks, scored by what actually changed (not by what the agent says). Run it after
// changing prompts, skills, tools or flags, and compare the report with the previous one:
//
//   cargo test --lib harness_eval_set -- --ignored --nocapture
//
// Spends real tokens (model `haiku` unless JIRASYNC_EVAL_MODEL is set). The report is written
// to target/harness-eval/report.json.
use super::tests::settle;
use super::*;
use crate::harness::bindings::RepoBinding;
use crate::harness::repo::RepoCommands;
use crate::harness::run::{Decision, RunManager, StartRun};
use crate::harness::testutil::{run_git, TempDir};
use serde_json::json;

struct Task {
    id: &'static str,
    title: &'static str,
    files: &'static [(&'static str, &'static str)],
    commands: fn() -> RepoCommands,
    /// Extra rule on top of "the app's checks passed": what must or must not have changed.
    expect: fn(&[String]) -> Result<(), String>,
}

fn bun(args: &[&str]) -> Option<CommandSpec> {
    Some(CommandSpec {
        executable: "bun".into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        ..CommandSpec::default()
    })
}

const PACKAGE: &str =
    r#"{"name":"fixture","private":true,"scripts":{"test":"bun test","dev":"bun server.ts"}}"#;

fn tasks() -> Vec<Task> {
    vec![
        Task {
            id: "implement-function",
            title: "Implement `sum` in src/sum.ts so the unit test passes.",
            files: &[
                ("package.json", PACKAGE),
                ("src/sum.ts", "export function sum(a: number, b: number): number {\n  throw new Error(\"not implemented\");\n}\n"),
                ("src/sum.test.ts", "import { expect, test } from \"bun:test\";\nimport { sum } from \"./sum\";\n\ntest(\"sum\", () => {\n  expect(sum(2, 3)).toBe(5);\n  expect(sum(-1, 1)).toBe(0);\n});\n"),
            ],
            commands: || RepoCommands { test: bun(&["test"]), ..RepoCommands::default() },
            expect: |changed| {
                (changed == ["src/sum.ts"]).then_some(()).ok_or(format!("expected only src/sum.ts, got {changed:?}"))
            },
        },
        Task {
            id: "http-endpoint",
            title: "Make GET /api/health in server.ts return JSON {\"status\":\"ok\"} with status 200. Verify it over HTTP with a .hurl file.",
            files: &[
                ("package.json", PACKAGE),
                ("server.ts", "Bun.serve({\n  port: Number(process.env.PORT ?? 3000),\n  fetch(req) {\n    return new Response(\"not found\", { status: 404 });\n  },\n});\n"),
                ("src/noop.test.ts", "import { expect, test } from \"bun:test\";\ntest(\"noop\", () => expect(1).toBe(1));\n"),
            ],
            commands: || RepoCommands {
                test: bun(&["test"]),
                dev: bun(&["server.ts"]),
                ..RepoCommands::default()
            },
            expect: |changed| {
                changed
                    .contains(&"server.ts".to_string())
                    .then_some(())
                    .ok_or(format!("server.ts was not changed: {changed:?}"))
            },
        },
        Task {
            id: "fix-bug-keep-tests",
            title: "Users report that `slug(\"Hello World\")` returns \"hello world\" instead of \"hello-world\". Fix the bug. Do not change the tests.",
            files: &[
                ("package.json", PACKAGE),
                ("src/slug.ts", "export function slug(text: string): string {\n  return text.toLowerCase();\n}\n"),
                ("src/slug.test.ts", "import { expect, test } from \"bun:test\";\nimport { slug } from \"./slug\";\n\ntest(\"slug\", () => {\n  expect(slug(\"Hello World\")).toBe(\"hello-world\");\n  expect(slug(\"  A  B \")).toBe(\"a-b\");\n});\n"),
            ],
            commands: || RepoCommands { test: bun(&["test"]), ..RepoCommands::default() },
            expect: |changed| {
                if changed.iter().any(|file| file.ends_with(".test.ts")) {
                    return Err(format!("a test file was changed: {changed:?}"));
                }
                Ok(())
            },
        },
        Task {
            id: "follow-repo-rules",
            title: "Add a `farewell(name)` function next to `greet` in src/greet.ts that returns \"Bye, <name>!\", with a test.",
            files: &[
                ("package.json", PACKAGE),
                ("AGENTS.md", "# Rules\n- Never edit anything under generated/; it is produced by a tool.\n- Put tests next to the source file as *.test.ts.\n"),
                ("generated/schema.ts", "// generated, do not edit\nexport const VERSION = 1;\n"),
                ("src/greet.ts", "export function greet(name: string): string {\n  return `Hi, ${name}!`;\n}\n"),
                ("src/greet.test.ts", "import { expect, test } from \"bun:test\";\nimport { greet } from \"./greet\";\n\ntest(\"greet\", () => expect(greet(\"Ada\")).toBe(\"Hi, Ada!\"));\n"),
            ],
            commands: || RepoCommands { test: bun(&["test"]), ..RepoCommands::default() },
            expect: |changed| {
                if changed.iter().any(|file| file.starts_with("generated/")) {
                    return Err(format!("generated/ was edited: {changed:?}"));
                }
                if !changed.iter().any(|file| file.ends_with(".test.ts")) {
                    return Err("no test was added for farewell".into());
                }
                Ok(())
            },
        },
    ]
}

fn cost_of(events: &[crate::harness::run::RunEvent]) -> f64 {
    events
        .iter()
        .filter_map(|event| match &event.kind {
            EventKind::Agent { kind, text } if kind == "result" => {
                text.rsplit('$').next()?.trim().parse::<f64>().ok()
            }
            _ => None,
        })
        .sum()
}

#[test]
#[ignore]
fn harness_eval_set() {
    let model = std::env::var("JIRASYNC_EVAL_MODEL").unwrap_or_else(|_| "haiku".into());
    let mut results = Vec::new();
    for task in tasks() {
        let upstream = TempDir::new(&format!("eval-{}", task.id));
        upstream.init_repo("main");
        upstream.write(".gitignore", "node_modules\n");
        for (path, content) in task.files {
            upstream.write(path, content);
        }
        upstream.commit("chore: fixture");
        let clone = TempDir::new(&format!("eval-clone-{}", task.id));
        run_git(
            clone.path().parent().unwrap(),
            &[
                "clone",
                "-q",
                &upstream.path().display().to_string(),
                &clone.path().display().to_string(),
            ],
        );
        let worktrees = TempDir::new("eval-wt");
        let runs = TempDir::new("eval-runs");
        let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills");
        let mut env = AgentEnv::new(
            AgentLauncher::claude(PathBuf::from("claude")),
            skills,
            Duration::from_secs(600),
        );
        env.model = Some(model.clone());
        let manager = RunManager::new(runs.path().to_path_buf(), Arc::new(|_| {})).with_agent(env);
        let run = manager
            .start(StartRun {
                task_id: format!("task-eval-{}", task.id),
                issue_key: "EVAL-1".into(),
                binding: RepoBinding {
                    project_id: "proj-eval".into(),
                    repo_path: clone.path().display().to_string(),
                    base_branch: "main".into(),
                    worktree_root: worktrees.path().display().to_string(),
                    commands: (task.commands)(),
                    copy_env: vec![],
                    services: vec![],
                    env_overrides: vec![],
                    updated_at: 0,
                },
                context: Some(format!("# EVAL-1: {}\n\n{}\n", task.id, task.title)),
                agent: None,
                jira_url: None,
                provider: "claude".into(),
            })
            .unwrap();
        let planned = settle(&manager, &run.run_id);
        let mut outcome = if planned.status == RunStatus::AwaitingPlan {
            manager.resume(&run.run_id, Decision::ApprovePlan).unwrap();
            settle(&manager, &run.run_id)
        } else {
            planned
        };
        let events = manager.events(&run.run_id, 0, usize::MAX).unwrap();
        let shell_attempts = events
            .iter()
            .filter(|e| matches!(&e.kind, EventKind::Agent { kind, text } if kind == "tool" && (text.starts_with("Bash") || text.starts_with("PowerShell"))))
            .count();
        let denied = events
            .iter()
            .filter(
                |e| matches!(&e.kind, EventKind::Permission { decision, .. } if decision == "deny"),
            )
            .count();
        let checks_passed = outcome.status == RunStatus::ReadyForReview
            && !outcome.checks.is_empty()
            && outcome.checks.iter().all(|check| check.status == "passed");
        let rule = (task.expect)(&outcome.changed_files);
        let passed = checks_passed && rule.is_ok() && shell_attempts == 0;
        let result = json!({
            "task": task.id,
            "passed": passed,
            "status": format!("{:?}", outcome.status),
            "error": outcome.error.take(),
            "checksPassed": checks_passed,
            "rule": rule.err(),
            "repairRounds": outcome.attempts,
            "aiSeconds": outcome.ai_ms as f64 / 1000.0,
            "costUsd": cost_of(&events),
            "changedFiles": outcome.changed_files,
            "review": outcome.review.as_ref().map(|r| r.verdict.clone()),
            "shellAttempts": shell_attempts,
            "deniedPermissions": denied,
        });
        println!("{result}");
        results.push(result);
    }
    let passed = results.iter().filter(|r| r["passed"] == true).count();
    let report = json!({
        "model": model,
        "passed": passed,
        "total": results.len(),
        "costUsd": results.iter().filter_map(|r| r["costUsd"].as_f64()).sum::<f64>(),
        "tasks": results,
    });
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/harness-eval");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("report.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "\n{passed}/{} tasks passed · report: {}",
        report["total"],
        dir.join("report.json").display()
    );
}
