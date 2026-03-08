use serde::Serialize;
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
}

#[derive(Debug, Default, Clone)]
pub struct TaskExecutor;

impl TaskExecutor {
    pub fn new() -> Self {
        Self
    }

    /// Execute a command given as an array of strings (OpenClaw node protocol).
    /// e.g. ["bash", "-lc", "ls -la"] or ["uname", "-a"]
    pub fn execute_command(&self, parts: &[String]) -> Result<TaskExecutionOutput, String> {
        if parts.is_empty() {
            return Err("empty command".to_string());
        }

        let start = Instant::now();
        let output = Command::new(&parts[0])
            .args(&parts[1..])
            .output()
            .map_err(|err| format!("failed to run command: {err}"))?;

        Ok(TaskExecutionOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim_end().to_string(),
            duration_ms: start.elapsed().as_millis(),
        })
    }
}
