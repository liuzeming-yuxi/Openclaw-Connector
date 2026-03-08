use serde::Serialize;
use std::process::{Child, Command};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub running: bool,
    pub cdp_port: u16,
    pub pid: Option<u32>,
}

#[derive(Debug)]
pub struct BrowserManager {
    child: Option<Child>,
    cdp_port: u16,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            child: None,
            cdp_port: 9222,
        }
    }

    /// Locate a Chrome-compatible binary on macOS.
    /// Checks Google Chrome, Chrome Canary, Chromium, and Microsoft Edge.
    pub fn find_chrome_binary() -> Result<String, String> {
        let candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];

        for path in &candidates {
            if std::path::Path::new(path).exists() {
                eprintln!("[browser] found chrome binary: {path}");
                return Ok(path.to_string());
            }
        }

        Err("no Chrome-compatible browser found on this system".to_string())
    }

    /// Start a Chrome instance with remote debugging enabled on the given CDP port.
    /// Uses a dedicated `user_data_dir` so Chrome runs as an independent instance
    /// (avoids merging into an already-running Chrome which would discard the CDP flag).
    pub fn start(&mut self, cdp_port: u16, user_data_dir: &std::path::Path) -> Result<BrowserStatus, String> {
        // Stop any previously managed child first.
        if self.child.is_some() {
            let _ = self.stop();
        }

        // Kill any orphaned process holding the CDP port.
        kill_port_holder(cdp_port);

        let binary = Self::find_chrome_binary()?;
        self.cdp_port = cdp_port;
        let _ = std::fs::create_dir_all(user_data_dir);

        eprintln!("[browser] starting chrome on CDP port {cdp_port}, data dir: {}", user_data_dir.display());

        let child = Command::new(&binary)
            .args([
                &format!("--remote-debugging-port={cdp_port}"),
                &format!("--user-data-dir={}", user_data_dir.display()),
                "--no-first-run",
                "--no-default-browser-check",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|err| {
                let msg = format!("failed to spawn chrome: {err}");
                eprintln!("[browser] {msg}");
                msg
            })?;

        let pid = child.id();
        eprintln!("[browser] chrome spawned with pid {pid}");

        self.child = Some(child);

        // Give Chrome time to initialise the CDP server.
        std::thread::sleep(Duration::from_secs(2));

        Ok(self.status())
    }

    /// Stop Chrome. Kills the tracked child AND any process on the CDP port,
    /// because Chrome often re-execs to a new PID after profile selection.
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            eprintln!("[browser] killing chrome pid {}", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        // Also kill whatever is on the CDP port (handles re-exec case)
        kill_port_holder(self.cdp_port);
        Ok(())
    }

    /// Check whether Chrome is running by probing the CDP port.
    /// Chrome may restart its process (e.g. after profile selection), so we
    /// cannot rely on the child PID alone.
    pub fn status(&mut self) -> BrowserStatus {
        // Clean up child handle if process exited (normal — Chrome often re-execs)
        if let Some(child) = self.child.as_mut() {
            if let Ok(Some(_)) = child.try_wait() {
                self.child = None;
            }
        }

        let running = is_cdp_listening(self.cdp_port);
        let pid = self.child.as_ref().map(|c| c.id());

        BrowserStatus {
            running,
            cdp_port: self.cdp_port,
            pid,
        }
    }
}

/// Check if something is listening on the CDP port by attempting a TCP connection.
fn is_cdp_listening(port: u16) -> bool {
    use std::net::TcpStream;
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Kill any process currently listening on the given port.
/// Uses `lsof` to discover PIDs, same approach as `ssh_tunnel::kill_port_holder`.
pub fn kill_port_holder(port: u16) {
    let output = Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output();
    if let Ok(out) = output {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid_str in pids.split_whitespace() {
            if pid_str.parse::<u32>().is_ok() {
                eprintln!("[browser] killing process {pid_str} on port {port}");
                let _ = Command::new("kill").arg(pid_str).output();
            }
        }
    }
}
