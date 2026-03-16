# Multi-Profile Connection Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace single-connection config with multi-profile management — left/right split UI, 3-field quick creation, auto-detect local Gateway token.

**Architecture:** Profiles stored in `AppConfig.profiles[]` with `activeProfileId`. Rust backend `connect()` takes `profile_id` instead of individual fields. Frontend split into `ProfileSidebar` + `ProfileDetail` components. Migration converts old single-config to first profile.

**Tech Stack:** React 19, TypeScript, Zustand 5, Tauri 2 (Rust), Vitest, react-i18next

---

### Task 1: Update Rust data model — `config.rs`

**Files:**
- Modify: `src-tauri/src/config.rs`
- Test: `src-tauri/tests/config_test.rs`

**Step 1: Write the failing test**

Add migration + new structure tests to `src-tauri/tests/config_test.rs`:

```rust
use connector::config::{load_config, save_config, AppConfig};

#[test]
fn loads_and_saves_single_server_config() {
    // ... existing test — UPDATE to use new structure ...
    let path = base.join("config.json");
    let cfg = AppConfig::default();
    save_config(&path, &cfg).expect("save config");

    let loaded = load_config(&path).expect("load config");
    assert_eq!(loaded.profiles.len(), 1);
    assert_eq!(loaded.profiles[0].server.host, cfg.profiles[0].server.host);
    assert_eq!(loaded.profiles[0].server.local_port, cfg.profiles[0].server.local_port);

    std::fs::remove_dir_all(base).expect("cleanup");
}

#[test]
fn migrates_old_config_format() {
    let base = std::env::temp_dir().join(format!(
        "connector-migrate-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("unix time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let path = base.join("config.json");

    // Write old-format config (has "server" but no "profiles")
    let old_json = r#"{
        "server": { "host": "10.0.0.1", "user": "testuser", "keyPath": "~/.ssh/id_rsa", "localPort": 18789, "remotePort": 18789 },
        "runtime": { "heartbeatIntervalSec": 15, "reconnectIntervalSec": 5 },
        "globalAllow": true,
        "gatewayToken": "abc123",
        "nodeId": "old-node-id",
        "nodeName": "Old Node",
        "cdpPort": 9222,
        "cdpRemotePort": 19222
    }"#;
    std::fs::write(&path, old_json).expect("write old config");

    let loaded = load_config(&path).expect("load old config");
    assert_eq!(loaded.profiles.len(), 1);
    assert_eq!(loaded.profiles[0].name, "Old Node");
    assert_eq!(loaded.profiles[0].server.host, "10.0.0.1");
    assert_eq!(loaded.profiles[0].server.user, "testuser");
    assert_eq!(loaded.profiles[0].gateway_token, "abc123");
    assert_eq!(loaded.profiles[0].node_id, "old-node-id");
    assert!(loaded.active_profile_id.is_some());

    std::fs::remove_dir_all(base).expect("cleanup");
}

#[test]
fn default_config_has_one_profile() {
    let cfg = AppConfig::default();
    assert_eq!(cfg.profiles.len(), 1);
    assert!(cfg.active_profile_id.is_some());
    assert!(!cfg.profiles[0].id.is_empty());
    assert!(!cfg.profiles[0].node_id.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test`
Expected: Compilation errors — `AppConfig` doesn't have `profiles` field yet.

**Step 3: Implement `ConnectionProfile` + new `AppConfig` in `config.rs`**

Replace the `AppConfig` struct (lines 23-39) and add `ConnectionProfile`. Keep `ServerConfig` and `RuntimeConfig` unchanged:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub server: ServerConfig,
    pub gateway_token: String,
    pub node_name: String,
    pub node_id: String,
    pub cdp_port: u16,
    pub cdp_remote_port: u16,
    pub created_at: String,
}

impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: generate_node_id(),
            name: format!("Default ({})", default_node_name()),
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                user: String::new(),
                key_path: "~/.ssh/id_ed25519".to_string(),
                local_port: 18789,
                remote_port: 18789,
            },
            gateway_token: String::new(),
            node_name: default_node_name(),
            node_id: generate_node_id(),
            cdp_port: 9222,
            cdp_remote_port: 19222,
            created_at: chrono_now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub profiles: Vec<ConnectionProfile>,
    pub active_profile_id: Option<String>,
    pub runtime: RuntimeConfig,
    pub global_allow: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        let profile = ConnectionProfile::default();
        let id = profile.id.clone();
        Self {
            profiles: vec![profile],
            active_profile_id: Some(id),
            runtime: RuntimeConfig {
                heartbeat_interval_sec: 15,
                reconnect_interval_sec: 5,
            },
            global_allow: true,
        }
    }
}

fn chrono_now() -> String {
    // Simple ISO-ish timestamp without external crate
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
```

Update `load_config()` to handle migration:

```rust
/// Old single-server config format for migration
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAppConfig {
    server: ServerConfig,
    runtime: RuntimeConfig,
    global_allow: bool,
    #[serde(default)]
    gateway_token: String,
    #[serde(default = "generate_node_id")]
    node_id: String,
    #[serde(default = "default_node_name")]
    node_name: String,
    #[serde(default = "default_cdp_port")]
    cdp_port: u16,
    #[serde(default = "default_cdp_remote_port")]
    cdp_remote_port: u16,
}

pub fn load_config(path: &Path) -> Result<AppConfig, String> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read config {}: {err}", path.display()))?;

    // Try new format first
    if let Ok(cfg) = serde_json::from_str::<AppConfig>(&content) {
        return Ok(cfg);
    }

    // Try legacy format and migrate
    let legacy: LegacyAppConfig = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse config {}: {err}", path.display()))?;

    let profile = ConnectionProfile {
        id: generate_node_id(),
        name: legacy.node_name.clone(),
        server: legacy.server,
        gateway_token: legacy.gateway_token,
        node_name: legacy.node_name,
        node_id: legacy.node_id,
        cdp_port: legacy.cdp_port,
        cdp_remote_port: legacy.cdp_remote_port,
        created_at: chrono_now(),
    };
    let id = profile.id.clone();

    Ok(AppConfig {
        profiles: vec![profile],
        active_profile_id: Some(id),
        runtime: legacy.runtime,
        global_allow: legacy.global_allow,
    })
}
```

`save_config()` stays the same (it serializes `AppConfig`).

**Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All 3 config tests pass.

**Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/tests/config_test.rs
git commit -m "feat: multi-profile config model with migration"
```

---

### Task 2: Add `detect_local_gateway` command — Rust backend

**Files:**
- Modify: `src-tauri/src/lib.rs` (add command + register)

**Step 1: Implement `detect_local_gateway` command**

Add after `open_url` command in `lib.rs`:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectGatewayResult {
    token: String,
    port: u16,
}

#[tauri::command]
fn detect_local_gateway() -> Result<DetectGatewayResult, String> {
    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let path = home.join(".openclaw").join("openclaw.json");
    if !path.exists() {
        return Err("~/.openclaw/openclaw.json not found".to_string());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read openclaw.json: {e}"))?;
    let val: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse openclaw.json: {e}"))?;
    let token = val.pointer("/gateway/auth/token")
        .and_then(|v| v.as_str())
        .ok_or("gateway.auth.token not found in openclaw.json")?
        .to_string();
    let port = val.pointer("/gateway/port")
        .and_then(|v| v.as_u64())
        .unwrap_or(18789) as u16;
    Ok(DetectGatewayResult { token, port })
}
```

Add `dirs` dependency to `Cargo.toml`:
```toml
dirs = "6"
```

Register in `run()`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing ...
    detect_local_gateway,
])
```

**Step 2: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully.

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add detect_local_gateway command"
```

---

### Task 3: Refactor `connect()` to use `profile_id` — Rust backend

**Files:**
- Modify: `src-tauri/src/lib.rs` (lines 64-283: `connect()` function)

**Step 1: Change `connect()` signature**

Replace the current parameters (lines 66-74):

```rust
#[tauri::command]
fn connect(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: String,
    force: Option<bool>,
) -> Result<ssh_tunnel::TunnelStatus, String> {
    // Load config and find profile
    let config_path = config_path(&app_handle)?;
    let app_config = config::load_config(&config_path)?;
    let profile = app_config
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("profile not found: {profile_id}"))?;

    let server = profile.server.clone();
    let gateway_token = profile.gateway_token.clone();
    let node_id = profile.node_id.clone();
    let node_name = profile.node_name.clone();

    // ... rest of connect() remains identical, uses server/gateway_token/node_id/node_name ...
```

All references to `server`, `gateway_token`, `node_id`, `node_name` in the body stay the same — they're now local variables extracted from the profile.

**Step 2: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: Compiles successfully.

**Step 3: Run backend tests**

Run: `cd src-tauri && cargo test`
Expected: All pass. (connect() isn't unit-tested directly.)

**Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor: connect() takes profile_id instead of individual fields"
```

---

### Task 4: Update TypeScript types — `config.ts`

**Files:**
- Modify: `src/types/config.ts`

**Step 1: Replace `ConnectorConfig` with new types**

Keep `ServerConfig` and `RuntimeConfig`. Replace lines 14-45:

```typescript
export interface ConnectionProfile {
  id: string;
  name: string;
  server: ServerConfig;
  gatewayToken: string;
  nodeName: string;
  nodeId: string;
  cdpPort: number;
  cdpRemotePort: number;
  createdAt: string;
}

export interface AppConfig {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  runtime: RuntimeConfig;
  globalAllow: boolean;
}

export function createDefaultProfile(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "",
    server: {
      host: "",
      user: "",
      keyPath: "~/.ssh/id_ed25519",
      localPort: 18789,
      remotePort: 18789,
    },
    gatewayToken: "",
    nodeName: "OpenClaw Connector",
    nodeId: crypto.randomUUID(),
    cdpPort: 9222,
    cdpRemotePort: 19222,
    createdAt: new Date().toISOString(),
  };
}

export function createDefaultConfig(): AppConfig {
  const profile = createDefaultProfile();
  return {
    profiles: [profile],
    activeProfileId: profile.id,
    runtime: {
      heartbeatIntervalSec: 15,
      reconnectIntervalSec: 5,
    },
    globalAllow: true,
  };
}
```

**Step 2: Commit**

```bash
git add src/types/config.ts
git commit -m "feat: TypeScript types for multi-profile AppConfig"
```

---

### Task 5: Refactor `useConfigStore` + create `useProfileStore`

**Files:**
- Modify: `src/store/useConfigStore.ts`
- Create: `src/store/useProfileStore.ts`

**Step 1: Rewrite `useConfigStore.ts`**

Now stores `AppConfig` (with profiles inside it). The store keeps the full AppConfig for serialization, but profile CRUD helpers live in `useProfileStore`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createDefaultConfig, type AppConfig } from "../types/config";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(cfg: AppConfig) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_app_config", { cfg }).catch((err) => {
      console.error("[config] auto-save failed:", err);
    });
  }, 300);
}

type ConfigState = {
  config: AppConfig;
  loaded: boolean;
  setConfig: (config: AppConfig) => void;
  patchConfig: (patch: Partial<AppConfig>) => void;
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
      runtime: { ...prev.runtime, ...(patch.runtime ?? {}) },
    };
    set({ config: next });
    debouncedSave(next);
  },
}));
```

**Step 2: Create `useProfileStore.ts`**

```typescript
import { useConfigStore } from "./useConfigStore";
import {
  createDefaultProfile,
  type ConnectionProfile,
} from "../types/config";

// Derived helpers — these read/write through useConfigStore

export function getProfiles(): ConnectionProfile[] {
  return useConfigStore.getState().config.profiles;
}

export function getActiveProfile(): ConnectionProfile | null {
  const { profiles, activeProfileId } = useConfigStore.getState().config;
  if (!activeProfileId) return profiles[0] ?? null;
  return profiles.find((p) => p.id === activeProfileId) ?? null;
}

export function addProfile(profile: ConnectionProfile) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  store.setConfig({
    ...cfg,
    profiles: [...cfg.profiles, profile],
    activeProfileId: profile.id,
  });
}

export function updateProfile(
  id: string,
  patch: Partial<ConnectionProfile>,
) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  store.setConfig({
    ...cfg,
    profiles: cfg.profiles.map((p) =>
      p.id === id ? { ...p, ...patch, server: { ...p.server, ...(patch.server ?? {}) } } : p,
    ),
  });
}

export function removeProfile(id: string) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  const remaining = cfg.profiles.filter((p) => p.id !== id);
  store.setConfig({
    ...cfg,
    profiles: remaining,
    activeProfileId:
      cfg.activeProfileId === id
        ? remaining[0]?.id ?? null
        : cfg.activeProfileId,
  });
}

export function setActiveProfileId(id: string | null) {
  const store = useConfigStore.getState();
  store.patchConfig({ activeProfileId: id });
}

export { createDefaultProfile };
```

**Step 3: Commit**

```bash
git add src/store/useConfigStore.ts src/store/useProfileStore.ts
git commit -m "feat: useProfileStore for multi-profile CRUD"
```

---

### Task 6: Add i18n strings for profiles

**Files:**
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`

**Step 1: Add profile section to zh.json**

Add after `"connection"` section:

```json
"profile": {
  "sidebar_title": "连接配置",
  "new": "新建连接",
  "select_hint": "选择或新建一个连接配置",
  "name": "配置名称",
  "name_placeholder": "例：我的 OpenClaw",
  "save": "保存",
  "cancel": "取消",
  "edit": "编辑",
  "delete": "删除",
  "confirm_delete": "确定删除配置「{{name}}」？",
  "advanced": "高级设置",
  "auto_detected": "已自动检测本地 Gateway",
  "detect_failed": "未检测到本地 Gateway，请手动填写",
  "detecting": "检测本地 Gateway...",
  "creating": "创建配置中..."
}
```

**Step 2: Add profile section to en.json**

```json
"profile": {
  "sidebar_title": "Profiles",
  "new": "New Connection",
  "select_hint": "Select or create a connection profile",
  "name": "Profile Name",
  "name_placeholder": "e.g. My OpenClaw",
  "save": "Save",
  "cancel": "Cancel",
  "edit": "Edit",
  "delete": "Delete",
  "confirm_delete": "Delete profile \"{{name}}\"?",
  "advanced": "Advanced Settings",
  "auto_detected": "Local Gateway auto-detected",
  "detect_failed": "No local Gateway found, enter manually",
  "detecting": "Detecting local Gateway...",
  "creating": "Creating profile..."
}
```

**Step 3: Commit**

```bash
git add src/i18n/zh.json src/i18n/en.json
git commit -m "feat: i18n strings for profile management"
```

---

### Task 7: Create `ProfileSidebar` component

**Files:**
- Create: `src/components/ProfileSidebar.tsx`

**Step 1: Build the sidebar**

```typescript
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/useConfigStore";
import {
  getProfiles,
  removeProfile,
  setActiveProfileId,
} from "../store/useProfileStore";
import { Button } from "./ui/button";
import { Plus, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../types/config";

type Props = {
  onNewProfile: () => void;
  connectedProfileId: string | null;
};

export function ProfileSidebar({ onNewProfile, connectedProfileId }: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const profiles = config.profiles;
  const activeId = config.activeProfileId;

  const handleSelect = (id: string) => {
    setActiveProfileId(id);
  };

  const handleDelete = (e: React.MouseEvent, profile: ConnectionProfile) => {
    e.stopPropagation();
    if (profiles.length <= 1) return;
    if (!confirm(t("profile.confirm_delete", { name: profile.name }))) return;
    removeProfile(profile.id);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">
          {t("profile.sidebar_title")}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onNewProfile}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {profiles.map((profile) => {
          const isActive = profile.id === activeId;
          const isConnected = profile.id === connectedProfileId;
          return (
            <button
              key={profile.id}
              onClick={() => handleSelect(profile.id)}
              className={`w-full text-left rounded-lg p-3 transition-colors cursor-pointer border ${
                isActive
                  ? "bg-accent border-primary/30"
                  : "bg-background border-transparent hover:bg-accent/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isConnected
                      ? "bg-green-500"
                      : "bg-muted-foreground/30"
                  }`}
                />
                <span className="font-medium text-sm text-foreground truncate">
                  {profile.name || profile.server.host || "Unnamed"}
                </span>
                {profiles.length > 1 && (
                  <button
                    onClick={(e) => handleDelete(e, profile)}
                    className="ml-auto opacity-0 group-hover:opacity-100 hover:text-destructive p-1 rounded transition-opacity"
                    style={{ opacity: isActive ? 0.6 : 0 }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = "1"; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = isActive ? "0.6" : "0"; }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate pl-4">
                {profile.server.user && profile.server.host
                  ? `${profile.server.user}@${profile.server.host}`
                  : profile.server.host || "未配置"}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/ProfileSidebar.tsx
git commit -m "feat: ProfileSidebar component"
```

---

### Task 8: Create `ProfileDetail` component (form + connect)

**Files:**
- Create: `src/components/ProfileDetail.tsx`

This is the largest component. It takes most of the logic from `ConnectionPage.tsx` (the connection form, connect/disconnect, browser, agents, activity) but scoped to the active profile.

**Step 1: Build ProfileDetail**

This component receives the active profile and renders:
- Profile header with name + edit/delete + status
- Connection form (read-only by default, editable in edit mode)
- Connect/disconnect buttons
- Browser CDP section (after connected)
- Agent notification panel (after connected)
- Activity log

Extract the existing logic from `ConnectionPage.tsx` lines 55-770 into this component. Key changes:
- Profile fields (server, gatewayToken, nodeName, cdpPort, cdpRemotePort) come from the active profile via `useConfigStore`
- `connect()` now calls `invoke("connect", { profileId, force })` instead of passing all fields
- `patchConfig` for profile updates calls `updateProfile(profileId, patch)` instead
- The form defaults to read-only; click "Edit" to enable inputs
- An "Advanced Settings" collapsible section hides Key Path, Ports, Node Name

The full code is too long to include inline — it is essentially the existing `ConnectionPage.tsx` with these modifications:
1. Replace `const [server, setServer] = useState(...)` with reading from active profile
2. Replace `const [gatewayToken, ...]` / `const [nodeName, ...]` / `const [cdpPort, ...]` / `const [cdpRemotePort, ...]` with profile-local editing state
3. Replace `invoke("connect", { server, gatewayToken, nodeId, nodeName, force })` with `invoke("connect", { profileId: profile.id, force })`
4. On save/connect, call `updateProfile(profile.id, { server: editedServer, gatewayToken, nodeName, cdpPort, cdpRemotePort })`
5. Wrap Key Path, Remote Port, Local Port, Node Name in a collapsible "Advanced Settings" `<details>` element
6. Add auto-detect: call `invoke("detect_local_gateway")` on mount, pre-fill token + port if found

**Step 2: Commit**

```bash
git add src/components/ProfileDetail.tsx
git commit -m "feat: ProfileDetail component with profile-based connect"
```

---

### Task 9: Create `NewProfileForm` component

**Files:**
- Create: `src/components/NewProfileForm.tsx`

**Step 1: Build the minimal creation form**

```typescript
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { addProfile, createDefaultProfile } from "../store/useProfileStore";
import { CheckCircle2, AlertCircle } from "lucide-react";

type Props = {
  onCreated: (profileId: string) => void;
  onCancel: () => void;
};

export function NewProfileForm({ onCreated, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [detectedToken, setDetectedToken] = useState<string | null>(null);
  const [detectedPort, setDetectedPort] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(true);

  useEffect(() => {
    invoke<{ token: string; port: number }>("detect_local_gateway")
      .then((result) => {
        setDetectedToken(result.token);
        setDetectedPort(result.port);
      })
      .catch(() => {
        // No local gateway found — user fills manually
      })
      .finally(() => setDetecting(false));
  }, []);

  const handleSave = () => {
    if (!name.trim() || !host.trim() || !user.trim()) return;
    const profile = createDefaultProfile();
    profile.name = name.trim();
    profile.server.host = host.trim();
    profile.server.user = user.trim();
    if (detectedToken) profile.gatewayToken = detectedToken;
    if (detectedPort) {
      profile.server.localPort = detectedPort;
      profile.server.remotePort = detectedPort;
    }
    addProfile(profile);
    onCreated(profile.id);
  };

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-lg font-semibold">{t("profile.new")}</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-1.5">
            {t("profile.name")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("profile.name_placeholder")}
            autoFocus
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1.5">
              {t("connection.host")}
            </label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1.5">
              {t("connection.user")}
            </label>
            <Input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
            />
          </div>
        </div>

        {detecting ? (
          <p className="text-sm text-muted-foreground animate-pulse">
            {t("profile.detecting")}
          </p>
        ) : detectedToken ? (
          <div className="flex items-center gap-2 text-sm text-primary">
            <CheckCircle2 className="w-4 h-4" />
            {t("profile.auto_detected")}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="w-4 h-4" />
            {t("profile.detect_failed")}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={!name.trim() || !host.trim() || !user.trim()}>
          {t("profile.save")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("profile.cancel")}
        </Button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/NewProfileForm.tsx
git commit -m "feat: NewProfileForm with auto-detect gateway"
```

---

### Task 10: Rewrite `ConnectionPage` as orchestrator

**Files:**
- Modify: `src/pages/ConnectionPage.tsx`

**Step 1: Rewrite ConnectionPage**

Replace the entire 770-line monolith with a thin orchestrator:

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/useConfigStore";
import { setActiveProfileId } from "../store/useProfileStore";
import { ProfileSidebar } from "../components/ProfileSidebar";
import { ProfileDetail } from "../components/ProfileDetail";
import { NewProfileForm } from "../components/NewProfileForm";

export function ConnectionPage() {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const activeProfile = config.profiles.find(
    (p) => p.id === config.activeProfileId,
  ) ?? null;

  const [mode, setMode] = useState<"view" | "new">("view");
  const [connectedProfileId, setConnectedProfileId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-[280px_1fr] gap-0 border border-border rounded-xl overflow-hidden bg-card min-h-[600px]">
      {/* Left: Sidebar */}
      <div className="border-r border-border bg-muted/30">
        <ProfileSidebar
          onNewProfile={() => setMode("new")}
          connectedProfileId={connectedProfileId}
        />
      </div>

      {/* Right: Detail or New */}
      <div className="overflow-y-auto">
        {mode === "new" ? (
          <NewProfileForm
            onCreated={(id) => {
              setActiveProfileId(id);
              setMode("view");
            }}
            onCancel={() => setMode("view")}
          />
        ) : activeProfile ? (
          <ProfileDetail
            profile={activeProfile}
            onConnected={(id) => setConnectedProfileId(id)}
            onDisconnected={() => setConnectedProfileId(null)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {t("profile.select_hint")}
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/pages/ConnectionPage.tsx
git commit -m "refactor: ConnectionPage as thin orchestrator with sidebar"
```

---

### Task 11: Update `App.tsx` for new config type

**Files:**
- Modify: `src/App.tsx`

**Step 1: Update the type import**

Line 6: Change `ConnectorConfig` to `AppConfig`:

```typescript
import type { AppConfig } from "./types/config";
```

Line 23: Change the cast:

```typescript
if (cfg) setConfig(cfg as AppConfig);
```

**Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "chore: update App.tsx imports for AppConfig type"
```

---

### Task 12: Update tests

**Files:**
- Modify: `src/__tests__/config-store.test.ts`
- Modify: `src/__tests__/connection-page.test.tsx`

**Step 1: Update config-store test**

```typescript
import { createDefaultConfig } from "../types/config";

test("default config has required fields", () => {
  const cfg = createDefaultConfig();
  expect(cfg.profiles.length).toBeGreaterThanOrEqual(1);
  expect(cfg.profiles[0].server.host).toBeDefined();
  expect(typeof cfg.profiles[0].server.localPort).toBe("number");
  expect(cfg.profiles[0].nodeId).toBeDefined();
  expect(cfg.profiles[0].gatewayToken).toBe("");
  expect(cfg.activeProfileId).toBeTruthy();
});
```

**Step 2: Update connection-page test**

The new ConnectionPage renders ProfileSidebar + ProfileDetail. Update the test to interact with the profile-based UI. The connect command now takes `profileId`:

```typescript
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConnectionPage } from "../pages/ConnectionPage";
import { invoke } from "@tauri-apps/api/core";
import "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "detect_local_gateway") {
      return Promise.reject("not found");
    }
    return Promise.resolve({
      tunnelState: "disconnected",
      wsConnected: false,
    });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: { transformCallback: vi.fn() },
});

test("renders profile sidebar and detail", () => {
  render(<ConnectionPage />);
  // Default profile is shown in sidebar
  expect(screen.getByText("连接配置")).toBeInTheDocument();
});
```

**Step 3: Run all frontend tests**

Run: `pnpm vitest run`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/__tests__/config-store.test.ts src/__tests__/connection-page.test.tsx
git commit -m "test: update tests for multi-profile structure"
```

---

### Task 13: Run full integration check

**Step 1: Backend tests**

Run: `cd src-tauri && cargo test`
Expected: All pass.

**Step 2: Frontend tests**

Run: `pnpm vitest run`
Expected: All pass.

**Step 3: Type check**

Run: `pnpm tsc --noEmit`
Expected: No errors.

**Step 4: Dev server smoke test**

Run: `pnpm tauri dev`
Expected: App starts, shows left sidebar with default profile, right panel shows connection form.

---

### Task 14: Final commit and version bump

**Step 1: Bump version**

In `src-tauri/Cargo.toml` change `version = "0.2.0"` → `"0.3.0"`.
In `src-tauri/tauri.conf.json` change `"version": "0.2.0"` → `"0.3.0"`.

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: multi-profile connection management with auto-detect"
```
