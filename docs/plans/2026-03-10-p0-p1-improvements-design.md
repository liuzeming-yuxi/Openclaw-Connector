# P0/P1 Improvements Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve engineering quality and reliability with PR-level CI, safer port management, WebSocket graceful shutdown, and unified config.

**Architecture:** Four independent improvements to the existing Tauri 2 app. CI is a new GitHub Actions workflow. Port management, WebSocket, and config changes are Rust backend + React frontend modifications.

**Tech Stack:** GitHub Actions, ESLint 9 (flat config), cargo clippy, Tokio, tungstenite, Zustand

---

## 1. PR-level CI Checks

### Problem
Only `release.yml` exists (tag-triggered). No validation on PRs — broken code can merge to main.

### Design
New `.github/workflows/check.yml`, triggers on `pull_request` + `push to main`.

**Frontend job** (Ubuntu, Node 22 + pnpm 10):
- `pnpm install`
- `pnpm build` (tsc type check + Vite build)
- `pnpm test` (Vitest)
- `npx eslint src/` (new ESLint config needed)

**Backend job** (Ubuntu, Rust stable + Tauri system deps):
- `cargo clippy -- -D warnings`
- `cargo test`

**ESLint setup:**
- New `eslint.config.js` using flat config (ESLint 9+)
- Packages: `eslint`, `@eslint/js`, `typescript-eslint`
- Start with recommended rules, don't block existing code patterns

---

## 2. Safer Port Management

### Problem
`kill_port_holder()` in `ssh_tunnel.rs` and `browser.rs` uses `lsof` to find ANY process on a port and kills it. Could kill unrelated user services. Code is duplicated.

### Design

**Track child PIDs:**
- `SshTunnel` struct stores `Option<u32>` for the SSH child process PID
- `BrowserManager` struct stores `Option<u32>` for the Chrome child process PID
- `start()` records PID from `Command::spawn()` return value
- `stop()` only kills the recorded PID

**Remove `kill_port_holder`:**
- Delete both copies of the function
- If port is occupied at `start()` time, return error: `"Port {port} is already in use by another process"`
- Frontend displays this error to user

**Port check utility:**
- Add `fn is_port_in_use(port: u16) -> bool` helper (try TCP bind, if fails → in use)
- Call before `start()` to give clear error messages

---

## 3. WebSocket Graceful Shutdown

### Problem
- `disconnect()` sends shutdown signal but operator loop may auto-reconnect
- No Close Frame sent to server — server relies on heartbeat timeout to detect disconnect
- No timeout on graceful shutdown

### Design

**Shutdown flag:**
- Replace `oneshot::channel` with `Arc<AtomicBool>` shutdown flag
- Set flag in `disconnect()`, check in all loops

**Close Frame:**
- On shutdown, send `Message::Close(None)` before dropping connection
- Wait up to 3 seconds for server Close response
- Force-close after timeout

**Operator loop:**
- Check shutdown flag before each reconnect attempt
- If shutdown flag is set, break out of reconnect loop

**Pending RPC cleanup:**
- Drain all pending RPCs with error "connection shutting down" (already partially done)

---

## 4. Unified Config (Backend as Single Source of Truth)

### Problem
Frontend uses localStorage (Zustand persist), backend uses JSON file. Two independent storage systems. On reload, localStorage takes precedence. Changes can be lost.

### Design

**Remove localStorage persistence:**
- `useConfigStore.ts`: Remove `persist()` middleware. Store becomes pure in-memory state.
- Clear any leftover localStorage data on first load.

**Backend as source:**
- `App.tsx` on mount: `invoke("load_app_config")` → populate store
- If load fails (first run, file missing): use `createDefaultConfig()` defaults, immediately save to backend

**Auto-save on change:**
- `patchConfig()` / `setConfig()`: After updating store state, auto-call `invoke("save_app_config", { cfg })`
- Debounce saves (300ms) to avoid excessive file writes during rapid changes

**Error handling:**
- Load failure: show toast warning, use defaults
- Save failure: show toast warning, don't block UI

**Data flow:**
```
App start → invoke("load_app_config") → Rust reads JSON → setConfig(store)
User edits → patchConfig(store) → debounced invoke("save_app_config") → Rust writes JSON
```
