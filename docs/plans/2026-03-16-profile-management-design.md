# Multi-Profile Connection Management Design

Date: 2026-03-16

## Problem

当前 OpenClaw Connector 要求用户手动填写 7 个字段（Host、User、Node Name、Gateway Token、Key Path、Remote Port、Local Port）才能建立连接。只支持单配置，无法保存多个 Gateway 环境。产品定位扩展后，Connector 不仅连接自己的 Gateway，也需要连接他人的 Gateway，需要便捷的多配置管理能力。

## Decision

采用**左右分栏 + Profile 列表**方案。左侧 Profile 侧边栏，右侧连接操作区。新建连接只需填 3 个字段（名称 + Host + User），其余自动检测或使用默认值。

## Data Model

### ConnectionProfile

```typescript
interface ConnectionProfile {
  id: string;              // uuid, 创建时生成
  name: string;            // 用户自定义名称, e.g. "我的 OpenClaw" / "小王的 Gateway"
  server: {
    host: string;          // SSH host
    user: string;          // SSH user
    keyPath: string;       // 默认 ~/.ssh/id_ed25519
    localPort: number;     // 默认 18789
    remotePort: number;    // 默认 18789
  };
  gatewayToken: string;
  nodeName: string;        // 默认 "OpenClaw Connector (macOS)"
  nodeId: string;          // uuid, 每个 Profile 独立
  cdpPort: number;         // 默认 9222
  cdpRemotePort: number;   // 默认 19222
  createdAt: string;       // ISO timestamp
}
```

### AppConfig (new)

```typescript
interface AppConfig {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  runtime: RuntimeConfig;    // 全局: heartbeatIntervalSec, reconnectIntervalSec
  globalAllow: boolean;
}
```

### Rust (config.rs) equivalent

```rust
struct ConnectionProfile {
    id: String,
    name: String,
    server: ServerConfig,
    gateway_token: String,
    node_name: String,
    node_id: String,
    cdp_port: u16,
    cdp_remote_port: u16,
    created_at: String,
}

struct AppConfig {
    profiles: Vec<ConnectionProfile>,
    active_profile_id: Option<String>,
    runtime: RuntimeConfig,
    global_allow: bool,
}
```

## UI Layout

```
App
├── Header (unchanged)
└── Main Area (left-right split)
    ├── Left Panel (280px, fixed)
    │   ├── Profile Card list
    │   │   └── Each card: status dot + name + user@host
    │   └── "+ 新建连接" button
    │
    └── Right Panel (flex)
        ├── No selection: empty state "选择或新建一个连接配置"
        └── Selected profile:
            ├── Header: name + edit/delete + status badge + connect/disconnect
            ├── Connection form (read-only by default, editable in edit mode)
            │   ├── Basic: Host, User (one row)
            │   ├── Token (auto-detected or manual)
            │   └── Advanced (collapsed): Key Path, Ports, Node Name
            ├── Browser CDP section (shown after connected)
            └── Agent notification + Activity Log (shown after connected)
```

### New Profile Flow

1. Click "+ 新建连接"
2. Right panel switches to creation form
3. Fill: **名称**, **Host**, **User** (3 fields only)
4. Token auto-detected from `~/.openclaw/openclaw.json` → `gateway.auth.token`
5. Port auto-detected from `~/.openclaw/openclaw.json` → `gateway.port`
6. "Save" → profile added to list → auto-selected
7. "Connect" → SSH tunnel + WS

### Profile Card

```
┌──────────────────────────┐
│ ● 我的 OpenClaw           │ ← status dot + name
│   root@192.168.16.30      │ ← user@host, muted
└──────────────────────────┘
```

## Backend Changes

### config.rs

- New `ConnectionProfile` struct replacing inline server/token/node fields
- `AppConfig` becomes `profiles: Vec<ConnectionProfile>` + `active_profile_id`
- Migration: detect old format (has `server` but no `profiles`), convert to single profile

### New Tauri command: `detect_local_gateway`

- Reads `~/.openclaw/openclaw.json` from the local machine
- Extracts `gateway.auth.token` and `gateway.port`
- Returns `{ token: String, port: u16 }` or error

### Modified commands

- `connect` → receives `profile_id: String`, looks up profile from config
- `save_app_config` / `load_app_config` → new AppConfig structure

## Frontend Changes

### New: `useProfileStore`

```typescript
type ProfileState = {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  setProfiles: (profiles: ConnectionProfile[]) => void;
  addProfile: (profile: ConnectionProfile) => void;
  updateProfile: (id: string, patch: Partial<ConnectionProfile>) => void;
  removeProfile: (id: string) => void;
  setActive: (id: string | null) => void;
};
```

### New components

- `ProfileSidebar` — left panel with profile list + new button
- `ProfileDetail` — right panel with form + connect/browser/agents/activity

### Refactored: ConnectionPage

Split from monolithic 770-line component into:
- `ConnectionPage` → orchestrator with left-right layout
- `ProfileSidebar` → profile list CRUD
- `ProfileDetail` → selected profile's connection UI (form, browser, agents, activity)

### Simplified: useConfigStore

Only holds runtime + globalAllow. Profile data moves to useProfileStore.

## Migration Strategy

On `load_app_config`:
1. Attempt to deserialize as new format
2. If fails, attempt old format → convert to new format with one profile
3. Save in new format

## Testing

### Frontend
- Profile CRUD (create, edit, delete, switch)
- Old config migration (single → multi)
- Auto-detect token UI feedback

### Backend
- `detect_local_gateway` with valid/invalid/missing openclaw.json
- Config migration: old → new format
- New config serialization/deserialization
