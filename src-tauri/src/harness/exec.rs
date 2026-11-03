// Process helpers for the harness. Commands are always an executable + argument list; nothing
// here goes through a shell, so ticket text or repo config can never become shell syntax.
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }

    pub fn first_line(&self) -> Option<String> {
        self.stdout
            .lines()
            .chain(self.stderr.lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
    }

    /// Short human-readable reason for a failed command.
    pub fn failure(&self) -> String {
        if self.timed_out {
            return "timed out".into();
        }
        let detail = self.stderr.trim();
        let detail = if detail.is_empty() {
            self.stdout.trim()
        } else {
            detail
        };
        let detail: String = detail.lines().take(3).collect::<Vec<_>>().join(" ");
        match self.code {
            Some(code) if detail.is_empty() => format!("exit code {code}"),
            Some(code) => format!("exit code {code}: {detail}"),
            None => "terminated".into(),
        }
    }
}

/// Finds an executable on PATH the way a shell would, including `.cmd`/`.bat` shims on
/// Windows (npm, pnpm, yarn), which `Command::new("npm")` alone cannot start.
pub fn resolve_executable(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    let extensions: Vec<String> = if cfg!(windows) {
        let has_extension = candidate.extension().is_some();
        let mut list: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_ascii_lowercase())
            .collect();
        if has_extension {
            list.insert(0, String::new());
        }
        list
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        extensions
            .iter()
            .map(|ext| dir.join(format!("{name}{ext}")))
            .find(|file| file.is_file())
    })
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Runs `program args` to completion (or until `timeout`) and captures its output.
pub fn run<S: AsRef<OsStr>>(
    program: &Path,
    args: &[S],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let out_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let err_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(15));
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(Output {
        code: if timed_out {
            None
        } else {
            status.and_then(|s| s.code())
        },
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    })
}

/// Runs git in `cwd`. Fails with git's own message when the command does not succeed.
pub fn git<S: AsRef<OsStr>>(args: &[S], cwd: &Path, timeout: Duration) -> Result<String, String> {
    let program = resolve_executable("git").ok_or("git is not installed or not on PATH")?;
    let output = run(&program, args, Some(cwd), timeout)?;
    if output.ok() {
        Ok(output.stdout.trim_end().to_string())
    } else {
        let shown: Vec<String> = args
            .iter()
            .map(|arg| arg.as_ref().to_string_lossy().into_owned())
            .collect();
        Err(format!(
            "git {} failed ({})",
            shown.join(" "),
            output.failure()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_git_from_path() {
        assert!(resolve_executable("git").is_some());
    }

    #[test]
    fn unknown_executable_is_not_resolved() {
        assert!(resolve_executable("definitely-not-a-real-tool-4f2a").is_none());
    }

    #[test]
    fn captures_output_and_exit_code() {
        let git_path = resolve_executable("git").unwrap();
        let output = run(&git_path, &["--version"], None, Duration::from_secs(10)).unwrap();
        assert!(output.ok());
        assert!(output.first_line().unwrap().starts_with("git version"));

        let failed = run(
            &git_path,
            &["definitely-not-a-git-command"],
            None,
            Duration::from_secs(10),
        )
        .unwrap();
        assert!(!failed.ok());
        assert!(failed.failure().starts_with("exit code"));
    }
}
