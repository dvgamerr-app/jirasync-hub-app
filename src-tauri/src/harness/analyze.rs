// AI repo analysis: a read-only Claude pass over a repo that proposes how the app should
// install, check and run it (including monorepos and submodules). The owner never types these;
// the result only fills a binding draft, and runs still execute through the app's own steps.
use super::docker::{EnvVar, ServiceSpec};
use super::exec::{resolve_executable, run};
use super::repo::{CommandSpec, FileDetection, RepoCommands};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const ANALYZE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Analysis {
    pub commands: RepoCommands,
    pub services: Vec<ServiceSpec>,
    pub env_overrides: Vec<EnvVar>,
    /// Env files to copy into each worktree, relative to the repo root (sub-repos included).
    pub copy_env: Vec<String>,
    /// One short line on what the repo is (e.g. "bun monorepo: api + web").
    pub summary: String,
    pub notes: Vec<String>,
}

pub fn prompt(files: &FileDetection) -> String {
    let hint = serde_json::to_string(&serde_json::json!({
        "ecosystem": files.ecosystem,
        "commands": files.commands,
        "composeFiles": files.compose_files,
        "envFiles": files.env_files,
        "envExample": files.env_example_file,
        "serviceEnvKeys": files.service_env_keys,
    }))
    .unwrap_or_default();
    format!(
        "You are configuring an automation that will run coding agents on this repository. \
You can only read files. Read the manifests, lockfiles, CI workflows, README/AGENTS.md/CLAUDE.md, \
compose files and .env.example. The repo may be a monorepo or use git submodules (.gitmodules): \
work out which part is the app a developer changes and how it is built.\n\
Propose ONE command per slot (install, build, test, lint, dev, migrate); use null when the repo has none. \
A command is an executable plus an args array, never a shell (no powershell, cmd, bash, sh), no pipes, \
no `&&`. It may carry `env` ([{{key,value}}] set for that command only) and `then` (more commands run \
after it, in order, while each passes), e.g. install = bun install in api, then bun install in web. \
For a sub-folder or workspace use the tool's own directory flag or a workspace runner \
(e.g. `bun install --cwd api --frozen-lockfile`, `bun run --cwd api test`, `pnpm -C web install --frozen-lockfile`, `npm --prefix web ci`, \
`cargo --manifest-path api/Cargo.toml test`, `go -C api test ./...`, `uv --directory api sync`, \
`pnpm -r run build`). Prefer reproducible installs (frozen lockfile) and non-watch, non-interactive modes.\n\
services: databases/caches the app needs while running, as {{name,image,port,env:[{{key,value}}],healthcheck:[]}} \
(port = port inside the container). envOverrides: per-run .env values; use the placeholders \
{{services.<name>.host}}, {{services.<name>.port}} and {{run.port}} instead of fixed ports.\n\
copyEnv: the git-ignored env files a developer keeps locally (e.g. `.env`, `api/.env`; sub-repos too) that must be copied into a fresh checkout; only files that exist.
\nIf the repo (or a sub-repo) has .qlty/qlty.toml, lint is `qlty check --all` (Qlty covers lint and \
format for every language at once): do not list per-language linters or formatters. \
summary is ONE short sentence (what the repo is); put anything else in notes, one short line each.\n\
A rough deterministic guess from the root files, which may be wrong or incomplete: {hint}\n\
Reply with ONLY one JSON object, no markdown fence, shaped as: \
{{\"summary\":string,\"commands\":{{\"install\":{{\"executable\":string,\"args\":[string]}}|null,\"build\":...,\"test\":...,\"lint\":...,\"dev\":...,\"migrate\":...}},\
\"services\":[...],\"copyEnv\":[string],\"envOverrides\":[{{\"key\":string,\"value\":string}}],\"notes\":[string]}}"
    )
}

/// The first JSON object in the model's reply (tolerates prose or a fence around it).
pub fn parse_reply(text: &str) -> Result<Analysis, String> {
    let start = text.find('{').ok_or("the AI reply had no JSON")?;
    let end = text.rfind('}').ok_or("the AI reply had no JSON")?;
    let analysis: Analysis = serde_json::from_str(&text[start..=end])
        .map_err(|e| format!("could not read the AI reply: {e}"))?;
    Ok(analysis)
}

/// Pulls the model text out of `claude -p --output-format json`.
fn reply_text(stdout: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("unexpected output from claude: {e}"))?;
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(value
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("claude reported an error")
            .to_string());
    }
    value
        .get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "claude returned no result".into())
}

/// `bun --cwd dir install` makes bun look for a *script* called install; for bun's own
/// subcommands the flag has to come after them (`bun install --cwd dir`).
fn fix_bun_cwd(spec: &mut CommandSpec) {
    const BUILTIN: &[&str] = &[
        "install", "i", "add", "remove", "update", "test", "ci", "x", "pm",
    ];
    if spec.executable != "bun" || spec.args.len() < 3 || spec.args[0] != "--cwd" {
        return;
    }
    if BUILTIN.contains(&spec.args[2].as_str()) {
        let (dir, sub) = (spec.args[1].clone(), spec.args[2].clone());
        let rest = spec.args.split_off(3);
        spec.args = [vec![sub, "--cwd".into(), dir], rest].concat();
    }
}

/// Drops commands whose executable is not a bare tool name, so a bad guess cannot point at a
/// script inside the repo.
fn sanitize(mut analysis: Analysis) -> Analysis {
    let ok = |spec: &Option<CommandSpec>| {
        spec.as_ref().is_none_or(|spec| {
            super::bindings::check_command("command", spec).is_ok()
                && std::iter::once(spec).chain(&spec.then).all(|part| {
                    let name = part.executable.trim();
                    !name.contains(['/', '\\']) && !name.contains(char::is_whitespace)
                })
        })
    };
    for slot in [
        &mut analysis.commands.install,
        &mut analysis.commands.build,
        &mut analysis.commands.test,
        &mut analysis.commands.lint,
        &mut analysis.commands.dev,
        &mut analysis.commands.migrate,
    ]
    .into_iter()
    .flatten()
    {
        fix_bun_cwd(slot);
    }
    analysis
        .copy_env
        .retain(|file| super::bindings::is_safe_relative_path(file));
    let commands = &mut analysis.commands;
    for (slot, label) in [
        (&mut commands.install, "install"),
        (&mut commands.build, "build"),
        (&mut commands.test, "test"),
        (&mut commands.lint, "lint"),
        (&mut commands.dev, "dev"),
        (&mut commands.migrate, "migrate"),
    ] {
        if !ok(slot) {
            *slot = None;
            analysis.notes.push(format!(
                "dropped the {label} command: not a plain executable"
            ));
        }
    }
    analysis
}

pub fn analyze_repo(root: &Path, files: &FileDetection) -> Result<Analysis, String> {
    let claude = resolve_executable("claude").ok_or("claude is not installed or not on PATH")?;
    let args = [
        "-p",
        &prompt(files),
        "--output-format",
        "json",
        "--restricted",
        "--tools",
        "Read,Glob,Grep",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--permission-mode",
        "acceptEdits",
    ];
    let output = run(&claude, &args, Some(root), ANALYZE_TIMEOUT)?;
    if !output.ok() {
        return Err(format!("claude failed ({})", output.failure()));
    }
    Ok(sanitize(parse_reply(&reply_text(&output.stdout)?)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_reply_wrapped_in_prose_and_a_fence() {
        let reply = "Here you go:\n```json\n{\"summary\":\"bun monorepo\",\"commands\":{\"install\":{\"executable\":\"bun\",\"args\":[\"install\"]},\"test\":null},\"services\":[],\"envOverrides\":[{\"key\":\"PORT\",\"value\":\"{run.port}\"}],\"notes\":[]}\n```";
        let analysis = parse_reply(reply).unwrap();
        assert_eq!(analysis.summary, "bun monorepo");
        assert_eq!(analysis.commands.install.unwrap().executable, "bun");
        assert!(analysis.commands.test.is_none());
        assert_eq!(analysis.env_overrides[0].key, "PORT");
    }

    #[test]
    fn a_shell_is_never_accepted_as_a_command() {
        let analysis = sanitize(
            parse_reply(
                r#"{"commands":{"test":{"executable":"pwsh","args":["-Command","bun test"]},"build":{"executable":"bun","args":["run","build"]}}}"#,
            )
            .unwrap(),
        );
        assert!(analysis.commands.test.is_none());
        assert!(analysis.commands.build.is_some());
    }

    #[test]
    fn a_reply_without_json_is_an_error() {
        assert!(parse_reply("I could not read the repo").is_err());
    }

    #[test]
    fn executables_that_are_paths_are_dropped_with_a_note() {
        let analysis = sanitize(
            parse_reply(
                r#"{"commands":{"install":{"executable":"./scripts/setup.sh","args":[]},"test":{"executable":"bun","args":["test"]}}}"#,
            )
            .unwrap(),
        );
        assert!(analysis.commands.install.is_none());
        assert!(analysis.commands.test.is_some());
        assert_eq!(analysis.notes.len(), 1);
    }

    #[test]
    fn bun_cwd_before_a_builtin_subcommand_is_moved_after_it() {
        let analysis = sanitize(
            parse_reply(
                r#"{"commands":{"install":{"executable":"bun","args":["--cwd","be","install","--frozen-lockfile"]},"build":{"executable":"bun","args":["--cwd","be","run","build"]}},"copyEnv":["be/.env","../x/.env"]}"#,
            )
            .unwrap(),
        );
        assert_eq!(
            analysis.commands.install.unwrap().args,
            ["install", "--cwd", "be", "--frozen-lockfile"]
        );
        assert_eq!(
            analysis.commands.build.unwrap().args,
            ["--cwd", "be", "run", "build"],
            "scripts keep the global flag first"
        );
        assert_eq!(analysis.copy_env, ["be/.env"]);
    }
    #[test]
    fn claude_error_results_are_reported() {
        let error = reply_text(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err();
        assert_eq!(error, "Not logged in");
        assert_eq!(
            reply_text(r#"{"is_error":false,"result":"{}"}"#).unwrap(),
            "{}"
        );
    }
}
