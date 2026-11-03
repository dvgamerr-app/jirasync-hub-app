// Repo bindings: which local repo a Jira project's tasks run in, and the commands the app
// executes there. Stored per machine in the app data folder, never in a repo, because they
// hold absolute paths.
use super::repo::{git_root, RepoCommands};
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
            Ok(file.bindings)
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
    let worktree_path = Path::new(worktree_root);
    if worktree_path.starts_with(&root) {
        return Err("worktree folder must be outside the repository".into());
    }
    binding.worktree_root = worktree_root.to_string();
    for (name, command) in binding.commands.all() {
        if let Some(command) = command {
            if command.executable.trim().is_empty() {
                return Err(format!("{name} command has no executable"));
            }
            if command
                .args
                .iter()
                .chain(std::iter::once(&command.executable))
                .any(|part| part.contains('\0'))
            {
                return Err(format!("{name} command contains an invalid character"));
            }
        }
    }
    for file in &binding.copy_env {
        if !is_safe_relative_path(file) {
            return Err(format!("\"{file}\" must be a path inside the repository"));
        }
    }
    binding.copy_env.sort();
    binding.copy_env.dedup();
    binding.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    Ok(binding)
}

pub fn save(path: &Path, binding: RepoBinding) -> Result<RepoBinding, String> {
    let binding = validate(binding)?;
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
    bindings.retain(|existing| existing.project_id != project_id);
    if bindings.len() != before {
        store(path, &bindings)?;
    }
    Ok(())
}

/// Default worktree folder: short and outside any repo (`<drive>:\wt` on Windows).
pub fn default_worktree_root(repo_path: &Path, home: Option<&Path>) -> String {
    if cfg!(windows) {
        if let Some(Component::Prefix(prefix)) = repo_path.components().next() {
            let drive = prefix.as_os_str().to_string_lossy();
            return format!("{drive}\\wt");
        }
    }
    home.map(|home| home.join(".jirasync").join("wt").display().to_string())
        .unwrap_or_else(|| "/tmp/jirasync-wt".into())
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
                }),
                ..RepoCommands::default()
            },
            copy_env: vec![".env".into(), ".env".into()],
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
        });
        assert!(save(&file, bad).unwrap_err().contains("no executable"));

        assert!(!file.exists(), "a rejected binding never creates the file");
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
