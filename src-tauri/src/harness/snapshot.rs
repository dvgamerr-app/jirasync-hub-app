// Git snapshot sync (Phase 6): keeps `jirasync-snapshot.json` in a git repo the owner picks,
// so another machine can pull it. Only that one file is written and committed (never the live
// database, credentials or run logs), and only content that parses as a snapshot. Git merge is
// not a lock, so syncing is refused while a run is working: finish or stop it first.
use super::exec::git;
use super::repo::git_root;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

pub const SNAPSHOT_FILE: &str = "jirasync-snapshot.json";
const MAX_SNAPSHOT_BYTES: usize = 10 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub committed: bool,
    pub pushed: bool,
}

fn refuse_while_busy(active_run: Option<&str>) -> Result<(), String> {
    match active_run {
        Some(run) => Err(format!(
            "run {run} is working; finish or stop it before syncing to another machine"
        )),
        None => Ok(()),
    }
}

fn has_upstream(root: &Path) -> bool {
    git(
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        root,
        GIT_TIMEOUT,
    )
    .is_ok()
}

/// Fast-forwards the folder from its upstream (if any) and returns the snapshot it holds.
pub fn pull(folder: &Path, active_run: Option<&str>) -> Result<Option<String>, String> {
    refuse_while_busy(active_run)?;
    let root = git_root(folder)?;
    if has_upstream(&root) {
        git(&["pull", "--ff-only", "--quiet"], &root, GIT_TIMEOUT)
            .map_err(|e| format!("could not fast-forward the sync folder: {e}"))?;
    }
    match fs::read_to_string(root.join(SNAPSHOT_FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Writes the snapshot, commits only that file when it changed, and pushes if there is an
/// upstream.
pub fn push(folder: &Path, content: &str, active_run: Option<&str>) -> Result<PushResult, String> {
    refuse_while_busy(active_run)?;
    if content.len() > MAX_SNAPSHOT_BYTES {
        return Err("the snapshot is too large".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|_| "the snapshot is not valid JSON")?;
    if value.get("format").and_then(|f| f.as_str()) != Some("jirasync-snapshot") {
        return Err("only a JiraSync snapshot can be written to the sync folder".into());
    }
    if content.contains("\"apiToken\"") {
        return Err("the snapshot must not contain credentials".into());
    }
    let root = git_root(folder)?;
    fs::write(root.join(SNAPSHOT_FILE), content).map_err(|e| e.to_string())?;
    git(&["add", "--", SNAPSHOT_FILE], &root, GIT_TIMEOUT)?;
    let staged = git(
        &["diff", "--cached", "--name-only", "--", SNAPSHOT_FILE],
        &root,
        GIT_TIMEOUT,
    )?;
    let committed = !staged.trim().is_empty();
    if committed {
        git(
            &[
                "commit",
                "--quiet",
                "-m",
                "chore(snapshot): update JiraSync snapshot",
                "--",
                SNAPSHOT_FILE,
            ],
            &root,
            GIT_TIMEOUT,
        )?;
    }
    let pushed = has_upstream(&root);
    if pushed {
        git(&["push", "--quiet"], &root, GIT_TIMEOUT)
            .map_err(|e| format!("committed but could not push: {e}"))?;
    }
    Ok(PushResult { committed, pushed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::testutil::{run_git, TempDir};

    const SNAPSHOT: &str =
        r#"{"format":"jirasync-snapshot","version":1,"accounts":[],"aiStates":[]}"#;

    /// A shared bare repo and two machines cloned from it.
    fn machines() -> (TempDir, TempDir, TempDir) {
        let shared = TempDir::new("snap-shared");
        run_git(shared.path(), &["init", "-q", "--bare", "-b", "main"]);
        let seed = TempDir::new("snap-seed");
        seed.init_repo("main");
        seed.write("README.md", "sync\n");
        seed.commit("chore: init");
        run_git(
            seed.path(),
            &[
                "remote",
                "add",
                "origin",
                &shared.path().display().to_string(),
            ],
        );
        run_git(seed.path(), &["push", "-q", "-u", "origin", "main"]);
        let clone = |name: &str| {
            let dir = TempDir::new(name);
            run_git(
                dir.path().parent().unwrap(),
                &[
                    "clone",
                    "-q",
                    &shared.path().display().to_string(),
                    &dir.path().display().to_string(),
                ],
            );
            run_git(dir.path(), &["config", "user.name", "test"]);
            run_git(
                dir.path(),
                &["config", "user.email", "test@example.invalid"],
            );
            dir
        };
        let (a, b) = (clone("snap-a"), clone("snap-b"));
        (shared, a, b)
    }

    #[test]
    fn one_machine_pushes_and_the_other_pulls() {
        let (_shared, a, b) = machines();
        assert_eq!(pull(b.path(), None).unwrap(), None, "nothing synced yet");
        a.write("unrelated.txt", "work in progress\n");
        run_git(a.path(), &["add", "unrelated.txt"]);

        let first = push(a.path(), SNAPSHOT, None).unwrap();
        assert_eq!(
            first,
            PushResult {
                committed: true,
                pushed: true
            }
        );
        let committed = run_git(a.path(), &["show", "--name-only", "--format=%s", "HEAD"]);
        assert_eq!(
            committed,
            format!("chore(snapshot): update JiraSync snapshot\n\n{SNAPSHOT_FILE}")
        );
        assert!(
            run_git(a.path(), &["diff", "--cached", "--name-only"]).contains("unrelated.txt"),
            "other staged files are left alone"
        );

        assert_eq!(pull(b.path(), None).unwrap().as_deref(), Some(SNAPSHOT));
        let again = push(a.path(), SNAPSHOT, None).unwrap();
        assert!(!again.committed, "no empty commit when nothing changed");
    }

    #[test]
    fn refuses_busy_runs_non_snapshots_and_credentials() {
        let (_shared, a, _b) = machines();
        assert!(push(a.path(), SNAPSHOT, Some("abc123"))
            .unwrap_err()
            .contains("is working"));
        assert!(pull(a.path(), Some("abc123")).is_err());
        assert!(push(a.path(), "{\"hello\":1}", None)
            .unwrap_err()
            .contains("only a JiraSync snapshot"));
        assert!(push(a.path(), "not json", None).is_err());
        let leaked = r#"{"format":"jirasync-snapshot","accounts":[{"apiToken":"x"}]}"#;
        assert!(push(a.path(), leaked, None)
            .unwrap_err()
            .contains("credentials"));
        assert!(
            !a.path().join(SNAPSHOT_FILE).exists(),
            "nothing written on refusal"
        );
        let plain = TempDir::new("snap-not-git");
        assert!(push(plain.path(), SNAPSHOT, None)
            .unwrap_err()
            .contains("not inside a git repository"));
    }

    #[test]
    fn a_folder_without_upstream_still_commits_locally() {
        let local = TempDir::new("snap-local");
        local.init_repo("main");
        local.write("README.md", "x\n");
        local.commit("chore: init");
        let result = push(local.path(), SNAPSHOT, None).unwrap();
        assert_eq!(
            result,
            PushResult {
                committed: true,
                pushed: false
            }
        );
        assert_eq!(pull(local.path(), None).unwrap().as_deref(), Some(SNAPSHOT));
    }
}
