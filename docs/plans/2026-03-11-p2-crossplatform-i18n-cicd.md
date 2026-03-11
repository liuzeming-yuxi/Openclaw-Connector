# P2 Cross-Platform, i18n & CI/CD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OpenClaw Connector build and run on Windows/Linux, add Chinese+English UI, expand CI to validate all platforms.

**Architecture:** Cross-platform via `#[cfg(target_os)]` and `std::env::consts::OS` in Rust; i18n via `react-i18next` with JSON locale files and Zustand language store; CI via GitHub Actions matrix strategy across 3 OS runners.

**Tech Stack:** Rust (cfg, open crate), react-i18next, Zustand, GitHub Actions

---

## Task 1: Cross-Platform — Browser Binary Discovery

**Files:**
- Modify: `src-tauri/src/browser.rs`

**Step 1: Replace `find_chrome_binary` with cross-platform version**

Replace the current macOS-only function with `#[cfg]` blocks:

```rust
/// Locate a Chrome-compatible binary on the current platform.
pub fn find_chrome_binary() -> Result<String, String> {
    let candidates = platform_chrome_candidates();

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            eprintln!("[browser] found chrome binary: {path}");
            return Ok(path.to_string());
        }
    }

    Err("no Chrome-compatible browser found on this system".to_string())
}

#[cfg(target_os = "macos")]
fn platform_chrome_candidates() -> Vec<&'static str> {
    vec![
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
}

#[cfg(target_os = "linux")]
fn platform_chrome_candidates() -> Vec<&'static str> {
    vec![
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ]
}

#[cfg(target_os = "windows")]
fn platform_chrome_candidates() -> Vec<&'static str> {
    vec![
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
}
```

Also update the doc comment from "macOS" to "current platform".

**Step 2: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add src-tauri/src/browser.rs
git commit -m "feat: cross-platform Chrome binary discovery"
```

---

## Task 2: Cross-Platform — Port Killer

**Files:**
- Modify: `src-tauri/src/ssh_tunnel.rs`

**Step 1: Replace `kill_port_holder` with cross-platform version**

Replace the current function (lines 232-252) with:

```rust
/// Kill whatever process is holding a TCP port.
/// Only call this after explicit user confirmation.
pub fn kill_port_holder(port: u16) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let output = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        if let Ok(out) = output {
            let pids = String::from_utf8_lossy(&out.stdout);
            for pid in pids.trim().lines() {
                if let Ok(n) = pid.trim().parse::<u32>() {
                    eprintln!("[ssh_tunnel] killing port {port} holder pid {n}");
                    let _ = Command::new("kill").arg(n.to_string()).output();
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Find PID via netstat, then kill via taskkill
        let output = Command::new("netstat")
            .args(["-ano"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            let port_str = format!(":{port}");
            for line in text.lines() {
                if line.contains(&port_str) && line.contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        if let Ok(n) = pid.parse::<u32>() {
                            eprintln!("[ssh_tunnel] killing port {port} holder pid {n}");
                            let _ = Command::new("taskkill")
                                .args(["/F", "/PID", &n.to_string()])
                                .output();
                        }
                    }
                }
            }
        }
    }

    // Brief pause to let the OS release the port
    std::thread::sleep(std::time::Duration::from_millis(300));
}
```

Update the doc comment to remove "(macOS/Linux only)".

**Step 2: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add src-tauri/src/ssh_tunnel.rs
git commit -m "feat: cross-platform port killer (lsof/netstat+taskkill)"
```

---

## Task 3: Cross-Platform — open_url, Platform String, Default Name

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/ws_client.rs`
- Modify: `src-tauri/src/config.rs`

**Step 1: Add `open` crate to Cargo.toml**

Add to `[dependencies]`:

```toml
open = "5"
```

**Step 2: Replace `open_url` in lib.rs**

Replace the current `open_url` function:

```rust
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("failed to open URL: {e}"))
}
```

**Step 3: Replace hardcoded "darwin" in ws_client.rs**

Add a helper function at the top of ws_client.rs (after the imports):

```rust
/// Return the platform identifier for WebSocket auth payloads.
fn current_platform() -> &'static str {
    std::env::consts::OS
}
```

Then replace all 3 occurrences of `"darwin"`:

1. Line ~361 in `build_connect_request`: change `"darwin",` to `current_platform(),`
2. Line ~380 in `build_connect_request` JSON: change `"platform": "darwin",` to `"platform": current_platform(),`
3. Line ~608 in `run_operator_loop` JSON: change `"platform": "darwin",` to `"platform": current_platform(),`

**Step 4: Fix default node name in config.rs**

Replace `default_node_name`:

```rust
fn default_node_name() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    format!("OpenClaw Connector ({os})")
}
```

**Step 5: Replace Chinese strings in lib.rs health monitor**

Replace the two Chinese tunnel messages with English event codes (frontend will translate):

- `"SSH 隧道断开，正在自动重连..."` → `"tunnel_reconnecting"`
- `"SSH 隧道自动重连失败，请手动重新连接"` → `"tunnel_reconnect_failed"`

**Step 6: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

**Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/ws_client.rs src-tauri/src/config.rs
git commit -m "feat: cross-platform open_url, platform string, default name"
```

---

## Task 4: CI/CD — Multi-Platform Check Workflow

**Files:**
- Modify: `.github/workflows/check.yml`

**Step 1: Replace check.yml with multi-platform backend matrix**

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
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            deps: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
          - os: macos-latest
            deps: ''
          - os: windows-latest
            deps: ''
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy

      - name: Install system dependencies
        if: matrix.deps != ''
        run: ${{ matrix.deps }}

      - name: Clippy
        working-directory: src-tauri
        run: cargo clippy -- -D warnings

      - name: Test
        working-directory: src-tauri
        run: cargo test
```

**Step 2: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/check.yml'))"`
Expected: No errors. (If `PyYAML` not available, skip — GitHub will validate.)

**Step 3: Commit**

```bash
git add .github/workflows/check.yml
git commit -m "ci: add macOS and Windows to backend check matrix"
```

---

## Task 5: i18n — Setup react-i18next + Translation Files

**Files:**
- Create: `src/i18n/index.ts`
- Create: `src/i18n/zh.json`
- Create: `src/i18n/en.json`
- Modify: `src/main.tsx` (import i18n init)

**Step 1: Install dependencies**

Run: `pnpm add i18next react-i18next`

**Step 2: Create `src/i18n/zh.json`**

Extract all Chinese strings from App.tsx and ConnectionPage.tsx:

```json
{
  "app": {
    "title": "连接器控制台",
    "subtitle": "被动 Node 客户端，通过加密 SSH 隧道接收网关任务，在完全隔离的环境下安全执行本地指令。",
    "e2e": "端到端加密",
    "theme_dark": "深色",
    "theme_light": "浅色",
    "theme_system": "系统",
    "theme_title_dark": "当前主题：深色",
    "theme_title_light": "当前主题：浅色",
    "theme_title_system": "当前主题：跟随系统"
  },
  "connection": {
    "tunnel_title": "隧道连接",
    "status_connected": "已连接",
    "status_connected_latency": "已连接 · {{ms}}ms",
    "status_ssh_ok_ws_pending": "SSH 已连接，WS 连接中",
    "status_connecting": "连接中",
    "status_reconnecting": "重连中",
    "status_disconnected": "未连接",
    "host": "主机地址",
    "user": "用户",
    "node_name": "节点名称",
    "node_name_placeholder": "OpenClaw Connector",
    "gateway_token": "Gateway Token",
    "gateway_token_placeholder": "gateway.auth.token 的值",
    "key_path": "密钥路径",
    "remote_port": "远程端口",
    "local_port": "本地端口",
    "connect": "连接网关",
    "reconnect": "重新连接",
    "processing": "处理中...",
    "disconnect": "断开",
    "console": "管理控制台",
    "force_connect": "强制释放端口并连接",
    "recent_error": "最近错误：{{msg}}"
  },
  "browser": {
    "title": "浏览器自动化",
    "status_tunnel_ready": "隧道就绪",
    "status_running": "运行中",
    "status_stopped": "未启动",
    "cdp_local": "CDP 端口 (本地)",
    "cdp_remote": "远程映射端口",
    "start": "启动 Chrome",
    "starting": "启动中...",
    "stop": "停止 Chrome",
    "stopping": "停止中...",
    "cdp_ready": "CDP 隧道已建立。远程 Agent 可通过 <code>localhost:{{port}}</code> 连接。"
  },
  "agents": {
    "title": "会话注入",
    "loading": "正在加载 Agent...",
    "empty": "暂无可用的 Agent",
    "loading_sessions": "加载中...",
    "no_sessions": "无活跃 Session",
    "inject": "注入",
    "disconnect": "断开",
    "loading_history": "加载历史...",
    "empty_history": "空",
    "role_user": "用户",
    "role_ai": "AI"
  },
  "activity": {
    "title": "活动日志",
    "clear": "清空",
    "waiting": "> 等待事件..."
  },
  "events": {
    "ws_connected": "WebSocket 已连接，正在认证...",
    "authenticated": "Gateway 认证成功，等待任务分派",
    "ws_disconnected": "WebSocket 断开：{{reason}}",
    "task_received": "收到任务 [{{id}}] {{action}}",
    "task_completed": "任务完成 [{{id}}] exit={{code}} {{ms}}ms",
    "task_failed": "任务失败 [{{id}}] {{error}}",
    "agent_load_failed": "加载 Agent 列表失败：{{msg}}",
    "session_load_failed": "加载 Session 列表失败：{{msg}}",
    "chat_load_failed": "加载聊天记录失败：{{msg}}",
    "action_failed": "操作失败：{{msg}}",
    "connect_init": "发起连接：{{target}}",
    "connect_force": "强制连接：{{target}}",
    "tunnel_ok": "SSH 隧道已连接，WebSocket 正在建立...",
    "connect_failed": "连接失败：{{msg}}",
    "disconnect_notify": "向 {{count}} 个 session 发送断开连接通知...",
    "disconnect_init": "发起断开",
    "disconnected": "已断开",
    "disconnect_failed": "断开失败：{{msg}}",
    "chrome_started": "Chrome 已启动，CDP 端口 {{cdp}}，远程映射 {{remote}}",
    "chrome_cdp_failed": "Chrome 进程已启动但 CDP 端口无响应，请关闭所有已有 Chrome 窗口后重试",
    "chrome_start_failed": "启动浏览器失败：{{msg}}",
    "chrome_stopped": "Chrome 已停止",
    "chrome_stop_failed": "停止浏览器失败：{{msg}}",
    "session_linked": "已连接本地到 session [{{key}}]",
    "session_unlinked": "已断开本地连接 [{{key}}]",
    "tunnel_reconnecting": "SSH 隧道断开，正在自动重连...",
    "tunnel_reconnect_failed": "SSH 隧道自动重连失败，请手动重新连接"
  }
}
```

**Step 3: Create `src/i18n/en.json`**

```json
{
  "app": {
    "title": "Connector Console",
    "subtitle": "Passive node client that receives gateway tasks through an encrypted SSH tunnel and executes local commands in a fully isolated environment.",
    "e2e": "End-to-End Encrypted",
    "theme_dark": "Dark",
    "theme_light": "Light",
    "theme_system": "System",
    "theme_title_dark": "Current theme: Dark",
    "theme_title_light": "Current theme: Light",
    "theme_title_system": "Current theme: Follow system"
  },
  "connection": {
    "tunnel_title": "Tunnel Connection",
    "status_connected": "Connected",
    "status_connected_latency": "Connected · {{ms}}ms",
    "status_ssh_ok_ws_pending": "SSH connected, WS connecting",
    "status_connecting": "Connecting",
    "status_reconnecting": "Reconnecting",
    "status_disconnected": "Disconnected",
    "host": "Host",
    "user": "User",
    "node_name": "Node Name",
    "node_name_placeholder": "OpenClaw Connector",
    "gateway_token": "Gateway Token",
    "gateway_token_placeholder": "Value of gateway.auth.token",
    "key_path": "Key Path",
    "remote_port": "Remote Port",
    "local_port": "Local Port",
    "connect": "Connect",
    "reconnect": "Reconnect",
    "processing": "Processing...",
    "disconnect": "Disconnect",
    "console": "Management Console",
    "force_connect": "Force release port and connect",
    "recent_error": "Recent error: {{msg}}"
  },
  "browser": {
    "title": "Browser Automation",
    "status_tunnel_ready": "Tunnel Ready",
    "status_running": "Running",
    "status_stopped": "Stopped",
    "cdp_local": "CDP Port (Local)",
    "cdp_remote": "Remote Mapped Port",
    "start": "Start Chrome",
    "starting": "Starting...",
    "stop": "Stop Chrome",
    "stopping": "Stopping...",
    "cdp_ready": "CDP tunnel established. Remote agents can connect via <code>localhost:{{port}}</code>."
  },
  "agents": {
    "title": "Session Injection",
    "loading": "Loading agents...",
    "empty": "No agents available",
    "loading_sessions": "Loading...",
    "no_sessions": "No active sessions",
    "inject": "Inject",
    "disconnect": "Disconnect",
    "loading_history": "Loading history...",
    "empty_history": "Empty",
    "role_user": "User",
    "role_ai": "AI"
  },
  "activity": {
    "title": "Activity Log",
    "clear": "Clear",
    "waiting": "> Waiting for events..."
  },
  "events": {
    "ws_connected": "WebSocket connected, authenticating...",
    "authenticated": "Gateway authenticated, waiting for task dispatch",
    "ws_disconnected": "WebSocket disconnected: {{reason}}",
    "task_received": "Task received [{{id}}] {{action}}",
    "task_completed": "Task completed [{{id}}] exit={{code}} {{ms}}ms",
    "task_failed": "Task failed [{{id}}] {{error}}",
    "agent_load_failed": "Failed to load agents: {{msg}}",
    "session_load_failed": "Failed to load sessions: {{msg}}",
    "chat_load_failed": "Failed to load chat history: {{msg}}",
    "action_failed": "Action failed: {{msg}}",
    "connect_init": "Connecting: {{target}}",
    "connect_force": "Force connecting: {{target}}",
    "tunnel_ok": "SSH tunnel connected, establishing WebSocket...",
    "connect_failed": "Connection failed: {{msg}}",
    "disconnect_notify": "Sending disconnect notification to {{count}} sessions...",
    "disconnect_init": "Disconnecting",
    "disconnected": "Disconnected",
    "disconnect_failed": "Disconnect failed: {{msg}}",
    "chrome_started": "Chrome started, CDP port {{cdp}}, remote mapped {{remote}}",
    "chrome_cdp_failed": "Chrome process started but CDP port not responding. Close all Chrome windows and retry.",
    "chrome_start_failed": "Failed to start browser: {{msg}}",
    "chrome_stopped": "Chrome stopped",
    "chrome_stop_failed": "Failed to stop browser: {{msg}}",
    "session_linked": "Local connected to session [{{key}}]",
    "session_unlinked": "Local disconnected from session [{{key}}]",
    "tunnel_reconnecting": "SSH tunnel disconnected, auto-reconnecting...",
    "tunnel_reconnect_failed": "SSH tunnel auto-reconnect failed, please reconnect manually"
  }
}
```

**Step 4: Create `src/i18n/index.ts`**

```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./zh.json";
import en from "./en.json";

const stored = localStorage.getItem("openclaw-lang");
const lng = stored && ["zh", "en"].includes(stored) ? stored : "zh";

i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng,
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
});

export default i18n;
```

**Step 5: Import i18n in main.tsx**

Add at the top of `src/main.tsx` (before React imports):

```typescript
import "./i18n";
```

**Step 6: Verify**

Run: `npx tsc --noEmit && npx vite build`
Expected: Compiles, no errors.

**Step 7: Commit**

```bash
git add src/i18n/ src/main.tsx package.json pnpm-lock.yaml
git commit -m "feat: setup react-i18next with zh/en translation files"
```

---

## Task 6: i18n — Language Store + Switcher in Header

**Files:**
- Create: `src/store/useLanguageStore.ts`
- Modify: `src/App.tsx`

**Step 1: Create language store**

```typescript
// src/store/useLanguageStore.ts
import { create } from "zustand";
import i18n from "../i18n";

type Lang = "zh" | "en";

type LangState = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
};

const stored = localStorage.getItem("openclaw-lang") as Lang | null;
const initial: Lang = stored && ["zh", "en"].includes(stored) ? stored : "zh";

export const useLanguageStore = create<LangState>()((set, get) => ({
  lang: initial,
  setLang: (lang) => {
    localStorage.setItem("openclaw-lang", lang);
    i18n.changeLanguage(lang);
    set({ lang });
  },
  toggleLang: () => {
    const next = get().lang === "zh" ? "en" : "zh";
    get().setLang(next);
  },
}));
```

**Step 2: Add language switcher to App.tsx header**

Import the store and `useTranslation`:

```tsx
import { useTranslation } from "react-i18next";
import { useLanguageStore } from "./store/useLanguageStore";
import { Languages } from "lucide-react";
```

Add the `useTranslation` hook and language state inside the component:

```tsx
const { t } = useTranslation();
const lang = useLanguageStore((s) => s.lang);
```

Replace hardcoded Chinese in the header with `t()` calls, and add a language toggle button next to the theme button:

```tsx
<button
  onClick={() => useLanguageStore.getState().toggleLang()}
  className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 shadow-inner hover:bg-accent transition-colors cursor-pointer"
  title={lang === "zh" ? "Switch to English" : "切换到中文"}
>
  <Languages className="w-4 h-4 text-primary" />
  <span className="text-xs font-medium text-foreground">
    {lang === "zh" ? "EN" : "中"}
  </span>
</button>
```

Replace header text:
- `"连接器控制台"` → `{t("app.title")}`
- `"被动 Node 客户端..."` → `{t("app.subtitle")}`
- `"端到端加密"` → `{t("app.e2e")}`
- Theme labels: `"深色"/"浅色"/"系统"` → `{t("app.theme_dark")}/{t("app.theme_light")}/{t("app.theme_system")}`
- Theme title: use `t("app.theme_title_dark")` etc.

**Step 3: Verify**

Run: `npx tsc --noEmit && npx vite build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/store/useLanguageStore.ts src/App.tsx
git commit -m "feat: add language store and header language toggle"
```

---

## Task 7: i18n — ConnectionPage String Migration

**Files:**
- Modify: `src/pages/ConnectionPage.tsx`

**Step 1: Add `useTranslation` import and hook**

```tsx
import { useTranslation } from "react-i18next";
// Inside component:
const { t } = useTranslation();
```

**Step 2: Replace all hardcoded strings**

This is a systematic find-and-replace. Every Chinese string gets replaced with its `t("key")` equivalent. Key mapping follows the `zh.json` structure from Task 5.

Major areas:
- Status text (`statusText` useMemo): use `t("connection.status_connected")` etc.
- Form labels: `t("connection.host")`, `t("connection.user")` etc.
- Button text: `t("connection.connect")`, `t("connection.disconnect")` etc.
- Activity log messages in event handler and action functions: `t("events.ws_connected")` etc.
- Agent section: `t("agents.title")`, `t("agents.inject")` etc.
- Browser section: `t("browser.title")`, `t("browser.start")` etc.

Also handle the two backend tunnel event codes from Task 3 Step 5:
```tsx
case "error":
  // Map backend event codes to localized messages
  if (e.message === "tunnel_reconnecting") {
    pushActivity("error", t("events.tunnel_reconnecting"));
  } else if (e.message === "tunnel_reconnect_failed") {
    pushActivity("error", t("events.tunnel_reconnect_failed"));
  } else {
    pushActivity("error", e.message);
  }
  break;
```

**Step 3: Verify**

Run: `npx tsc --noEmit && npx vite build`
Expected: No errors.

**Step 4: Commit**

```bash
git add src/pages/ConnectionPage.tsx
git commit -m "feat: migrate ConnectionPage strings to i18n"
```

---

## Task 8: Final Verification

**Step 1: Full frontend check**

Run: `npx tsc --noEmit && npx vite build`
Expected: 0 errors, build succeeds.

**Step 2: Full backend check**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: No warnings, all tests pass.

**Step 3: Frontend tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 4: Update README roadmap**

In both `README.md` and `README.zh-CN.md`, mark completed items:
```markdown
- [x] Cross-platform support (Windows & Linux)
- [x] Multi-language UI (i18n)
- [x] Comprehensive CI/CD pipeline
```

**Step 5: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: mark cross-platform, i18n, CI/CD as completed"
```
