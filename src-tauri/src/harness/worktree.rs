// Worktrees: one per run, created from the latest `origin/<base>`, on a branch named from
// validated IDs only. The dev's own checkout is never touched (no stash, reset or checkout).
use super::bindings::is_safe_relative_path;
use super::exec::git;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(180);
const GIT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base_sha: String,
    pub copied_env: Vec<String>,
    /// Env files listed in the binding that do not exist in the repo.
    pub missing_env: Vec<String>,
}

pub fn is_valid_issue_key(key: &str) -> bool {
    let Some((project, number)) = key.split_once('-') else {
        return false;
    };
    project.len() >= 2
        && project.starts_with(|c: char| c.is_ascii_uppercase())
        && project
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

pub fn is_valid_run_id(id: &str) -> bool {
    (6..=32).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

pub struct CreateWorktree<'a> {
    pub repo: &'a Path,
    pub base_branch: &'a str,
    pub worktree_root: &'a Path,
    pub issue_key: &'a str,
    pub run_id: &'a str,
    pub copy_env: &'a [String],
}

pub fn create(request: CreateWorktree) -> Result<WorktreeInfo, String> {
    if !is_valid_issue_key(request.issue_key) {
        return Err(format!("\"{}\" is not a Jira issue key", request.issue_key));
    }
    if !is_valid_run_id(request.run_id) {
        return Err("invalid run id".into());
    }
    let remote_ref = format!("refs/remotes/origin/{}", request.base_branch);
    git(
        &[
            "fetch",
            "origin",
            &format!("+refs/heads/{}:{remote_ref}", request.base_branch),
        ],
        request.repo,
        FETCH_TIMEOUT,
    )?;
    let base_sha = git(
        &["rev-parse", "--verify", &format!("{remote_ref}^{{commit}}")],
        request.repo,
        GIT_TIMEOUT,
    )?;

    let branch = format!("ai/{}-{}", request.issue_key, request.run_id);
    let path: PathBuf = request.worktree_root.join(request.run_id);
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    fs::create_dir_all(request.worktree_root)
        .map_err(|e| format!("could not create {}: {e}", request.worktree_root.display()))?;
    let path_arg = path.display().to_string();
    git(
        &[
            "-c",
            "core.longpaths=true",
            "worktree",
            "add",
            "-b",
            &branch,
            &path_arg,
            &base_sha,
        ],
        request.repo,
        GIT_TIMEOUT,
    )?;

    let mut copied_env = Vec::new();
    let mut missing_env = Vec::new();
    for file in request.copy_env {
        if !is_safe_relative_path(file) {
            return Err(format!("\"{file}\" must be a path inside the repository"));
        }
        let source = request.repo.join(file);
        if !source.is_file() {
            missing_env.push(file.clone());
            continue;
        }
        let target = path.join(file);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&source, &target).map_err(|e| format!("could not copy {file}: {e}"))?;
        copied_env.push(file.clone());
    }

    Ok(WorktreeInfo {
        path: path_arg,
        branch,
        base_sha,
        copied_env,
        missing_env,
    })
}

/// Tracked or untracked changes that `git worktree remove --force` would destroy.
pub fn uncommitted_changes(worktree: &Path) -> Result<Vec<String>, String> {
    let status = git(&["status", "--porcelain"], worktree, GIT_TIMEOUT)?;
    Ok(status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect())
}

/// Removes a run worktree. Ignored files (installed deps, copied `.env`) go with it; real
/// changes block removal unless the owner confirmed `discard_changes`.
pub fn remove(repo: &Path, worktree: &Path, discard_changes: bool) -> Result<(), String> {
    if !discard_changes {
        let changes = uncommitted_changes(worktree)?;
        if !changes.is_empty() {
            return Err(format!(
                "worktree has {} uncommitted change(s); confirm to discard them",
                changes.len()
            ));
        }
    }
    let path_arg = worktree.display().to_string();
    git(
        &[
            "-c",
            "core.longpaths=true",
            "worktree",
            "remove",
            "--force",
            &path_arg,
        ],
        repo,
        GIT_TIMEOUT,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::testutil::{run_git, TempDir};

    /// An "upstream" repo with one commit and a clone of it, like a dev's checkout.
    fn checkout() -> (TempDir, TempDir) {
        let upstream = TempDir::new("wt-upstream");
        upstream.init_repo("main");
        upstream.write(".gitignore", ".env\nnode_modules/\n");
        upstream.write("README.md", "hello\n");
        upstream.commit("chore: init");
        let clone = TempDir::new("wt-clone");
        run_git(
            clone.path().parent().unwrap(),
            &[
                "clone",
                "-q",
                &upstream.path().display().to_string(),
                &clone.path().display().to_string(),
            ],
        );
        (upstream, clone)
    }

    #[test]
    fn creates_from_latest_origin_and_copies_env() {
        let (upstream, clone) = checkout();
        clone.write(".env", "DATABASE_URL=postgres://local\n");
        clone.write("README.md", "local work in progress\n");
        // Upstream moves ahead after the clone: the run must start from it.
        upstream.write("NEW.md", "new\n");
        upstream.commit("feat: newer");
        let upstream_head = run_git(upstream.path(), &["rev-parse", "HEAD"]);

        let root = TempDir::new("wt-root");
        let info = create(CreateWorktree {
            repo: clone.path(),
            base_branch: "main",
            worktree_root: root.path(),
            issue_key: "PRJ-12",
            run_id: "abc123",
            copy_env: &[".env".into(), ".env.local".into()],
        })
        .unwrap();

        assert_eq!(info.base_sha, upstream_head);
        assert_eq!(info.branch, "ai/PRJ-12-abc123");
        assert_eq!(info.copied_env, vec![".env".to_string()]);
        assert_eq!(info.missing_env, vec![".env.local".to_string()]);
        let worktree = Path::new(&info.path);
        assert!(
            worktree.join("NEW.md").exists(),
            "started from origin, not local main"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("README.md"))
                .unwrap()
                .trim(),
            "hello",
            "local WIP is not carried over"
        );
        assert!(fs::read_to_string(worktree.join(".env"))
            .unwrap()
            .contains("postgres"));
        assert_eq!(
            fs::read_to_string(clone.path().join("README.md")).unwrap(),
            "local work in progress\n",
            "dev checkout untouched"
        );
        assert!(
            uncommitted_changes(worktree).unwrap().is_empty(),
            ".env is ignored"
        );

        remove(clone.path(), worktree, false).unwrap();
        assert!(!worktree.exists());
    }

    #[test]
    fn rejects_bad_ids_before_touching_git() {
        let (_upstream, clone) = checkout();
        let root = TempDir::new("wt-bad");
        for (key, run) in [
            ("prj-1", "abc123"),
            ("PRJ-1; rm", "abc123"),
            ("PRJ-1", "../x"),
        ] {
            let error = create(CreateWorktree {
                repo: clone.path(),
                base_branch: "main",
                worktree_root: root.path(),
                issue_key: key,
                run_id: run,
                copy_env: &[],
            })
            .unwrap_err();
            assert!(
                error.contains("issue key") || error.contains("run id"),
                "{error}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn missing_base_branch_fails() {
        let (_upstream, clone) = checkout();
        let root = TempDir::new("wt-nobranch");
        let error = create(CreateWorktree {
            repo: clone.path(),
            base_branch: "does-not-exist",
            worktree_root: root.path(),
            issue_key: "PRJ-1",
            run_id: "abc123",
            copy_env: &[],
        })
        .unwrap_err();
        assert!(error.contains("git fetch"), "{error}");
    }

    #[test]
    fn remove_keeps_uncommitted_work_unless_confirmed() {
        let (_upstream, clone) = checkout();
        let root = TempDir::new("wt-dirty");
        let info = create(CreateWorktree {
            repo: clone.path(),
            base_branch: "main",
            worktree_root: root.path(),
            issue_key: "PRJ-2",
            run_id: "def456",
            copy_env: &[],
        })
        .unwrap();
        let worktree = Path::new(&info.path);
        fs::write(worktree.join("README.md"), "agent change\n").unwrap();

        let error = remove(clone.path(), worktree, false).unwrap_err();
        assert!(error.contains("uncommitted"), "{error}");
        assert!(worktree.join("README.md").exists(), "work kept");

        remove(clone.path(), worktree, true).unwrap();
        assert!(!worktree.exists());
    }
}
