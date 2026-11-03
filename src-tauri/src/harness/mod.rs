// Harness core: the native side of "run a coding agent on a Jira task". The WebView only gets
// typed commands with validated inputs; it can never ask for an arbitrary command line.
mod bindings;
mod doctor;
mod exec;
mod repo;
#[cfg(test)]
mod testutil;
// Used by the run manager in the next phase; exercised by its unit tests now.
#[allow(dead_code)]
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
