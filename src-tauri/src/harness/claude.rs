// Claude Code CLI adapter: the exact flags a harness run uses (proven in the Phase 0 spike),
// the prompts for each step, and the mapping from its stream-json output to journal events.
use super::run::EventKind;
use serde_json::Value;
use std::path::PathBuf;

const MAX_EVENT_CHARS: usize = 4000;

/// Tools for each step. There is never a shell: execution goes through the harness MCP tools.
pub const PLANNING_TOOLS: &str = "Read,Glob,Grep";
pub const IMPLEMENTING_TOOLS: &str = "Read,Glob,Grep,Edit,Write";

pub const SYSTEM_PROMPT: &str = "This is a JiraSync Hub harness run. Skills are provided by the \
JiraSync Hub app over MCP, not by Claude Code. You have no shell: the app executes commands for \
you through the harness tools and the owner watches them live.";

/// How the agent process is started. Production runs `claude`; tests run a fake agent.
#[derive(Clone)]
pub struct AgentLauncher {
    pub executable: PathBuf,
    pub prefix_args: Vec<String>,
    /// When set, the CLI arguments go into this env var (as JSON) instead of argv.
    pub args_env: Option<String>,
    pub env: Vec<(String, String)>,
}

impl AgentLauncher {
    /// Runs `executable` directly with the CLI arguments (Claude, Codex, gh).
    pub fn plain(executable: PathBuf) -> Self {
        Self::claude(executable)
    }

    pub fn claude(executable: PathBuf) -> Self {
        Self {
            executable,
            prefix_args: Vec::new(),
            args_env: None,
            env: Vec::new(),
        }
    }
}

pub enum Session<'a> {
    New(&'a str),
    Resume(&'a str),
}

pub struct Invocation<'a> {
    pub prompt: &'a str,
    pub session: Session<'a>,
    pub tools: &'a str,
    pub mcp_config: &'a str,
    pub model: Option<&'a str>,
}

pub fn args(invocation: &Invocation) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        invocation.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--tools",
        invocation.tools,
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        invocation.mcp_config,
        "--permission-mode",
        "acceptEdits",
        "--permission-prompt-tool",
        "mcp__harness__approve",
        "--append-system-prompt",
        SYSTEM_PROMPT,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    match invocation.session {
        Session::New(id) => args.extend(["--session-id".into(), id.into()]),
        Session::Resume(id) => args.extend(["--resume".into(), id.into()]),
    }
    if let Some(model) = invocation.model {
        args.extend(["--model".into(), model.into()]);
    }
    args
}

/// A random UUID v4 for `--session-id` (the app picks it so it can resume that exact session).
pub fn new_session_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let a = RandomState::new().build_hasher().finish();
    let b = RandomState::new().build_hasher().finish();
    let hex = format!("{a:016x}{b:016x}");
    let variant = ["8", "9", "a", "b"][(b & 3) as usize];
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    )
}

pub fn planning_prompt(issue_key: &str) -> String {
    format!(
        "You are working on Jira task {issue_key} in this git worktree.\n\
1. Call mcp__harness__skill_list, then load the `harness` skill with mcp__harness__skill_get and follow it.\n\
2. Read .harness/task.md (the task). If .harness/progress.md exists, read it: it is where earlier sessions left off.\n\
3. Read the repository's AGENTS.md or CLAUDE.md if present and follow its rules.\n\
4. Write the plan in the language of the ticket title and description in .harness/task.md.\n\
This is the planning step: you can only read. Explore the code and follow the \"Solve it with the \
least new code\" rules of the harness skill: before planning any new function, search for an existing \
helper, a platform or library option, or a setting that already does it, and prefer the smallest change \
that fully solves the task (root cause once, in shared code, with every caller). Then call \
mcp__harness__submit_plan with a concise markdown plan: goal, what you reuse or change instead of \
writing new code (and why no new helper is needed, or why one is), files to change, steps, what you \
skipped or did not check, and which harness commands will verify it (test, build, lint, dev + hurl). \
Then stop and wait for the owner."
    )
}

/// The owner picks the task up again in the same worktree (after a review, a PR, a stop…).
pub fn continue_prompt(issue_key: &str, request: &str) -> String {
    let asked = if request.is_empty() {
        "Find what is still missing for the task.".to_string()
    } else {
        format!("The owner asks:\n\n{request}")
    };
    format!(
        "The owner wants more work on Jira task {issue_key} in this same worktree; your earlier work \
is still here, committed or not. {asked}\n\n\
Read .harness/task.md again (the ticket may have changed) and .harness/progress.md, and check the \
current state with mcp__harness__git (op \"status\" and \"diff\"). This is a planning step again: you \
can only read. Follow the harness skill, then call mcp__harness__submit_plan with the plan for the \
next change, in the language of the ticket. Then stop and wait for the owner."
    )
}

pub fn revise_plan_prompt(feedback: &str) -> String {
    format!(
        "The owner asked for changes to your plan:\n\n{feedback}\n\n\
Revise the plan, call mcp__harness__submit_plan again, then stop."
    )
}

pub const IMPLEMENT_PROMPT: &str = "The owner approved your plan. Implement it now in this worktree. \
Verify with mcp__harness__run (test, build, lint; dev + hurl for HTTP behaviour) and fix until it passes. \
If a command fails because the command itself is wrong, fix it with mcp__harness__set_command; do not ask. \
Keep it as small as the plan: reuse what exists, add no helper, wrapper or option the plan did not name. \
Keep .harness/progress.md updated: what is done, what is next, open questions. Do not commit. \
Finish with a short report of what changed and which harness commands passed, in the language of the ticket.";

pub fn repair_prompt(failures: &str) -> String {
    format!(
        "The app ran its final checks on your change and they failed:\n\n{failures}\n\n\
Fix the cause without asking the owner: your code, or the command itself with mcp__harness__set_command \
when the command is what is wrong. Re-run the failing command with mcp__harness__run until it passes, \
update .harness/progress.md, then finish with a short report in the language of the ticket."
    )
}

/// A setup command failed before the task starts; the agent fixes it without asking.
pub fn setup_repair_prompt(command: &str, failure: &str) -> String {
    format!(
        "The app ran this project's `{command}` command for the run and it failed:\n\n```\n{failure}\n```\n\n\
Fix it now; do not ask the owner. Load the `harness` skill first if you have not. If the command itself \
is wrong (flags, folder, script name), correct it with mcp__harness__set_command. If the repository needs a \
fix (manifest, lockfile, config, migration), edit it. Then run mcp__harness__run with command \"{command}\" \
until it passes. Do not start on the task itself yet. Finish with one short line on what you fixed, in the \
language of the ticket."
    )
}

pub fn changes_prompt(feedback: &str) -> String {
    format!(
        "The owner reviewed your change and asks for this:\n\n{feedback}\n\n\
Read .harness/progress.md, make the changes, verify with mcp__harness__run, \
update .harness/progress.md, then finish with a short report in the language of the ticket."
    )
}

pub fn reviewer_prompt(issue_key: &str, checks: &str) -> String {
    format!(
        "You are an independent reviewer for Jira task {issue_key}. Another agent wrote the change; \
you did not, so judge it critically. You can only read.\n\
1. Read .harness/task.md (what was asked) and the repository's AGENTS.md or CLAUDE.md if present.\n\
2. Read the real change with mcp__harness__git (op \"status\" and \"diff\").\n\
3. The app ran these checks itself on this change: {checks}.\n\
Look for: requirements in the task that the diff does not meet, changes the task did not ask for, \
new helpers, wrappers or options where an existing function, a platform or library feature, or a \
one-line change would do, \
risky or broken logic, missing tests for the new behaviour, and secrets or debug leftovers.\n\
Then call mcp__harness__submit_review with verdict \"approve\" (nothing important found) or \
\"concerns\" with findings (file + issue), written in the language of the ticket. Be concrete and brief. Then stop."
    )
}

pub fn drafting_prompt(issue_key: &str) -> String {
    format!(
        "The owner accepted your change for {issue_key}. Write the commit and pull request text now; \
you can only read. Look at the real change with mcp__harness__git (op \"status\" and \"diff\") and \
ground every bullet in it. Then call mcp__harness__submit_pr_draft with:\n\
- title and commitMessage in English, conventional commit style (e.g. \"fix(api): handle empty ids\"), \
header at most 72 characters;\n\
- summary, reason, changes, impact in Thai as short markdown bullets (impact lists \
Breaking change / DB migration / Config change as มี or ไม่มี).\n\
Do not write test results (the app adds them from its own checks) and never add AI attribution \
or Co-Authored-By lines. If the tool rejects the draft, fix what it says and submit again. Then stop."
    )
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_EVENT_CHARS {
        return text.to_string();
    }
    let clipped: String = text.chars().take(MAX_EVENT_CHARS).collect();
    format!("{clipped}…")
}

pub fn tool_summary(name: &str, input: &Value) -> String {
    let short = name.strip_prefix("mcp__harness__").unwrap_or(name);
    let detail = ["command", "file_path", "pattern", "op", "name", "logId"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .unwrap_or("");
    let files = input
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    [short, detail, files.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Maps one stream-json line to journal events. Non-JSON lines stay plain output (`None`).
pub fn parse_stream_line(_step: &str, line: &str) -> Option<Vec<EventKind>> {
    let event: Value = serde_json::from_str(line).ok()?;
    let agent = |kind: &str, text: String| EventKind::Agent {
        kind: kind.into(),
        text: clip(&text),
    };
    let events = match event.get("type").and_then(Value::as_str) {
        Some("system") if event.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![agent(
                "init",
                format!(
                    "{} · {} tools",
                    event
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("model"),
                    event
                        .get("tools")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len)
                ),
            )]
        }
        Some("assistant") => event
            .pointer("/message/content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                        Some("text") => block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.trim().is_empty())
                            .map(|text| agent("text", text.to_string())),
                        Some("tool_use") => Some(agent(
                            "tool",
                            tool_summary(
                                block.get("name").and_then(Value::as_str).unwrap_or("tool"),
                                block.get("input").unwrap_or(&Value::Null),
                            ),
                        )),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("result") => vec![agent(
            "result",
            format!(
                "{} · {} turns · ${:.4}",
                event
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("done"),
                event.get("num_turns").and_then(Value::as_u64).unwrap_or(0),
                event
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            ),
        )],
        _ => Vec::new(),
    };
    Some(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flags_never_include_a_shell_or_bypass() {
        let args = args(&Invocation {
            prompt: "do it",
            session: Session::Resume("abc"),
            tools: IMPLEMENTING_TOOLS,
            mcp_config: "C:/runs/x/mcp.json",
            model: Some("haiku"),
        });
        let joined = args.join(" ");
        for required in [
            "--restricted",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--permission-prompt-tool mcp__harness__approve",
            "--resume abc",
            "--model haiku",
        ] {
            assert!(joined.contains(required), "{required}");
        }
        let tools = &args[args.iter().position(|a| a == "--tools").unwrap() + 1];
        assert!(!tools.contains("Bash") && !tools.contains("PowerShell"));
        assert!(!joined.contains("dangerously") && !joined.contains("bypassPermissions"));
        assert!(
            args.contains(&"do it".to_string()),
            "prompt is one argument, not shell text"
        );
    }

    #[test]
    fn session_ids_are_uuid_v4() {
        let id = new_session_id();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!("89ab".contains(&parts[3][..1]));
        assert_ne!(id, new_session_id());
    }

    #[test]
    fn stream_json_becomes_readable_agent_events() {
        let assistant = json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Reading the task"},
            {"type": "tool_use", "name": "mcp__harness__run", "input": {"command": "hurl", "files": ["a.hurl"]}},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "src/a.ts"}}
        ]}});
        let events = parse_stream_line("agent", &assistant.to_string()).unwrap();
        let texts: Vec<String> = events
            .iter()
            .map(|e| match e {
                EventKind::Agent { kind, text } => format!("{kind}: {text}"),
                _ => String::new(),
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                "text: Reading the task",
                "tool: run hurl a.hurl",
                "tool: Edit src/a.ts"
            ]
        );

        let result = json!({"type": "result", "subtype": "success", "num_turns": 7, "total_cost_usd": 0.0123});
        let events = parse_stream_line("agent", &result.to_string()).unwrap();
        assert!(
            matches!(&events[0], EventKind::Agent { kind, text } if kind == "result" && text == "success · 7 turns · $0.0123")
        );

        let tool_result =
            json!({"type": "user", "message": {"content": [{"type": "tool_result"}]}});
        assert!(parse_stream_line("agent", &tool_result.to_string())
            .unwrap()
            .is_empty());
        assert!(
            parse_stream_line("agent", "plain warning").is_none(),
            "non-JSON stays output"
        );
    }
}
