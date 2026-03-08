# WebSocket Node Architecture Redesign

**Date**: 2026-03-06
**Status**: Approved

## Problem

The connector was built as an active tool where users manually execute commands. The correct architecture is a **passive Node** that connects to the OpenClaw Gateway via WebSocket and receives/executes tasks dispatched by the Gateway.

## Architecture

```
Mac Connector (Tauri)
  React UI (状态展示) ←→ Tauri IPC ←→ Rust Core
                                        ↓
                                   ws_client.rs (WebSocket客户端)
                                        ↓
                                   ssh_tunnel.rs (SSH端口转发)
                                        ↓ SSH隧道
Linux Gateway Server (127.0.0.1:18789, WebSocket JSON-RPC)
```

## Connection Flow

1. User configures SSH info + Gateway Token in UI
2. Click "连接" → SSH tunnel established (localhost:localPort → gateway:18789)
3. SSH success → auto-start WebSocket client to ws://localhost:{localPort}
4. WebSocket handshake: send Node identity + Gateway Token
5. Gateway registers Node → Mac passively waits for tasks
6. Gateway pushes tasks → Node executes → results returned

## Rust Module Changes

### Keep unchanged
- `executor.rs` - system.run execution
- `tasks.rs` - IncomingTask struct (reused as WebSocket message body)
- `health.rs` - HealthStatus enum

### Modify
- `ssh_tunnel.rs` - trigger WebSocket start on connect success
- `heartbeat.rs` - track WebSocket state instead of tunnel-only
- `config.rs` - add `gateway_token` field
- `lib.rs` - rewrite: remove bindings/execute_task/run_command, add ws control commands

### Add
- `ws_client.rs` - tokio-tungstenite WebSocket client (connect, auth, message loop, reconnect)

### Delete
- `bindings.rs` - Gateway manages bindings, not Node
- `emergency.rs` - merged into disconnect

## Frontend Changes

3 tabs (down from 5):
- **连接** (ConnectionPage) - SSH config + Gateway Token + connect/disconnect
- **状态** (StatusPage) - SSH + WebSocket status, recent task summary
- **活动** (ActivityPage) - Timeline of connection events and task execution logs

Deleted pages: BindingsPage, DangerPage

## Data Flow

Gateway → WebSocket → Rust WsClient → tauri::emit → React UI → Zustand store

## Implementation Steps

1. Add tokio + tokio-tungstenite dependencies
2. Implement ws_client.rs (connect, auth, message loop, reconnect)
3. Modify lib.rs (new connect/disconnect commands)
4. Modify config.rs (add gateway_token)
5. Frontend: 3-tab layout, ConnectionPage + Token, remove BindingsPage/DangerPage
6. Event push: Rust → tauri::emit → React listener
7. Testing: ws_client unit tests + manual Gateway verification
