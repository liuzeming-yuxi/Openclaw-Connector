# Browser CDP Expose Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let remote OpenClaw agents control the user's local browser by exposing Chrome's CDP port through an SSH reverse tunnel.

**Architecture:** The Connector launches Chrome with `--remote-debugging-port`, spawns a second SSH process with `-R` to reverse-forward the CDP port to the remote server, and provides a UI card for management. No CDP commands are proxied — third-party tools connect to the exposed endpoint directly.

**Tech Stack:** Rust (Tauri 2), React 19, TypeScript, SSH (`-R` reverse tunnel), Chrome DevTools Protocol

---

### Task 1: Add `browser.rs` — Chrome lifecycle manager

**Files:**
- Create: `apps/connector/src-tauri/src/browser.rs`

**Step 1: Create the module with types and constructor**

```rust
use std::process::{Child, Command};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub running: bool,
    pub cdp_port: u16,
    pub pid: Option<u32>,
}

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

    pub fn status(&mut self) -> BrowserStatus {
        // Check if child is still running
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child = None;
                }
                Ok(None) => {}
                Err(_) => {
                    self.child = None;
                }
            }
        }
        BrowserStatus {
            running: self.child.is_some(),
            cdp_port: self.cdp_port,
            pid: self.child.as_ref().map(|c| c.id()),
        }
    }
}
```

**Step 2: Add `find_chrome_binary` helper**

```rust
impl BrowserManager {
    fn find_chrome_binary() -> Result<String, String> {
        // macOS Chrome paths in preference order
        let candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }
        Err("Chrome not found. Install Google Chrome or set path manually.".to_string())
    }
}
```

**Step 3: Add `start` method**

```rust
impl BrowserManager {
    pub fn start(&mut self, cdp_port: u16) -> Result<BrowserStatus, String> {
        // If already running, return current status
        let s = self.status();
        if s.running {
            return Ok(s);
        }

        let chrome = Self::find_chrome_binary()?;
        self.cdp_port = cdp_port;

        // Kill anything on the CDP port first
        kill_port_holder(cdp_port);

        let child = Command::new(&chrome)
            .arg(format!("--remote-debugging-port={cdp_port}"))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .spawn()
            .map_err(|e| format!("failed to launch Chrome: {e}"))?;

        eprintln!("[browser] started Chrome (pid={}) on CDP port {cdp_port}", child.id());
        self.child = Some(child);

        // Give Chrome a moment to start, then verify
        std::thread::sleep(std::time::Duration::from_secs(2));

        Ok(self.status())
    }
}
```

**Step 4: Add `stop` method and port helper**

```rust
impl BrowserManager {
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            eprintln!("[browser] stopping Chrome (pid={})", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

/// Kill any process on the given port (reuse pattern from ssh_tunnel.rs).
fn kill_port_holder(port: u16) {
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
```

**Step 5: Verify it compiles**

Run: `cargo check`
Expected: PASS (module not yet wired into lib.rs, so this just checks syntax)

Actually, we need to register it first. Move to Task 2.

---

### Task 2: Add CDP reverse tunnel support to `ssh_tunnel.rs`

**Files:**
- Modify: `apps/connector/src-tauri/src/ssh_tunnel.rs`

**Step 1: Add `CdpTunnel` struct after `TunnelManager`**

Add after line 239 of `ssh_tunnel.rs`:

```rust
/// A separate SSH process for reverse-forwarding the CDP port.
#[derive(Debug, Default)]
pub struct CdpTunnel {
    child: Option<Child>,
    local_port: u16,
    remote_port: u16,
}

impl CdpTunnel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a reverse SSH tunnel: remote_port on server → local_port on Mac.
    pub fn start(
        &mut self,
        server: &ServerConfig,
        cdp_local_port: u16,
        cdp_remote_port: u16,
    ) -> Result<(), String> {
        // Stop any existing CDP tunnel
        self.stop();

        self.local_port = cdp_local_port;
        self.remote_port = cdp_remote_port;

        // Test mode
        if std::env::var("OPENCLAW_CONNECTOR_FAKE_TUNNEL").as_deref() == Ok("1") {
            return Ok(());
        }

        let key_path = if let Some(rest) = server.key_path.strip_prefix("~/") {
            match std::env::var("HOME") {
                Ok(home) => format!("{home}/{rest}"),
                Err(_) => server.key_path.clone(),
            }
        } else {
            server.key_path.clone()
        };

        let child = Command::new("ssh")
            .args([
                "-N",
                "-R", &format!("{cdp_remote_port}:127.0.0.1:{cdp_local_port}"),
                "-o", "ExitOnForwardFailure=yes",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=4",
                "-o", "ServerAliveInterval=20",
                "-o", "ServerAliveCountMax=1",
                "-o", "StrictHostKeyChecking=accept-new",
                "-i", &key_path,
                &format!("{}@{}", server.user, server.host),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn CDP SSH tunnel: {e}"))?;

        eprintln!(
            "[ssh_tunnel] CDP reverse tunnel started: remote:{cdp_remote_port} → local:{cdp_local_port}"
        );
        self.child = Some(child);

        // Wait briefly to detect early failures
        std::thread::sleep(Duration::from_secs(2));
        if let Some(ref mut c) = self.child {
            match c.try_wait() {
                Ok(Some(status)) => {
                    let mut stderr = String::new();
                    if let Some(mut pipe) = c.stderr.take() {
                        let _ = pipe.read_to_string(&mut stderr);
                    }
                    self.child = None;
                    return Err(format!("CDP tunnel exited early ({status}): {}", stderr.trim()));
                }
                Ok(None) => {} // still running, good
                Err(e) => {
                    self.child = None;
                    return Err(format!("CDP tunnel check failed: {e}"));
                }
            }
        }

        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            eprintln!("[ssh_tunnel] stopping CDP reverse tunnel");
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child = None;
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    self.child = None;
                    false
                }
            }
        } else {
            false
        }
    }
}
```

**Step 2: Verify compilation**

Run: `cargo check`
Expected: PASS

---

### Task 3: Add config fields and wire into `lib.rs`

**Files:**
- Modify: `apps/connector/src-tauri/src/config.rs`
- Modify: `apps/connector/src-tauri/src/lib.rs`

**Step 1: Add config fields to `config.rs`**

Add to `AppConfig` struct (after `node_name` field, around line 34):

```rust
    #[serde(default = "default_cdp_port")]
    pub cdp_port: u16,
    #[serde(default = "default_cdp_remote_port")]
    pub cdp_remote_port: u16,
```

Add default functions (after `default_node_name`, around line 43):

```rust
fn default_cdp_port() -> u16 {
    9222
}

fn default_cdp_remote_port() -> u16 {
    19222
}
```

Update `Default for AppConfig` (add after `node_name` default, around line 63):

```rust
            cdp_port: default_cdp_port(),
            cdp_remote_port: default_cdp_remote_port(),
```

**Step 2: Wire `browser.rs` into `lib.rs`**

Add module declaration at line 2 of `lib.rs`:

```rust
pub mod browser;
```

Add to `AppState` struct (after `rpc_tx` field, around line 22):

```rust
    browser: Mutex<browser::BrowserManager>,
    cdp_tunnel: Mutex<ssh_tunnel::CdpTunnel>,
```

Update `Default for AppState` (after `rpc_tx` default, around line 32):

```rust
            browser: Mutex::new(browser::BrowserManager::new()),
            cdp_tunnel: Mutex::new(ssh_tunnel::CdpTunnel::new()),
```

**Step 3: Add Tauri commands in `lib.rs`**

Add before `open_url` function:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStatusResponse {
    running: bool,
    cdp_port: u16,
    cdp_remote_port: u16,
    tunnel_running: bool,
    pid: Option<u32>,
}

#[tauri::command]
fn start_browser(
    state: tauri::State<'_, AppState>,
    cdp_port: Option<u16>,
    cdp_remote_port: Option<u16>,
) -> Result<BrowserStatusResponse, String> {
    let cdp_port = cdp_port.unwrap_or(9222);
    let cdp_remote_port = cdp_remote_port.unwrap_or(19222);

    // 1. Start Chrome
    let mut browser = state.browser.lock().map_err(|_| "browser lock error".to_string())?;
    browser.start(cdp_port)?;

    // 2. Start CDP reverse tunnel (requires active SSH connection for server config)
    let tunnel_mgr = state.tunnel.lock().map_err(|_| "tunnel lock error".to_string())?;
    let mut cdp_tunnel = state.cdp_tunnel.lock().map_err(|_| "cdp tunnel lock error".to_string())?;

    // Get server config from the active tunnel
    if let Some(server) = tunnel_mgr.active_server() {
        cdp_tunnel.start(&server, cdp_port, cdp_remote_port)?;
    } else {
        eprintln!("[browser] no active SSH connection, skipping CDP tunnel");
    }

    let bs = browser.status();
    Ok(BrowserStatusResponse {
        running: bs.running,
        cdp_port: bs.cdp_port,
        cdp_remote_port,
        tunnel_running: cdp_tunnel.is_running(),
        pid: bs.pid,
    })
}

#[tauri::command]
fn stop_browser(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut cdp_tunnel = state.cdp_tunnel.lock().map_err(|_| "cdp tunnel lock error".to_string())?;
    cdp_tunnel.stop();

    let mut browser = state.browser.lock().map_err(|_| "browser lock error".to_string())?;
    browser.stop()
}

#[tauri::command]
fn get_browser_status(state: tauri::State<'_, AppState>) -> Result<BrowserStatusResponse, String> {
    let mut browser = state.browser.lock().map_err(|_| "browser lock error".to_string())?;
    let mut cdp_tunnel = state.cdp_tunnel.lock().map_err(|_| "cdp tunnel lock error".to_string())?;
    let bs = browser.status();
    Ok(BrowserStatusResponse {
        running: bs.running,
        cdp_port: bs.cdp_port,
        cdp_remote_port: 0, // Will be set from config in frontend
        tunnel_running: cdp_tunnel.is_running(),
        pid: bs.pid,
    })
}
```

**Step 4: Expose `active_server` on TunnelManager**

Add to `ssh_tunnel.rs` in `impl TunnelManager` (after `is_connected`, around line 155):

```rust
    pub fn active_server(&self) -> Option<ServerConfig> {
        self.active_server.clone()
    }
```

**Step 5: Register commands**

Add to `generate_handler!` in `lib.rs` `run()`:

```rust
            start_browser,
            stop_browser,
            get_browser_status,
```

**Step 6: Stop browser on disconnect**

Add to the `disconnect` command in `lib.rs` (before stopping SSH tunnel, around line 215):

```rust
    // Stop CDP tunnel and browser
    if let Ok(mut cdp_tunnel) = state.cdp_tunnel.lock() {
        cdp_tunnel.stop();
    }
    if let Ok(mut browser) = state.browser.lock() {
        let _ = browser.stop();
    }
```

**Step 7: Verify compilation**

Run: `cargo check`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/connector/src-tauri/src/browser.rs apps/connector/src-tauri/src/ssh_tunnel.rs apps/connector/src-tauri/src/config.rs apps/connector/src-tauri/src/lib.rs
git commit -m "feat: add browser CDP manager and reverse tunnel support"
```

---

### Task 4: Add TypeScript config fields

**Files:**
- Modify: `apps/connector/src/types/config.ts`

**Step 1: Add fields to ConnectorConfig interface**

Add after `nodeName: string;` (line 20):

```typescript
  cdpPort: number;
  cdpRemotePort: number;
```

**Step 2: Add defaults to createDefaultConfig**

Add after `nodeName` default (line 39):

```typescript
    cdpPort: 9222,
    cdpRemotePort: 19222
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

---

### Task 5: Add Browser card to ConnectionPage UI

**Files:**
- Modify: `apps/connector/src/pages/ConnectionPage.tsx`

**Step 1: Add state variables**

Add after existing state declarations (around line 61):

```typescript
  const [browserRunning, setBrowserRunning] = useState(false);
  const [browserTunnelRunning, setBrowserTunnelRunning] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [cdpPort, setCdpPort] = useState(config.cdpPort);
  const [cdpRemotePort, setCdpRemotePort] = useState(config.cdpRemotePort);
```

**Step 2: Add browser status type and polling**

Add type near the top (after `ChatMessage`):

```typescript
type BrowserStatusResponse = {
  running: boolean;
  cdpPort: number;
  cdpRemotePort: number;
  tunnelRunning: boolean;
  pid: number | null;
};
```

Add polling effect after the connection status polling effect:

```typescript
  // Poll browser status
  useEffect(() => {
    if (!fullyConnected) return;
    const poll = async () => {
      try {
        const s = await invoke<BrowserStatusResponse>("get_browser_status");
        setBrowserRunning(s.running);
        setBrowserTunnelRunning(s.tunnelRunning);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [fullyConnected]);
```

**Step 3: Add start/stop handlers**

Add after `openGateway` handler:

```typescript
  const startBrowser = async () => {
    setBrowserBusy(true);
    try {
      const result = await invoke<BrowserStatusResponse>("start_browser", {
        cdpPort,
        cdpRemotePort,
      });
      setBrowserRunning(result.running);
      setBrowserTunnelRunning(result.tunnelRunning);
      pushActivity("info", `Chrome 已启动，CDP 端口 ${cdpPort}，远程映射 ${cdpRemotePort}`);
      patchConfig({ cdpPort, cdpRemotePort });
      await invoke("save_app_config", {
        cfg: { ...config, cdpPort, cdpRemotePort },
      }).catch(() => {});
    } catch (err) {
      pushActivity("error", `启动浏览器失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBrowserBusy(false);
    }
  };

  const stopBrowser = async () => {
    setBrowserBusy(true);
    try {
      await invoke("stop_browser");
      setBrowserRunning(false);
      setBrowserTunnelRunning(false);
      pushActivity("info", "Chrome 已停止");
    } catch (err) {
      pushActivity("error", `停止浏览器失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBrowserBusy(false);
    }
  };
```

**Step 4: Add Browser card JSX**

Insert between the Session 管理 card closing `</section>` and the Activity Log card `<section>`:

```tsx
      {/* ── Browser CDP ── */}
      {fullyConnected && (
        <section className="card">
          <div className="card-header">
            <h2>浏览器</h2>
            <div className="status-chip">
              <span className={browserRunning && browserTunnelRunning ? "status-dot online" : browserRunning ? "status-dot pending" : "status-dot offline"} />
              {browserRunning && browserTunnelRunning
                ? "Chrome + 隧道就绪"
                : browserRunning
                  ? "Chrome 运行中，隧道未连接"
                  : "未启动"}
            </div>
          </div>

          <div className="form-grid two-col">
            <label>
              CDP 端口 (本地)
              <input
                type="number"
                value={cdpPort}
                onChange={(e) => setCdpPort(Number(e.target.value) || 9222)}
                disabled={browserRunning}
              />
            </label>
            <label>
              远程映射端口
              <input
                type="number"
                value={cdpRemotePort}
                onChange={(e) => setCdpRemotePort(Number(e.target.value) || 19222)}
                disabled={browserRunning}
              />
            </label>
          </div>

          <div className="button-row">
            {!browserRunning ? (
              <button type="button" className="btn btn-primary" onClick={startBrowser} disabled={browserBusy}>
                {browserBusy ? "启动中..." : "启动 Chrome"}
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={stopBrowser} disabled={browserBusy}>
                {browserBusy ? "停止中..." : "停止 Chrome"}
              </button>
            )}
          </div>

          {browserRunning && browserTunnelRunning && (
            <p className="hint">
              远程 Agent 可通过 localhost:{cdpRemotePort} 连接 CDP。
            </p>
          )}
        </section>
      )}
```

**Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/connector/src/types/config.ts apps/connector/src/pages/ConnectionPage.tsx
git commit -m "feat: add browser CDP management UI"
```

---

### Task 6: Manual integration test

**Steps:**
1. Run `pnpm tauri dev` in `apps/connector/`
2. Connect to SSH server (fill in host/user/key, click 连接)
3. Wait for "SSH + WebSocket 已连接"
4. Scroll to "浏览器" card
5. Click "启动 Chrome" — Chrome should open, status shows "Chrome + 隧道就绪"
6. On the remote server, run: `curl http://localhost:19222/json/version` — should return Chrome version JSON
7. Click "停止 Chrome" — Chrome closes, status shows "未启动"
8. Click "断开" — verify no orphaned processes (`lsof -ti :9222` should be empty)

---
