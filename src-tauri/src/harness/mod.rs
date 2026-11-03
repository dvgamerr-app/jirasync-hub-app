// Harness core: the native side of "run a coding agent on a Jira task". The WebView only gets
// typed commands with validated inputs; it can never ask for an arbitrary command line.
mod agent;
mod bindings;
mod claude;
mod codex;
mod docker;
mod doctor;
mod exec;
mod mcp;
mod repo;
mod run;
#[cfg(test)]
mod testutil;
mod tools;
mod worktree;

use std::path::{Path, PathBuf};
use tauri::Manager;

pub use bindings::RepoBinding;
pub use doctor::DoctorReport;
pub use repo::RepoDetection;

fn bindings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("harness").join("bindings.json"))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn harness_doctor() -> Result<DoctorReport, String> {
    blocking(|| Ok(doctor::run_doctor())).await
}

#[tauri::command]
pub async fn harness_detect_repo(path: String) -> Result<RepoDetection, String> {
    blocking(move || repo::detect_repo(Path::new(path.trim()))).await
}

#[tauri::command]
pub fn harness_default_worktree_root(app: tauri::AppHandle, repo_path: String) -> String {
    let home = app.path().home_dir().ok();
    bindings::default_worktree_root(Path::new(&repo_path), home.as_deref())
}

#[tauri::command]
pub async fn harness_list_bindings(app: tauri::AppHandle) -> Result<Vec<RepoBinding>, String> {
    let file = bindings_file(&app)?;
    blocking(move || bindings::load(&file)).await
}

#[tauri::command]
pub async fn harness_save_binding(
    app: tauri::AppHandle,
    binding: RepoBinding,
) -> Result<RepoBinding, String> {
    let file = bindings_file(&app)?;
    blocking(move || bindings::save(&file, binding)).await
}

#[tauri::command]
pub async fn harness_delete_binding(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), String> {
    let file = bindings_file(&app)?;
    blocking(move || bindings::delete(&file, &project_id)).await
}

pub use run::{RunEvent, RunManager, RunRecord};

/// Event the WebView listens to for live run output; the journal on disk is the source of truth.
pub const RUN_EVENT: &str = "harness://run-event";

pub fn create_run_manager(app: &tauri::AppHandle) -> Result<RunManager, String> {
    use tauri::Emitter;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("harness")
        .join("runs");
    let handle = app.clone();
    // Skills ship with the app (bundle resources); a dev build reads them from the source tree.
    let bundled = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("resources").join("harness-skills"))
        .ok()
        .filter(|dir| dir.is_dir());
    let skills_dir = bundled
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/harness-skills"));
    let agent = agent::AgentEnv::new(
        claude::AgentLauncher::claude(PathBuf::from("claude")),
        skills_dir,
        std::time::Duration::from_secs(AGENT_BUDGET_MINUTES * 60),
    );
    Ok(RunManager::new(
        root,
        std::sync::Arc::new(move |event: &RunEvent| {
            let _ = handle.emit(RUN_EVENT, event);
        }),
    )
    .with_agent(agent))
}

/// Agent working time per owner-approved step (time the app spends executing is excluded).
const AGENT_BUDGET_MINUTES: u64 = 30;

/// Starts a run for a task: worktree from the latest origin base, env files, install, then
/// (with `context`) a coding agent that plans first and waits for the owner.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn harness_start_run(
    app: tauri::AppHandle,
    runs: tauri::State<'_, RunManager>,
    task_id: String,
    project_id: String,
    issue_key: String,
    context: Option<String>,
    jira_url: Option<String>,
    provider: Option<String>,
) -> Result<RunRecord, String> {
    let provider = provider.unwrap_or_else(|| "claude".into());
    if !["claude", "codex"].contains(&provider.as_str()) {
        return Err(format!("unknown coding agent \"{provider}\""));
    }
    let file = bindings_file(&app)?;
    let manager = runs.inner().clone();
    blocking(move || {
        let binding = bindings::load(&file)?
            .into_iter()
            .find(|binding| binding.project_id == project_id)
            .ok_or("bind this project to a repository in Setup first")?;
        manager.start(run::StartRun {
            task_id,
            issue_key,
            binding,
            agent: None,
            jira_url,
            provider,
            context,
        })
    })
    .await
}

/// CI checks of an accepted run's Draft PR (`gh pr checks`).
#[tauri::command]
pub async fn harness_pr_checks(
    runs: tauri::State<'_, RunManager>,
    run_id: String,
) -> Result<agent::CiStatus, String> {
    let manager = runs.inner().clone();
    blocking(move || manager.pr_checks(&run_id)).await
}

/// Draft → ready for review; refused unless every CI check passed.
#[tauri::command]
pub async fn harness_mark_pr_ready(
    runs: tauri::State<'_, RunManager>,
    run_id: String,
) -> Result<RunRecord, String> {
    let manager = runs.inner().clone();
    blocking(move || manager.mark_pr_ready(&run_id)).await
}

/// The owner decision at a gate: approve or revise the plan, accept or ask for changes.
#[tauri::command]
pub async fn harness_resume_run(
    runs: tauri::State<'_, RunManager>,
    run_id: String,
    decision: String,
    feedback: Option<String>,
) -> Result<RunRecord, String> {
    let manager = runs.inner().clone();
    let feedback = feedback.unwrap_or_default();
    let decision = match decision.as_str() {
        "approve_plan" => run::Decision::ApprovePlan,
        "revise_plan" => run::Decision::RevisePlan(feedback),
        "request_changes" => run::Decision::RequestChanges(feedback),
        "accept" => run::Decision::Accept,
        other => return Err(format!("unknown decision {other}")),
    };
    blocking(move || manager.resume(&run_id, decision)).await
}

#[tauri::command]
pub fn harness_stop_run(runs: tauri::State<'_, RunManager>, run_id: String) -> Result<(), String> {
    let manager = runs.inner().clone();
    // Killing a process tree can take a moment; never block the UI thread on it.
    std::thread::spawn(move || {
        let _ = manager.stop(&run_id);
    });
    Ok(())
}

#[tauri::command]
pub async fn harness_list_runs(
    runs: tauri::State<'_, RunManager>,
) -> Result<Vec<RunRecord>, String> {
    let manager = runs.inner().clone();
    blocking(move || Ok(manager.list(100))).await
}

#[tauri::command]
pub async fn harness_run_events(
    runs: tauri::State<'_, RunManager>,
    run_id: String,
    after_seq: u64,
    limit: Option<usize>,
) -> Result<Vec<RunEvent>, String> {
    let manager = runs.inner().clone();
    blocking(move || manager.events(&run_id, after_seq, limit.unwrap_or(2000).min(5000))).await
}

#[tauri::command]
pub async fn harness_remove_run_worktree(
    runs: tauri::State<'_, RunManager>,
    run_id: String,
    discard_changes: bool,
) -> Result<RunRecord, String> {
    let manager = runs.inner().clone();
    blocking(move || manager.remove_worktree(&run_id, discard_changes)).await
}
