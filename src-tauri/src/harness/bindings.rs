// Repo bindings: which local repo a Jira project's tasks run in, and the commands the app
// executes there. Stored per machine in the app data folder, never in a repo, because they
// hold absolute paths.
use super::docker::{EnvVar, ServiceSpec};
use super::repo::{git_root, CommandSpec, RepoCommands};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoBinding {
    pub project_id: String,
    pub repo_path: String,
    pub base_branch: String,
    /// Where run worktrees are created. Must be short on Windows (MAX_PATH).
    pub worktree_root: String,
    pub commands: RepoCommands,
    /// Env files copied from the repo into each worktree (relative to the repo root).
    pub copy_env: Vec<String>,
    /// Containers started for each run while the agent implements (Docker Engine API).
    #[serde(default)]
    pub services: Vec<ServiceSpec>,
    /// Env values written into the worktree .env per run, e.g. `{services.db.port}`.
    #[serde(default)]
    pub env_overrides: Vec<EnvVar>,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
struct BindingsFile {
    version: u32,
    bindings: Vec<RepoBinding>,
}

const FILE_VERSION: u32 = 1;

pub fn load(path: &Path) -> Result<Vec<RepoBinding>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let file: BindingsFile = serde_json::from_str(&text)
                .map_err(|e| format!("{} is not a valid bindings file: {e}", path.display()))?;
            if file.version != FILE_VERSION {
                return Err(format!(
                    "{} has unsupported version {}",
                    path.display(),
                    file.version
                ));
            }
            Ok(file.bindings.into_iter().map(overlay_config).collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

fn store(path: &Path, bindings: &[RepoBinding]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&BindingsFile {
        version: FILE_VERSION,
        bindings: bindings.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    // Write then rename so a crash never leaves a half-written file.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

pub fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Shells and command interpreters: a command line handed to one of them is a shell the agent
/// was never given, so a command whose executable is one of these is refused.
const SHELLS: &[&str] = &[
    "powershell",
    "pwsh",
    "cmd",
    "bash",
    "sh",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "wsl",
    "env",
];

pub fn is_shell(executable: &str) -> bool {
    let name = executable.trim().to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    SHELLS.contains(&name)
}

pub fn is_valid_branch_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['-', '/'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("//")
        && !value.ends_with(".lock")
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

/// Checks a binding coming from the WebView and normalizes it before it is saved.
pub fn validate(mut binding: RepoBinding) -> Result<RepoBinding, String> {
    binding.project_id = binding.project_id.trim().to_string();
    if binding.project_id.is_empty() || binding.project_id.chars().any(char::is_control) {
        return Err("project is missing".into());
    }
    let root = git_root(Path::new(binding.repo_path.trim()))?;
    binding.repo_path = root.display().to_string();
    binding.base_branch = binding.base_branch.trim().to_string();
    if !is_valid_branch_name(&binding.base_branch) {
        return Err(format!(
            "\"{}\" is not a valid branch name",
            binding.base_branch
        ));
    }
    let worktree_root = binding.worktree_root.trim();
    if !Path::new(worktree_root).is_absolute() {
        return Err("worktree folder must be an absolute path".into());
    }
    // Compare real locations: git reports resolved paths (macOS /var -> /private/var, Windows
    // 8.3 short names), and the worktree folder may not exist yet.
    if resolved(Path::new(worktree_root)).starts_with(resolved(&root)) {
        return Err("worktree folder must be outside the repository".into());
    }
    binding.worktree_root = worktree_root.to_string();
    check_config(
        &binding.commands,
        &binding.copy_env,
        &binding.services,
        &binding.env_overrides,
    )?;
    binding.copy_env.sort();
    binding.copy_env.dedup();
    binding.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    Ok(binding)
}

/// One command and its `then` chain: an executable that is not a shell, no NUL bytes, valid
/// env keys, and a chain one level deep.
pub fn check_command(name: &str, command: &CommandSpec) -> Result<(), String> {
    for (index, part) in std::iter::once(command).chain(&command.then).enumerate() {
        let executable = part.executable.trim();
        if executable.is_empty() {
            return Err(format!("{name} command has no executable"));
        }
        if is_shell(executable) {
            return Err(format!(
                "{name}: {executable} is a shell; use the tool itself, `env` for variables and `then` for more commands"
            ));
        }
        if index > 0 && !part.then.is_empty() {
            return Err(format!(
                "{name}: a `then` command cannot have its own `then`"
            ));
        }
        if part
            .args
            .iter()
            .chain(std::iter::once(&part.executable))
            .chain(part.env.iter().map(|var| &var.value))
            .any(|text| text.contains('\0'))
        {
            return Err(format!("{name} command contains an invalid character"));
        }
        if part.env.iter().any(|var| !is_env_key(&var.key)) {
            return Err(format!("{name} command has an invalid env key"));
        }
    }
    Ok(())
}

fn check_config(
    commands: &RepoCommands,
    copy_env: &[String],
    services: &[ServiceSpec],
    overrides: &[EnvVar],
) -> Result<(), String> {
    for (name, command) in commands.all() {
        if let Some(command) = command {
            check_command(name, command)?;
        }
    }
    for file in copy_env {
        if !is_safe_relative_path(file) {
            return Err(format!("\"{file}\" must be a path inside the repository"));
        }
    }
    validate_services(services, overrides)
}

// ── Config file beside the worktrees ─────────────────────────────────────────────────────────
// What the AI worked out (commands, services, env) lives in `<worktree folder>/<project>.config.json`
// so it can be corrected by editing that file (by hand or by an AI) without the Setup form. It is
// read back every time bindings are loaded, so a fixed command is used by the next run.

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RunConfig {
    commands: RepoCommands,
    copy_env: Vec<String>,
    services: Vec<ServiceSpec>,
    env_overrides: Vec<EnvVar>,
}

pub fn config_path(binding: &RepoBinding) -> std::path::PathBuf {
    config_file(Path::new(&binding.worktree_root), &binding.project_id)
}

pub fn config_file(worktree_root: &Path, project_id: &str) -> std::path::PathBuf {
    let name: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    worktree_root.join(format!("{name}.config.json"))
}

/// Replaces one command in an existing config file, so a command the agent fixed is used by
/// later runs too. Returns false when there is no config file to update.
pub fn set_config_command(
    path: &Path,
    name: &str,
    command: Option<CommandSpec>,
) -> Result<bool, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(false);
    };
    let mut config: RunConfig = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a valid config file: {e}", path.display()))?;
    *config
        .commands
        .slot_mut(name)
        .ok_or_else(|| format!("unknown command \"{name}\""))? = command;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(true)
}

fn write_config(binding: &RepoBinding) -> Result<(), String> {
    let path = config_path(binding);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&RunConfig {
        commands: binding.commands.clone(),
        copy_env: binding.copy_env.clone(),
        services: binding.services.clone(),
        env_overrides: binding.env_overrides.clone(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The config file's values over the stored binding. A missing or invalid file changes nothing.
fn overlay_config(mut binding: RepoBinding) -> RepoBinding {
    let Ok(text) = fs::read_to_string(config_path(&binding)) else {
        return binding;
    };
    let Ok(config) = serde_json::from_str::<RunConfig>(&text) else {
        return binding;
    };
    if check_config(
        &config.commands,
        &config.copy_env,
        &config.services,
        &config.env_overrides,
    )
    .is_ok()
    {
        binding.commands = config.commands;
        binding.copy_env = config.copy_env;
        binding.services = config.services;
        binding.env_overrides = config.env_overrides;
    }
    binding
}

fn is_env_key(key: &str) -> bool {
    !key.is_empty()
        && !key.starts_with(|c: char| c.is_ascii_digit())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_services(services: &[ServiceSpec], overrides: &[EnvVar]) -> Result<(), String> {
    let mut names = std::collections::BTreeSet::new();
    for service in services {
        let name_ok = !service.name.is_empty()
            && service
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !name_ok {
            return Err(format!(
                "service name \"{}\" must use lowercase letters, digits, - or _",
                service.name
            ));
        }
        if !names.insert(service.name.as_str()) {
            return Err(format!("service \"{}\" is listed twice", service.name));
        }
        if service.image.trim().is_empty() || service.image.contains(char::is_whitespace) {
            return Err(format!("service \"{}\" needs an image", service.name));
        }
        if service.port == 0 {
            return Err(format!(
                "service \"{}\" needs the port it listens on",
                service.name
            ));
        }
        if service.env.iter().any(|var| !is_env_key(&var.key)) {
            return Err(format!(
                "service \"{}\" has an invalid env key",
                service.name
            ));
        }
    }
    for var in overrides {
        if !is_env_key(&var.key) || var.value.contains('\n') {
            return Err(format!("override \"{}\" is not a valid env entry", var.key));
        }
        let mut rest = var.value.as_str();
        while let Some(start) = rest.find("{services.") {
            let reference = &rest[start + "{services.".len()..];
            let name = reference.split('.').next().unwrap_or("");
            if !names.contains(name) {
                return Err(format!(
                    "override {} uses unknown service \"{name}\"",
                    var.key
                ));
            }
            rest = reference;
        }
    }
    Ok(())
}

/// `path` with its nearest existing ancestor canonicalized (symlinks and short names resolved).
fn resolved(path: &Path) -> std::path::PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
    let mut full = fs::canonicalize(existing).unwrap_or_else(|_| existing.to_path_buf());
    full.extend(rest.iter().rev());
    full
}

pub fn save(path: &Path, binding: RepoBinding) -> Result<RepoBinding, String> {
    let binding = validate(binding)?;
    write_config(&binding)?;
    let mut bindings = load(path)?;
    bindings.retain(|existing| existing.project_id != binding.project_id);
    bindings.push(binding.clone());
    bindings.sort_by(|a, b| a.project_id.cmp(&b.project_id));
    store(path, &bindings)?;
    Ok(binding)
}

pub fn delete(path: &Path, project_id: &str) -> Result<(), String> {
    let mut bindings = load(path)?;
    let before = bindings.len();
    if let Some(removed) = bindings.iter().find(|b| b.project_id == project_id) {
        let _ = fs::remove_file(config_path(removed));
    }
    bindings.retain(|existing| existing.project_id != project_id);
    if bindings.len() != before {
        store(path, &bindings)?;
    }
    Ok(())
}

/// Default worktree folder: inside the app's own data folder, so it is never in a repo.
pub fn default_worktree_root(app_data: &Path) -> String {
    app_data.join("worktrees").display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::repo::CommandSpec;
    use crate::harness::testutil::TempDir;

    fn binding(repo: &Path, worktrees: &Path) -> RepoBinding {
        RepoBinding {
            project_id: "proj-acc1-PRJ".into(),
            repo_path: repo.display().to_string(),
            base_branch: "main".into(),
            worktree_root: worktrees.display().to_string(),
            commands: RepoCommands {
                test: Some(CommandSpec {
                    executable: "bun".into(),
                    args: vec!["run".into(), "test".into()],
                    ..CommandSpec::default()
                }),
                ..RepoCommands::default()
            },
            copy_env: vec![".env".into(), ".env".into()],
            services: vec![],
            env_overrides: vec![],
            updated_at: 0,
        }
    }

    #[test]
    fn save_load_replace_and_delete() {
        let repo = TempDir::new("bind-repo");
        repo.init_repo("main");
        let worktrees = TempDir::new("bind-wt");
        let store_dir = TempDir::new("bind-store");
        let file = store_dir.path().join("harness").join("bindings.json");

        assert!(
            load(&file).unwrap().is_empty(),
            "missing file means no bindings"
        );
        let saved = save(&file, binding(repo.path(), worktrees.path())).unwrap();
        assert_eq!(
            saved.copy_env,
            vec![".env".to_string()],
            "duplicates removed"
        );
        assert!(saved.updated_at > 0);

        let mut changed = binding(repo.path(), worktrees.path());
        changed.base_branch = "develop".into();
        save(&file, changed).unwrap();
        let loaded = load(&file).unwrap();
        assert_eq!(loaded.len(), 1, "same project replaces, not duplicates");
        assert_eq!(loaded[0].base_branch, "develop");

        delete(&file, "proj-acc1-PRJ").unwrap();
        assert!(load(&file).unwrap().is_empty());
    }

    #[test]
    fn config_file_beside_the_worktrees_is_written_and_wins_when_edited() {
        let repo = TempDir::new("cfg-repo");
        repo.init_repo("main");
        let worktrees = TempDir::new("cfg-wt");
        let store_dir = TempDir::new("cfg-store");
        let file = store_dir.path().join("bindings.json");
        let saved = save(&file, binding(repo.path(), worktrees.path())).unwrap();

        let config = config_path(&saved);
        assert_eq!(config.parent().unwrap(), worktrees.path());
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.contains("\"test\""), "{text}");

        // Fixing the command in the file is what the next run uses.
        let edited = text.replace("\"run\"", "\"exec\"");
        fs::write(&config, edited).unwrap();
        let loaded = load(&file).unwrap();
        assert_eq!(loaded[0].commands.test.as_ref().unwrap().args[0], "exec");

        // A broken file is ignored instead of breaking every run.
        fs::write(&config, "{ not json").unwrap();
        assert_eq!(
            load(&file).unwrap()[0].commands.test.as_ref().unwrap().args[0],
            "run"
        );

        delete(&file, "proj-acc1-PRJ").unwrap();
        assert!(!config.exists(), "removing the binding removes its config");
    }

    #[test]
    fn rejects_invalid_bindings_without_writing() {
        let repo = TempDir::new("bind-bad");
        repo.init_repo("main");
        let worktrees = TempDir::new("bind-bad-wt");
        let store_dir = TempDir::new("bind-bad-store");
        let file = store_dir.path().join("bindings.json");

        let not_git = TempDir::new("bind-not-git");
        let mut bad = binding(not_git.path(), worktrees.path());
        assert!(save(&file, bad.clone())
            .unwrap_err()
            .contains("not inside a git repository"));

        bad = binding(repo.path(), worktrees.path());
        bad.base_branch = "main; rm -rf /".into();
        assert!(save(&file, bad)
            .unwrap_err()
            .contains("not a valid branch name"));

        bad = binding(repo.path(), worktrees.path());
        bad.copy_env = vec!["../secrets/.env".into()];
        assert!(save(&file, bad)
            .unwrap_err()
            .contains("inside the repository"));

        bad = binding(repo.path(), &repo.path().join("wt"));
        assert!(save(&file, bad)
            .unwrap_err()
            .contains("outside the repository"));

        bad = binding(repo.path(), worktrees.path());
        bad.commands.test = Some(CommandSpec {
            executable: " ".into(),
            args: vec![],
            ..CommandSpec::default()
        });
        assert!(save(&file, bad).unwrap_err().contains("no executable"));

        assert!(!file.exists(), "a rejected binding never creates the file");
    }

    #[test]
    fn services_and_overrides_are_checked_before_saving() {
        use crate::harness::docker::{EnvVar, ServiceSpec};
        let db = || ServiceSpec {
            name: "db".into(),
            image: "postgres:16".into(),
            port: 5432,
            ..ServiceSpec::default()
        };
        let var = |key: &str, value: &str| EnvVar {
            key: key.into(),
            value: value.into(),
        };
        assert!(validate_services(
            &[db()],
            &[var(
                "DATABASE_URL",
                "postgres://{services.db.host}:{services.db.port}/x"
            )]
        )
        .is_ok());
        let renamed = ServiceSpec {
            name: "DB main".into(),
            ..db()
        };
        let no_image = ServiceSpec {
            image: " ".into(),
            ..db()
        };
        let no_port = ServiceSpec { port: 0, ..db() };
        let bad_env = ServiceSpec {
            env: vec![var("1BAD", "x")],
            ..db()
        };
        for (services, reason) in [
            (vec![renamed], "name"),
            (vec![db(), db()], "listed twice"),
            (vec![no_image], "image"),
            (vec![no_port], "port"),
            (vec![bad_env], "env key"),
        ] {
            let error = validate_services(&services, &[]).unwrap_err();
            assert!(error.contains(reason), "{error}");
        }
        let unknown = validate_services(&[db()], &[var("REDIS_URL", "{services.cache.port}")]);
        assert!(unknown.unwrap_err().contains("unknown service \"cache\""));
        assert!(validate_services(&[], &[var("BAD KEY", "1")]).is_err());
        assert!(validate_services(&[], &[var("PORT", "1\nINJECT=1")]).is_err());
    }

    /// A worktree folder reached through another name for the repo (a symlink here; macOS
    /// /var -> /private/var and Windows short names behave the same) is still inside it.
    #[cfg(unix)]
    #[test]
    fn worktree_inside_the_repo_is_caught_through_a_symlink() {
        let repo = TempDir::new("bind-link-repo");
        repo.init_repo("main");
        let links = TempDir::new("bind-link");
        let alias = links.path().join("alias");
        std::os::unix::fs::symlink(repo.path(), &alias).unwrap();
        let store_dir = TempDir::new("bind-link-store");
        let bad = binding(repo.path(), &alias.join("wt"));
        let error = save(&store_dir.path().join("bindings.json"), bad).unwrap_err();
        assert!(error.contains("outside the repository"), "{error}");
    }

    #[test]
    fn branch_and_path_rules() {
        for good in ["main", "release/1.2", "feat_x-y"] {
            assert!(is_valid_branch_name(good), "{good}");
        }
        for bad in ["", "-x", "a..b", "a b", "x.lock", "a/", "feat:x"] {
            assert!(!is_valid_branch_name(bad), "{bad}");
        }
        assert!(is_safe_relative_path("apps/api/.env"));
        for bad in ["", "/etc/passwd", "../.env", "a/../../b"] {
            assert!(!is_safe_relative_path(bad), "{bad}");
        }
    }
}
