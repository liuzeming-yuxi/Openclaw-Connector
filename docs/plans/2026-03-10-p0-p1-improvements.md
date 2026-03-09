# P0/P1 Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add PR-level CI, fix unsafe port killing, implement WebSocket graceful shutdown, and unify config to backend-only source of truth.

**Architecture:** Four independent improvements. Task 1 is CI-only (GitHub Actions + ESLint config). Tasks 2-3 are Rust backend changes. Task 4 spans frontend store and backend config loading.

**Tech Stack:** GitHub Actions, ESLint 9 (flat config), typescript-eslint, cargo clippy, Tokio, tungstenite, Zustand 5

---

### Task 1: PR-level CI checks

**Files:**
- Create: `.github/workflows/check.yml`
- Create: `eslint.config.js`
- Modify: `package.json` (add eslint devDependencies + lint script)

**Step 1: Install ESLint dependencies**

Run:
```bash
pnpm add -D eslint @eslint/js typescript-eslint
```

**Step 2: Create ESLint flat config**

Create `eslint.config.js`:

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "src-tauri/"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
```

**Step 3: Add lint script to package.json**

Add to `"scripts"`:
```json
"lint": "eslint src/"
```

**Step 4: Run eslint locally to verify it works**

Run: `pnpm lint`
Expected: Runs without config errors. May have warnings — that's OK. Fix any actual errors that block the linter from running (e.g. parsing failures).

**Step 5: Create `.github/workflows/check.yml`**

```yaml
name: Check

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Lint
        run: pnpm lint

      - name: Type check & build
        run: pnpm build

      - name: Test
        run: pnpm test

  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Clippy
        working-directory: src-tauri
        run: cargo clippy -- -D warnings

      - name: Test
        working-directory: src-tauri
        run: cargo test
```

**Step 6: Commit**

```bash
git add .github/workflows/check.yml eslint.config.js package.json pnpm-lock.yaml
git commit -m "ci: add PR-level checks (eslint, tsc, vitest, clippy, cargo test)"
```

---

### Task 2: Safer port management

**Files:**
- Modify: `src-tauri/src/ssh_tunnel.rs:60-66,188-203` (remove `kill_port_holder`, use child PID tracking)
- Modify: `src-tauri/src/browser.rs:50-57,93-103,138-153` (remove `kill_port_holder`, add port-in-use check)
- Modify: `src-tauri/tests/ssh_tunnel_test.rs` (update test if needed)

**Step 1: Add `is_port_in_use` helper to `ssh_tunnel.rs`**

Add at the bottom of `ssh_tunnel.rs`, replacing the `kill_port_holder` function:

```rust
/// Check whether a TCP port is already in use by attempting to bind.
pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}
```

**Step 2: Update `TunnelManager::start()` in `ssh_tunnel.rs`**

Replace lines 60-66 (the `kill_port_holder` call and the preceding child cleanup):

Before:
```rust
        // Ensure we don't leak previous ssh child when reconnecting.
        if self.child.is_some() {
            let _ = self.stop();
        }

        // Kill any orphaned process holding the local port (e.g. from a previous app crash).
        Self::kill_port_holder(server.local_port);
```

After:
```rust
        // Ensure we don't leak previous ssh child when reconnecting.
        if self.child.is_some() {
            let _ = self.stop();
        }

        // Refuse to start if the port is already occupied by another process.
        if is_port_in_use(server.local_port) {
            let msg = format!("port {} is already in use by another process", server.local_port);
            self.last_error = Some(msg.clone());
            return Err(msg);
        }
```

**Step 3: Delete `kill_port_holder` from `ssh_tunnel.rs`**

Delete the entire `kill_port_holder` method (lines 188-203, the `fn kill_port_holder(port: u16)` function).

**Step 4: Update `BrowserManager::start()` in `browser.rs`**

Replace line 57 (`kill_port_holder(cdp_port);`):

Before:
```rust
        // Kill any orphaned process holding the CDP port.
        kill_port_holder(cdp_port);
```

After:
```rust
        // Refuse to start if the CDP port is already occupied.
        if crate::ssh_tunnel::is_port_in_use(cdp_port) {
            return Err(format!("CDP port {} is already in use by another process", cdp_port));
        }
```

**Step 5: Update `BrowserManager::stop()` in `browser.rs`**

Replace lines 95-103. Remove the `kill_port_holder` call from `stop()`. Chrome may re-exec to a new PID, but we accept that: we kill our tracked child, and if the re-exec'd process is still running we leave it (user can manually close or the next `start` will detect port conflict).

Before:
```rust
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
```

After:
```rust
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            eprintln!("[browser] killing chrome pid {}", child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
```

**Step 6: Delete `kill_port_holder` from `browser.rs`**

Delete the standalone `pub fn kill_port_holder(port: u16)` function (lines 138-153).

**Step 7: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: All tests pass. The `ssh_tunnel_test` uses `OPENCLAW_CONNECTOR_FAKE_TUNNEL` which bypasses the port check.

**Step 8: Commit**

```bash
git add src-tauri/src/ssh_tunnel.rs src-tauri/src/browser.rs
git commit -m "fix: replace kill_port_holder with safe port-in-use check

Only kill our own tracked child processes. If a port is occupied by an
unrelated process, return an error instead of blindly killing it."
```

---

### Task 3: WebSocket graceful shutdown

**Files:**
- Modify: `src-tauri/src/ws_client.rs:62-72` (add shutdown flag parameter to `run_ws_loop`)
- Modify: `src-tauri/src/ws_client.rs:487-646` (add shutdown flag to `run_operator_loop`)
- Modify: `src-tauri/src/lib.rs:17-26` (replace `ws_shutdown: oneshot` with `Arc<AtomicBool>`)
- Modify: `src-tauri/src/lib.rs:62-200` (`connect` function — use AtomicBool, pass to loops)
- Modify: `src-tauri/src/lib.rs:202-242` (`disconnect` function — set flag, no oneshot)

**Step 1: Add shutdown flag to `run_ws_loop` signature**

In `ws_client.rs`, change the `run_ws_loop` signature to accept a shutdown flag:

```rust
pub async fn run_ws_loop(
    ws_url: &str,
    gateway_token: &str,
    node_id: &str,
    node_name: &str,
    identity: &DeviceIdentity,
    event_tx: mpsc::UnboundedSender<NodeEvent>,
    rpc_rx: &mut mpsc::UnboundedReceiver<RpcRequest>,
    ws_connected: Arc<Mutex<bool>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
```

**Step 2: Add graceful Close Frame before exit in `run_ws_loop`**

At the very end of `run_ws_loop`, before the pending RPC drain, send a Close Frame. Replace the loop exit + drain section (starting from after the main `loop { tokio::select! { ... } }`) with:

```rust
    // Send Close Frame for graceful shutdown
    eprintln!("[ws_client] sending Close frame");
    let _ = write.send(Message::Close(None)).await;

    // Wait briefly for server Close response
    let close_deadline = tokio::time::sleep(std::time::Duration::from_secs(3));
    tokio::pin!(close_deadline);
    loop {
        tokio::select! {
            msg_opt = read.next() => {
                match msg_opt {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
            _ = &mut close_deadline => {
                eprintln!("[ws_client] Close frame timeout, forcing disconnect");
                break;
            }
        }
    }

    for (_, tx) in pending_rpcs.drain() {
        let _ = tx.send(Err("WebSocket connection closed".to_string()));
    }

    Ok(())
```

Also, inside the main `loop`, add a shutdown check at the top of each iteration. Add this as the first branch in `tokio::select!`:

```rust
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)), if shutdown.load(std::sync::atomic::Ordering::Relaxed) => {
                eprintln!("[ws_client] shutdown flag detected");
                break;
            }
```

**Step 3: Add shutdown flag to `run_operator_loop`**

Change `run_operator_loop` signature:

```rust
pub async fn run_operator_loop(
    ws_url: &str,
    local_port: u16,
    gateway_token: &str,
    rpc_rx: &mut mpsc::UnboundedReceiver<RpcRequest>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
```

Add shutdown check as first branch in the operator loop's `tokio::select!`:

```rust
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)), if shutdown.load(std::sync::atomic::Ordering::Relaxed) => {
                eprintln!("[operator_ws] shutdown flag detected");
                break;
            }
```

Add Close Frame send at the end of `run_operator_loop`, before the pending RPC drain (same pattern as node loop).

**Step 4: Update `AppState` in `lib.rs`**

Replace `ws_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>` with an `AtomicBool`:

```rust
use std::sync::atomic::AtomicBool;

struct AppState {
    tunnel: Mutex<ssh_tunnel::TunnelManager>,
    heartbeat: Mutex<heartbeat::HeartbeatMonitor>,
    ws_shutdown: Arc<AtomicBool>,
    ws_connected: Arc<Mutex<bool>>,
    rpc_tx: Mutex<Option<mpsc::UnboundedSender<ws_client::RpcRequest>>>,
    browser: Mutex<browser::BrowserManager>,
    cdp_tunnel: Mutex<ssh_tunnel::CdpTunnel>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tunnel: Mutex::new(ssh_tunnel::TunnelManager::new()),
            heartbeat: Mutex::new(heartbeat::HeartbeatMonitor::new(3)),
            ws_shutdown: Arc::new(AtomicBool::new(false)),
            ws_connected: Arc::new(Mutex::new(false)),
            rpc_tx: Mutex::new(None),
            browser: Mutex::new(browser::BrowserManager::new()),
            cdp_tunnel: Mutex::new(ssh_tunnel::CdpTunnel::new()),
        }
    }
}
```

**Step 5: Update `connect()` in `lib.rs`**

Replace the oneshot channel setup. In the shutdown of previous WS (around lines 82-89), change to:

```rust
    // 0. Signal any previous WebSocket loops to shut down
    state.ws_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    // Brief pause to let previous loops detect the flag
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Reset for the new connection
    state.ws_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);
```

Remove the `let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();` line and the `ws_shutdown` mutex store.

Pass `Arc::clone(&state.ws_shutdown)` to both spawned WS loops.

For the **operator loop** (around line 150-159), change to check shutdown before reconnecting:

```rust
    let operator_shutdown = Arc::clone(&state.ws_shutdown);
    tauri::async_runtime::spawn(async move {
        loop {
            if operator_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[connector] Operator WS shutdown, exiting loop");
                break;
            }
            match ws_client::run_operator_loop(&operator_ws_url, local_port, &operator_token, &mut operator_rpc_rx, Arc::clone(&operator_shutdown)).await {
                Ok(()) => eprintln!("[connector] Operator WS closed normally"),
                Err(e) => eprintln!("[connector] Operator WS error: {e}"),
            }
            if operator_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
```

For the **node loop** (around line 162-197), replace the `oneshot` shutdown_rx with the AtomicBool:

```rust
    let node_shutdown = Arc::clone(&state.ws_shutdown);
    tauri::async_runtime::spawn(async move {
        loop {
            if node_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[connector] Node WS shutdown, exiting loop");
                break;
            }
            let event_tx_clone = event_tx.clone();
            let ws_connected_clone = Arc::clone(&ws_connected);
            let ws_result = ws_client::run_ws_loop(
                &ws_url, &gateway_token, &node_id, &node_name, &identity,
                event_tx_clone, &mut node_rpc_rx, ws_connected_clone,
                Arc::clone(&node_shutdown),
            ).await;

            if let Ok(mut connected) = ws_connected.lock() {
                *connected = false;
            }
            match ws_result {
                Ok(()) => eprintln!("[connector] WebSocket closed normally"),
                Err(e) => eprintln!("[connector] WebSocket error: {e}"),
            }
            if node_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            eprintln!("[connector] Attempting WebSocket reconnect...");
        }
    });
```

**Step 6: Update `disconnect()` in `lib.rs`**

Replace the oneshot send with:

```rust
    // 1. Signal all WebSocket loops to shut down
    state.ws_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut connected) = state.ws_connected.lock() {
        *connected = false;
    }
```

Remove the old `ws_shutdown.lock()` / `.take()` / `.send(())` block.

**Step 7: Build and verify**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: All tests pass.

**Step 8: Commit**

```bash
git add src-tauri/src/ws_client.rs src-tauri/src/lib.rs
git commit -m "fix: WebSocket graceful shutdown with Close Frame and AtomicBool flag

- Send Close Frame before disconnecting, wait up to 3s for server response
- Replace oneshot channel with AtomicBool shutdown flag
- Operator loop checks shutdown flag before reconnecting
- Node loop checks shutdown flag before reconnecting"
```

---

### Task 4: Unified config (backend as single source of truth)

**Files:**
- Modify: `src/store/useConfigStore.ts` (remove persist middleware, add auto-save)
- Modify: `src/App.tsx:11-17` (improve load error handling)
- Modify: `src/__tests__/config-store.test.ts` (update for new store shape)

**Step 1: Rewrite `useConfigStore.ts`**

Replace the entire file:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createDefaultConfig, type ConnectorConfig } from "../types/config";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(cfg: ConnectorConfig) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_app_config", { cfg }).catch((err) => {
      console.error("[config] auto-save failed:", err);
    });
  }, 300);
}

type ConfigState = {
  config: ConnectorConfig;
  loaded: boolean;
  setConfig: (config: ConnectorConfig) => void;
  patchConfig: (patch: Partial<ConnectorConfig>) => void;
};

export const useConfigStore = create<ConfigState>()((set, get) => ({
  config: createDefaultConfig(),
  loaded: false,
  setConfig: (config) => {
    set({ config, loaded: true });
    debouncedSave(config);
  },
  patchConfig: (patch) => {
    const prev = get().config;
    const next = {
      ...prev,
      ...patch,
      server: { ...prev.server, ...(patch.server ?? {}) },
      runtime: { ...prev.runtime, ...(patch.runtime ?? {}) },
    };
    set({ config: next });
    debouncedSave(next);
  },
}));
```

**Step 2: Clear leftover localStorage on load**

In `src/App.tsx`, update the `useEffect` to clear stale localStorage and handle errors:

```typescript
  useEffect(() => {
    // Clear leftover localStorage from previous versions
    localStorage.removeItem("openclaw-connector-config");

    invoke("load_app_config")
      .then((cfg) => {
        if (cfg) setConfig(cfg as ConnectorConfig);
      })
      .catch((err) => {
        console.warn("[config] failed to load from backend, using defaults:", err);
      });
  }, [setConfig]);
```

**Step 3: Remove manual `save_app_config` calls from `ConnectionPage.tsx`**

The store now auto-saves on every `patchConfig` / `setConfig`. Remove the explicit `invoke("save_app_config", ...)` calls in `ConnectionPage.tsx`.

In the `connect` function (around line 273-276), change:

Before:
```typescript
      patchConfig({ server, gatewayToken, nodeName });
      await invoke("save_app_config", {
        cfg: { ...config, server, gatewayToken, nodeName }
      }).catch(() => {});
```

After:
```typescript
      patchConfig({ server, gatewayToken, nodeName });
```

In the `startBrowser` function (around line 338-341), change:

Before:
```typescript
      patchConfig({ cdpPort, cdpRemotePort });
      await invoke("save_app_config", {
        cfg: { ...config, cdpPort, cdpRemotePort },
      }).catch(() => {});
```

After:
```typescript
      patchConfig({ cdpPort, cdpRemotePort });
```

**Step 4: Update the config store test**

Replace `src/__tests__/config-store.test.ts`:

```typescript
import { createDefaultConfig } from "../types/config";

test("default config has required fields", () => {
  const cfg = createDefaultConfig();
  expect(cfg.server.host).toBeDefined();
  expect(typeof cfg.server.localPort).toBe("number");
  expect(cfg.nodeId).toBeDefined();
  expect(cfg.gatewayToken).toBe("");
});
```

**Step 5: Run frontend tests**

Run: `pnpm test`
Expected: All tests pass.

**Step 6: Run frontend build**

Run: `pnpm build`
Expected: No type errors.

**Step 7: Commit**

```bash
git add src/store/useConfigStore.ts src/App.tsx src/pages/ConnectionPage.tsx src/__tests__/config-store.test.ts
git commit -m "refactor: unify config to backend JSON as single source of truth

- Remove localStorage persistence from Zustand store
- Auto-save to backend on every config change (debounced 300ms)
- Clear leftover localStorage on app load
- Remove manual save_app_config calls from ConnectionPage"
```

---

### Task 5: Final verification

**Step 1: Run all frontend checks**

```bash
pnpm lint && pnpm build && pnpm test
```

Expected: All pass.

**Step 2: Run all backend checks**

```bash
cd src-tauri && cargo clippy -- -D warnings && cargo test && cd ..
```

Expected: All pass.

**Step 3: Commit any remaining fixes**

If clippy or eslint flagged anything that needed fixing, commit those fixes.

**Step 4: Push**

```bash
git push
```
