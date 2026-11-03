// Repo detection: proposes install/build/test/lint/dev commands, env files to copy, and
// service env keys for any bound repo, deterministically from its files (no AI, no tokens).
// The owner reviews and saves the result as a binding; runs only use the saved binding.
use super::docker::{parse_compose, propose_overrides, EnvVar, ServiceSpec};
use super::exec::{git, resolve_executable};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub executable: String,
    pub args: Vec<String>,
}

fn spec(executable: &str, args: &[&str]) -> CommandSpec {
    CommandSpec {
        executable: executable.into(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommands {
    pub install: Option<CommandSpec>,
    pub build: Option<CommandSpec>,
    pub test: Option<CommandSpec>,
    pub lint: Option<CommandSpec>,
    pub dev: Option<CommandSpec>,
    /// Database migrations, run after services start and before the agent works.
    pub migrate: Option<CommandSpec>,
}

impl RepoCommands {
    pub fn all(&self) -> [(&'static str, Option<&CommandSpec>); 6] {
        [
            ("install", self.install.as_ref()),
            ("build", self.build.as_ref()),
            ("test", self.test.as_ref()),
            ("lint", self.lint.as_ref()),
            ("dev", self.dev.as_ref()),
            ("migrate", self.migrate.as_ref()),
        ]
    }
}

/// What the repo's files say, before anything is saved.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDetection {
    pub ecosystem: Option<String>,
    pub commands: RepoCommands,
    /// Env files present in the repo root (candidates to copy into each worktree).
    pub env_files: Vec<String>,
    pub env_example_file: Option<String>,
    /// Keys in the example file that the real `.env` does not define.
    pub missing_env_keys: Vec<String>,
    /// Keys that look like a service address (DB, cache, port) and may need a per-run value.
    pub service_env_keys: Vec<String>,
    pub compose_files: Vec<String>,
    /// Services proposed from the first compose file (the owner reviews them in Setup).
    pub services: Vec<ServiceSpec>,
    /// Per-run values for service env keys, derived from the example file only.
    pub env_overrides: Vec<EnvVar>,
    pub notes: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetection {
    pub root: String,
    pub remote_url: Option<String>,
    pub default_branch: String,
    #[serde(flatten)]
    pub files: FileDetection,
    /// Executables used by the proposed commands that are not on PATH on this machine.
    pub missing_executables: Vec<String>,
}

const ENV_CANDIDATES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.test",
    ".env.test.local",
];
const ENV_EXAMPLES: &[&str] = &[".env.example", ".env.sample", ".env.template"];
const COMPOSE_FILES: &[&str] = &[
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

fn env_keys(path: &Path) -> BTreeSet<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeSet::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (key, _) = line.split_once('=')?;
            let key = key.trim();
            let valid = !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
            valid.then(|| key.to_string())
        })
        .collect()
}

fn is_service_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    const SUFFIXES: &[&str] = &["_URL", "_URI", "_HOST", "_PORT", "_DSN"];
    const PREFIXES: &[&str] = &[
        "DATABASE_",
        "DB_",
        "POSTGRES",
        "PG",
        "MYSQL_",
        "MARIADB_",
        "MONGO",
        "REDIS_",
        "AMQP_",
        "RABBITMQ_",
        "KAFKA_",
        "ELASTIC",
        "MINIO_",
        "S3_",
    ];
    upper == "PORT"
        || SUFFIXES.iter().any(|suffix| upper.ends_with(suffix))
        || PREFIXES.iter().any(|prefix| upper.starts_with(prefix))
}

fn js_commands(root: &Path, runner: &str, notes: &mut Vec<String>) -> RepoCommands {
    let install = match runner {
        "bun" => spec("bun", &["install", "--frozen-lockfile"]),
        "pnpm" => spec("pnpm", &["install", "--frozen-lockfile"]),
        "yarn" => {
            // Yarn Berry writes `.yarnrc.yml`; v1 does not.
            if root.join(".yarnrc.yml").exists() {
                spec("yarn", &["install", "--immutable"])
            } else {
                spec("yarn", &["install", "--frozen-lockfile"])
            }
        }
        _ => spec("npm", &["ci"]),
    };
    let scripts: BTreeSet<String> = fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("scripts")?.as_object().cloned())
        .map(|scripts| scripts.keys().cloned().collect())
        .unwrap_or_default();
    if scripts.is_empty() {
        notes.push("package.json has no scripts; set build/test/dev by hand".into());
    }
    let script = |name: &str| -> Option<CommandSpec> {
        scripts.contains(name).then(|| match runner {
            "yarn" => spec("yarn", &[name]),
            other => spec(other, &["run", name]),
        })
    };
    RepoCommands {
        install: Some(install),
        build: script("build"),
        test: script("test"),
        lint: script("lint"),
        dev: script("dev").or_else(|| script("start")),
        migrate: [
            "migrate",
            "db:migrate",
            "migrate:deploy",
            "migration:run",
            "migrate:up",
        ]
        .iter()
        .find_map(|name| script(name)),
    }
}

fn package_manager_field(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let field = json.get("packageManager")?.as_str()?;
    Some(field.split('@').next()?.to_string())
}

pub fn detect_files(root: &Path) -> FileDetection {
    let mut detection = FileDetection::default();
    let has = |name: &str| root.join(name).is_file();

    let js_locks: Vec<(&str, &str)> = [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ]
    .into_iter()
    .filter(|(file, _)| has(file))
    .collect();
    let mut ecosystems = Vec::new();
    if has("package.json") {
        let declared = package_manager_field(root);
        let runner = declared
            .clone()
            .filter(|name| ["bun", "pnpm", "yarn", "npm"].contains(&name.as_str()))
            .or_else(|| js_locks.first().map(|(_, runner)| runner.to_string()))
            .unwrap_or_else(|| "npm".into());
        let distinct: BTreeSet<&str> = js_locks.iter().map(|(_, runner)| *runner).collect();
        if distinct.len() > 1 {
            detection.notes.push(format!(
                "several lockfiles found ({}); using {runner}",
                js_locks
                    .iter()
                    .map(|(file, _)| *file)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if js_locks.is_empty() {
            detection
                .notes
                .push("no JavaScript lockfile; install is not reproducible".into());
        }
        detection.commands = js_commands(root, &runner, &mut detection.notes);
        ecosystems.push(runner);
    }
    if has("Cargo.toml") {
        if ecosystems.is_empty() {
            detection.commands = RepoCommands {
                install: Some(spec("cargo", &["fetch"])),
                build: Some(spec("cargo", &["build"])),
                test: Some(spec("cargo", &["test"])),
                lint: Some(spec("cargo", &["clippy"])),
                dev: None,
                migrate: None,
            };
        }
        ecosystems.push("cargo".into());
    }
    if has("go.mod") {
        if ecosystems.is_empty() {
            detection.commands = RepoCommands {
                install: Some(spec("go", &["mod", "download"])),
                build: Some(spec("go", &["build", "./..."])),
                test: Some(spec("go", &["test", "./..."])),
                lint: Some(spec("go", &["vet", "./..."])),
                dev: None,
                migrate: None,
            };
        }
        ecosystems.push("go".into());
    }
    if has("uv.lock") || has("pyproject.toml") {
        if ecosystems.is_empty() {
            detection.commands = RepoCommands {
                install: has("uv.lock").then(|| spec("uv", &["sync"])),
                ..RepoCommands::default()
            };
            detection
                .notes
                .push("Python project: set test/dev commands by hand (e.g. uv run pytest)".into());
        }
        ecosystems.push("python".into());
    }
    if ecosystems.len() > 1 {
        detection.notes.push(format!(
            "several ecosystems found ({}); commands use {} — review them",
            ecosystems.join(", "),
            ecosystems[0]
        ));
    }
    if ecosystems.is_empty() {
        detection
            .notes
            .push("no known manifest found; set the commands by hand".into());
    }
    detection.ecosystem = ecosystems.into_iter().next();

    detection.env_files = ENV_CANDIDATES
        .iter()
        .filter(|name| has(name))
        .map(|name| name.to_string())
        .collect();
    detection.env_example_file = ENV_EXAMPLES
        .iter()
        .find(|name| has(name))
        .map(|name| name.to_string());
    let defined = env_keys(&root.join(".env"));
    let example = detection
        .env_example_file
        .as_ref()
        .map(|name| env_keys(&root.join(name)))
        .unwrap_or_default();
    detection.missing_env_keys = example.difference(&defined).cloned().collect();
    detection.service_env_keys = example
        .union(&defined)
        .filter(|key| is_service_key(key))
        .cloned()
        .collect();
    detection.compose_files = COMPOSE_FILES
        .iter()
        .filter(|name| has(name))
        .map(|name| name.to_string())
        .collect();
    if let Some(compose) = detection.compose_files.first() {
        match fs::read_to_string(root.join(compose))
            .map_err(|e| e.to_string())
            .and_then(|text| parse_compose(&text))
        {
            Ok(found) => {
                detection.services = found.services;
                detection.notes.extend(found.unsupported);
            }
            Err(error) => detection.notes.push(format!("{compose}: {error}")),
        }
    }
    let example_text = detection
        .env_example_file
        .as_ref()
        .and_then(|name| fs::read_to_string(root.join(name)).ok())
        .unwrap_or_default();
    detection.env_overrides = propose_overrides(&example_text, &detection.services);
    if !detection.services.is_empty() && detection.commands.migrate.is_none() {
        detection.notes.push(
            "no migration script found: set the migrate command, or leave it empty if the app migrates on start"
                .into(),
        );
    }
    detection
}

/// The repo's top-level directory, or an error when `path` is not inside a git repo.
pub fn git_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    let root = git(&["rev-parse", "--show-toplevel"], path, GIT_TIMEOUT)
        .map_err(|_| format!("{} is not inside a git repository", path.display()))?;
    Ok(PathBuf::from(root))
}

pub fn default_branch(root: &Path) -> String {
    if let Ok(head) = git(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        root,
        GIT_TIMEOUT,
    ) {
        if let Some(branch) = head.strip_prefix("origin/") {
            return branch.to_string();
        }
    }
    git(&["branch", "--show-current"], root, GIT_TIMEOUT)
        .ok()
        .filter(|branch| !branch.is_empty())
        .unwrap_or_else(|| "main".into())
}

pub fn detect_repo(path: &Path) -> Result<RepoDetection, String> {
    let root = git_root(path)?;
    let files = detect_files(&root);
    let missing_executables = files
        .commands
        .all()
        .iter()
        .filter_map(|(_, command)| command.map(|c| c.executable.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|name| resolve_executable(name).is_none())
        .collect();
    Ok(RepoDetection {
        remote_url: git(&["remote", "get-url", "origin"], &root, GIT_TIMEOUT).ok(),
        default_branch: default_branch(&root),
        root: root.display().to_string(),
        files,
        missing_executables,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::testutil::TempDir;

    #[test]
    fn bun_repo_uses_frozen_install_and_package_scripts() {
        let dir = TempDir::new("bun");
        dir.write(
            "package.json",
            r#"{"packageManager":"bun@1.3.14","scripts":{"build":"tsc","test":"bun test","dev":"vite"}}"#,
        );
        dir.write("bun.lock", "{}");
        let detection = detect_files(dir.path());
        assert_eq!(detection.ecosystem.as_deref(), Some("bun"));
        assert_eq!(
            detection.commands.install,
            Some(spec("bun", &["install", "--frozen-lockfile"]))
        );
        assert_eq!(detection.commands.test, Some(spec("bun", &["run", "test"])));
        assert_eq!(detection.commands.dev, Some(spec("bun", &["run", "dev"])));
        assert_eq!(
            detection.commands.lint, None,
            "no lint script, no lint command"
        );
        assert!(detection.notes.is_empty(), "{:?}", detection.notes);
    }

    #[test]
    fn npm_lockfile_without_package_manager_uses_npm_ci() {
        let dir = TempDir::new("npm");
        dir.write(
            "package.json",
            r#"{"scripts":{"test":"jest","start":"node ."}}"#,
        );
        dir.write("package-lock.json", "{}");
        let detection = detect_files(dir.path());
        assert_eq!(detection.commands.install, Some(spec("npm", &["ci"])));
        assert_eq!(detection.commands.dev, Some(spec("npm", &["run", "start"])));
    }

    #[test]
    fn conflicting_lockfiles_are_reported() {
        let dir = TempDir::new("conflict");
        dir.write("package.json", r#"{"scripts":{"test":"x"}}"#);
        dir.write("package-lock.json", "{}");
        dir.write("yarn.lock", "");
        let detection = detect_files(dir.path());
        assert!(detection
            .notes
            .iter()
            .any(|note| note.contains("several lockfiles")));
    }

    #[test]
    fn compose_services_migrations_and_overrides_are_proposed() {
        let dir = TempDir::new("services");
        dir.write(
            "package.json",
            r#"{"scripts":{"test":"vitest","db:migrate":"prisma migrate deploy"}}"#,
        );
        dir.write("package-lock.json", "{}");
        dir.write(
            "docker-compose.yml",
            "services:\n  db:\n    image: postgres:16\n    ports: [\"5432:5432\"]\n",
        );
        dir.write(
            ".env.example",
            "DATABASE_URL=postgres://app:app@localhost:5432/app\n",
        );
        let detection = detect_files(dir.path());
        assert_eq!(detection.services[0].image, "postgres:16");
        assert_eq!(
            detection.commands.migrate,
            Some(spec("npm", &["run", "db:migrate"]))
        );
        assert_eq!(detection.env_overrides[0].key, "DATABASE_URL");
        assert!(detection.env_overrides[0]
            .value
            .contains("{services.db.port}"));

        let bare = TempDir::new("services-no-migrate");
        bare.write("go.mod", "module x");
        bare.write(
            "compose.yaml",
            "services:\n  cache:\n    image: redis\n    ports: [6379]\n",
        );
        let detection = detect_files(bare.path());
        assert!(detection.commands.migrate.is_none());
        assert!(detection
            .notes
            .iter()
            .any(|note| note.contains("no migration script found")));
    }

    #[test]
    fn go_and_unknown_repos() {
        let go = TempDir::new("go");
        go.write("go.mod", "module x");
        assert_eq!(
            detect_files(go.path()).commands.test,
            Some(spec("go", &["test", "./..."]))
        );

        let empty = TempDir::new("empty");
        let detection = detect_files(empty.path());
        assert_eq!(detection.commands, RepoCommands::default());
        assert!(detection
            .notes
            .iter()
            .any(|note| note.contains("no known manifest")));
    }

    #[test]
    fn env_example_reports_missing_and_service_keys_by_name_only() {
        let dir = TempDir::new("env");
        dir.write(
            ".env",
            "DATABASE_URL=postgres://secret@db/app\nAPI_KEY=abc\n",
        );
        dir.write(
            ".env.example",
            "# comment\nDATABASE_URL=\nAPI_KEY=\nREDIS_URL=\nexport PORT=3000\nFEATURE_FLAG=1\n",
        );
        let detection = detect_files(dir.path());
        assert_eq!(detection.env_files, vec![".env".to_string()]);
        assert_eq!(detection.env_example_file.as_deref(), Some(".env.example"));
        assert_eq!(
            detection.missing_env_keys,
            vec!["FEATURE_FLAG", "PORT", "REDIS_URL"]
        );
        assert_eq!(
            detection.service_env_keys,
            vec!["DATABASE_URL", "PORT", "REDIS_URL"]
        );
        let serialized = serde_json::to_string(&detection).unwrap();
        assert!(
            !serialized.contains("secret"),
            "env values must never leave the repo"
        );
    }

    #[test]
    fn detect_repo_requires_a_git_repository() {
        let dir = TempDir::new("not-git");
        let error = detect_repo(dir.path()).unwrap_err();
        assert!(error.contains("not inside a git repository"), "{error}");
    }

    #[test]
    fn detect_repo_reads_root_and_branch() {
        let dir = TempDir::new("git");
        dir.init_repo("trunk");
        dir.write("Cargo.toml", "[package]\nname='x'\n");
        let sub = dir.path().join("src");
        fs::create_dir_all(&sub).unwrap();
        let detection = detect_repo(&sub).unwrap();
        assert_eq!(
            fs::canonicalize(&detection.root).unwrap(),
            fs::canonicalize(dir.path()).unwrap()
        );
        assert_eq!(detection.default_branch, "trunk");
        assert_eq!(detection.files.ecosystem.as_deref(), Some("cargo"));
    }
}
