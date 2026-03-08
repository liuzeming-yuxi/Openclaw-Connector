# Selective Agent Notification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to browse Gateway agents/sessions in the Connector app, selectively notify specific sessions that a local node is available via `chat.inject`, and auto-notify on disconnect.

**Architecture:** Add a bidirectional RPC channel to the existing WebSocket connection so the frontend can call Gateway APIs (`agents.list`, `sessions.list`, `chat.inject`) through the already-authenticated node-host connection. The Connector UI shows agents/sessions when connected, lets the user select sessions to notify, and sends disconnect notifications before tearing down the tunnel.

**Tech Stack:** Rust (tokio mpsc + oneshot channels), Tauri 2 async commands, React 19 + Zustand 5

---

## Task 1: Add RPC Request/Response Infrastructure to ws_client.rs

**Files:**
- Modify: `apps/connector/src-tauri/src/ws_client.rs`

### Step 1: Add imports and RpcRequest struct

Add `HashMap` import and the public `RpcRequest` type after `ReqIdGen`:

```rust
// At top, add:
use std::collections::HashMap;

// After ReqIdGen (line 52), add:
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
    pub response_tx: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
}
```

### Step 2: Add `rpc_rx` parameter to `run_ws_loop`

Change the function signature to accept a mutable reference to an RPC receiver:

```rust
pub async fn run_ws_loop(
    ws_url: &str,
    gateway_token: &str,
    node_id: &str,
    node_name: &str,
    identity: &DeviceIdentity,
    event_tx: mpsc::UnboundedSender<NodeEvent>,
    rpc_rx: &mut mpsc::UnboundedReceiver<RpcRequest>,  // NEW
    ws_connected: Arc<Mutex<bool>>,
) -> Result<(), String> {
```

### Step 3: Remove `#[allow(dead_code)]` from ResponseFrame.payload

The `payload` field will now be used for RPC responses:

```rust
#[derive(Debug, Deserialize)]
struct ResponseFrame {
    id: String,
    ok: bool,
    payload: Option<serde_json::Value>,  // remove #[allow(dead_code)]
    error: Option<serde_json::Value>,
}
```

### Step 4: Restructure main loop with `tokio::select!`

Replace the entire `while let Some(msg_result) = read.next().await { ... }` loop (lines 76–223) and the trailing `Ok(())` (line 225) with a `loop { tokio::select! { ... } }` structure:

```rust
    let mut pending_rpcs: HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>> = HashMap::new();

    loop {
        tokio::select! {
            msg_opt = read.next() => {
                let msg_result = match msg_opt {
                    Some(r) => r,
                    None => break,
                };
                let msg = match msg_result {
                    Ok(m) => m,
                    Err(e) => {
                        if let Ok(mut c) = ws_connected.lock() { *c = false; }
                        let _ = event_tx.send(NodeEvent::Disconnected { reason: format!("{e}") });
                        for (_, tx) in pending_rpcs.drain() {
                            let _ = tx.send(Err("WebSocket connection lost".to_string()));
                        }
                        return Err(format!("WebSocket read error: {e}"));
                    }
                };

                match msg {
                    Message::Text(text) => {
                        // ... (existing envelope parsing + event/res handling)
                        // IMPORTANT: in the "res" branch, check pending_rpcs BEFORE
                        // the auth handler — see Step 5 below
                    }
                    Message::Close(_) => {
                        if let Ok(mut c) = ws_connected.lock() { *c = false; }
                        let _ = event_tx.send(NodeEvent::Disconnected {
                            reason: "server closed connection".to_string(),
                        });
                        break;
                    }
                    Message::Ping(data) => {
                        let _ = write.send(Message::Pong(data)).await;
                    }
                    _ => {}
                }
            }
            rpc_req = rpc_rx.recv() => {
                if let Some(req) = rpc_req {
                    let outgoing = serde_json::json!({
                        "type": "req",
                        "id": req.id,
                        "method": req.method,
                        "params": req.params,
                    });
                    if let Err(e) = write.send(Message::Text(outgoing.to_string().into())).await {
                        let _ = req.response_tx.send(Err(format!("WebSocket write error: {e}")));
                    } else {
                        pending_rpcs.insert(req.id, req.response_tx);
                    }
                }
            }
        }
    }

    // Drain pending RPCs on clean exit
    for (_, tx) in pending_rpcs.drain() {
        let _ = tx.send(Err("WebSocket connection closed".to_string()));
    }

    Ok(())
```

### Step 5: Modify "res" handler to route RPC responses

Inside the `"res"` match arm, check `pending_rpcs` BEFORE the auth handler:

```rust
"res" => {
    let frame: ResponseFrame = match serde_json::from_value(envelope.inner) {
        Ok(f) => f,
        Err(_) => continue,
    };

    // Route to pending RPC caller if matched
    if let Some(tx) = pending_rpcs.remove(&frame.id) {
        if frame.ok {
            let _ = tx.send(Ok(frame.payload.unwrap_or(serde_json::Value::Null)));
        } else {
            let err_msg = frame.error
                .as_ref()
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .or_else(|| frame.error.as_ref().and_then(|e| e.as_str()))
                .unwrap_or("unknown error");
            let _ = tx.send(Err(err_msg.to_string()));
        }
    } else if !authenticated {
        // ... existing auth response handling (unchanged)
    }
}
```

### Step 6: Build and verify compilation

Run: `cargo check`
Expected: Compilation succeeds (lib.rs call sites not yet updated — those will be fixed in Task 2)

### Step 7: Commit

```bash
git add apps/connector/src-tauri/src/ws_client.rs
git commit -m "feat(ws_client): add RPC request/response channel for Gateway API calls"
```

---

## Task 2: Wire RPC Channel Through lib.rs and Add Tauri Commands

**Files:**
- Modify: `apps/connector/src-tauri/src/lib.rs`

### Step 1: Add `rpc_tx` to AppState

```rust
struct AppState {
    tunnel: Mutex<ssh_tunnel::TunnelManager>,
    heartbeat: Mutex<heartbeat::HeartbeatMonitor>,
    ws_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    ws_connected: Arc<Mutex<bool>>,
    rpc_tx: Mutex<Option<mpsc::UnboundedSender<ws_client::RpcRequest>>>,  // NEW
}
```

Update `Default`:

```rust
impl Default for AppState {
    fn default() -> Self {
        Self {
            tunnel: Mutex::new(ssh_tunnel::TunnelManager::new()),
            heartbeat: Mutex::new(heartbeat::HeartbeatMonitor::new(3)),
            ws_shutdown: Mutex::new(None),
            ws_connected: Arc::new(Mutex::new(false)),
            rpc_tx: Mutex::new(None),  // NEW
        }
    }
}
```

### Step 2: Create RPC channel in `connect()` and pass to ws_loop

In the `connect` function, after the shutdown_tx/rx creation, add:

```rust
    // Create RPC channel for Gateway API calls
    let (rpc_tx, mut rpc_rx) = mpsc::unbounded_channel::<ws_client::RpcRequest>();
    if let Ok(mut stored_tx) = state.rpc_tx.lock() {
        *stored_tx = Some(rpc_tx);
    }
```

Update the spawned WebSocket loop to pass `&mut rpc_rx`:

```rust
    // Spawn WebSocket loop with auto-reconnect
    let ws_connected = Arc::clone(&app.state::<AppState>().ws_connected);
    tauri::async_runtime::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        loop {
            let event_tx_clone = event_tx.clone();
            let ws_connected_clone = Arc::clone(&ws_connected);

            let ws_future = ws_client::run_ws_loop(
                &ws_url, &gateway_token, &node_id, &node_name, &identity,
                event_tx_clone, &mut rpc_rx, ws_connected_clone,
            );

            tokio::select! {
                result = ws_future => {
                    // ... existing reconnect handling (unchanged)
                }
                _ = &mut shutdown_rx => {
                    // ... existing shutdown handling (unchanged)
                }
            }
        }
    });
```

### Step 3: Clear `rpc_tx` in `disconnect()`

At the top of `disconnect()`, after the ws_shutdown handling:

```rust
    // Clear RPC channel
    if let Ok(mut rpc_tx) = state.rpc_tx.lock() {
        *rpc_tx = None;
    }
```

### Step 4: Add `send_gateway_rpc` async helper

Add this helper function before the Tauri commands:

```rust
async fn send_gateway_rpc(
    rpc_tx: mpsc::UnboundedSender<ws_client::RpcRequest>,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = format!("rpc-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let (response_tx, response_rx) = tokio::sync::oneshot::channel();

    rpc_tx.send(ws_client::RpcRequest {
        id,
        method: method.to_string(),
        params,
        response_tx,
    }).map_err(|_| "WebSocket not connected".to_string())?;

    response_rx.await
        .map_err(|_| "RPC response channel closed".to_string())?
}
```

### Step 5: Add `list_agents` command

```rust
#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let rpc_tx = {
        let guard = state.rpc_tx.lock().map_err(|_| "lock error".to_string())?;
        guard.clone().ok_or_else(|| "not connected".to_string())?
    };
    send_gateway_rpc(rpc_tx, "agents.list", serde_json::json!({})).await
}
```

### Step 6: Add `list_sessions` command

```rust
#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    let rpc_tx = {
        let guard = state.rpc_tx.lock().map_err(|_| "lock error".to_string())?;
        guard.clone().ok_or_else(|| "not connected".to_string())?
    };
    send_gateway_rpc(rpc_tx, "sessions.list", serde_json::json!({ "agentId": agent_id })).await
}
```

### Step 7: Add `inject_message` command

```rust
#[tauri::command]
async fn inject_message(
    state: tauri::State<'_, AppState>,
    session_key: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let rpc_tx = {
        let guard = state.rpc_tx.lock().map_err(|_| "lock error".to_string())?;
        guard.clone().ok_or_else(|| "not connected".to_string())?
    };
    send_gateway_rpc(rpc_tx, "chat.inject", serde_json::json!({
        "sessionKey": session_key,
        "message": content,
    })).await
}
```

### Step 8: Register new commands in `run()`

```rust
.invoke_handler(tauri::generate_handler![
    load_app_config,
    save_app_config,
    connect,
    disconnect,
    get_connection_status,
    get_health_summary,
    open_url,
    list_agents,      // NEW
    list_sessions,     // NEW
    inject_message,    // NEW
])
```

### Step 9: Build and verify

Run: `cargo check`
Expected: Compilation succeeds

### Step 10: Commit

```bash
git add apps/connector/src-tauri/src/lib.rs
git commit -m "feat(lib): add list_agents, list_sessions, inject_message Tauri commands"
```

---

## Task 3: Add Agent/Session Notification UI

**Files:**
- Modify: `apps/connector/src/pages/ConnectionPage.tsx`
- Modify: `apps/connector/src/styles.css`

### Step 1: Add types and state

At the top of `ConnectionPage.tsx`, add types:

```typescript
type AgentInfo = {
  id: string;
  displayName?: string;
};

type SessionInfo = {
  key: string;
  agentId: string;
  displayName?: string;
};
```

Inside the component, add state variables after existing state:

```typescript
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionInfo[]>>({});
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [notifiedSessions, setNotifiedSessions] = useState<Set<string>>(new Set());
  const [loadingAgents, setLoadingAgents] = useState(false);
```

### Step 2: Add `loadAgents` function

```typescript
  const loadAgents = async () => {
    setLoadingAgents(true);
    try {
      const result = await invoke<AgentInfo[]>("list_agents");
      setAgents(Array.isArray(result) ? result : []);
    } catch (err) {
      pushActivity("error", `加载 Agent 列表失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAgents(false);
    }
  };
```

### Step 3: Add `loadSessions` function

```typescript
  const loadSessions = async (agentId: string) => {
    try {
      const result = await invoke<SessionInfo[]>("list_sessions", { agentId });
      const list = Array.isArray(result) ? result : [];
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: list }));
    } catch (err) {
      pushActivity("error", `加载 Session 列表失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
```

### Step 4: Add `toggleNotify` function

```typescript
  const toggleNotify = async (sessionKey: string) => {
    const isNotified = notifiedSessions.has(sessionKey);
    const message = isNotified
      ? `[系统通知] 本地节点 "${nodeName}" 已断开，不再可用。`
      : `[系统通知] 本地节点 "${nodeName}" 已连接。\n- Node ID: ${config.nodeId}\n- 环境: macOS (本地)\n- 能力: 命令执行 (system.run)\n\n当用户的请求需要在本地环境执行时，你可以使用这个节点。`;
    try {
      await invoke("inject_message", { sessionKey, content: message });
      setNotifiedSessions((prev) => {
        const next = new Set(prev);
        if (isNotified) {
          next.delete(sessionKey);
          pushActivity("info", `已取消通知 session [${sessionKey.slice(0, 8)}]`);
        } else {
          next.add(sessionKey);
          pushActivity("info", `已通知 session [${sessionKey.slice(0, 8)}]`);
        }
        return next;
      });
    } catch (err) {
      pushActivity("error", `通知失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
```

### Step 5: Add `toggleAgent` function to expand/collapse and load sessions

```typescript
  const toggleAgent = (agentId: string) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
    } else {
      setExpandedAgent(agentId);
      if (!sessionsByAgent[agentId]) {
        loadSessions(agentId);
      }
    }
  };
```

### Step 6: Update `doDisconnect` to send disconnect notifications

Replace the existing `doDisconnect` function:

```typescript
  const doDisconnect = async () => {
    setBusy(true);
    setError(null);

    // Send disconnect notifications to all notified sessions
    if (notifiedSessions.size > 0) {
      pushActivity("info", `向 ${notifiedSessions.size} 个 session 发送断开通知...`);
      const disconnectMsg = `[系统通知] 本地节点 "${nodeName}" 已断开，不再可用。`;
      for (const sessionKey of notifiedSessions) {
        try {
          await invoke("inject_message", { sessionKey, content: disconnectMsg });
        } catch {}
      }
      setNotifiedSessions(new Set());
    }

    pushActivity("info", "发起断开");
    try {
      await invoke("disconnect");
      setStatus({
        tunnelState: "disconnected",
        tunnelReconnectAttempts: 0,
        tunnelLastError: null,
        wsConnected: false,
      });
      setAgents([]);
      setSessionsByAgent({});
      setExpandedAgent(null);
      pushActivity("info", "已断开");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", `断开失败：${message}`);
    } finally {
      setBusy(false);
    }
  };
```

### Step 7: Add the Agent notification section to JSX

Between the connection form `</section>` and the activity log `<section>`, add:

```tsx
      {/* ── Agent Notification ── */}
      {fullyConnected && (
        <section className="card">
          <div className="card-header">
            <h2>Agent 通知</h2>
            <button
              type="button"
              className="btn btn-small"
              onClick={loadAgents}
              disabled={loadingAgents}
            >
              {loadingAgents ? "加载中..." : "刷新"}
            </button>
          </div>

          {agents.length === 0 ? (
            <p className="hint">
              {loadingAgents ? "正在加载 Agent 列表..." : "点击「刷新」加载 Agent 列表"}
            </p>
          ) : (
            <ul className="list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <div
                    className="list-row agent-row"
                    onClick={() => toggleAgent(agent.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <span className="agent-expand">
                      {expandedAgent === agent.id ? "▼" : "▶"}
                    </span>
                    <span style={{ flex: 1 }}>
                      {agent.displayName || agent.id}
                    </span>
                    <span className="hint" style={{ fontSize: "0.8em" }}>
                      {sessionsByAgent[agent.id]
                        ? `${sessionsByAgent[agent.id].length} sessions`
                        : ""}
                    </span>
                  </div>
                  {expandedAgent === agent.id && (
                    <ul className="session-list">
                      {!sessionsByAgent[agent.id] ? (
                        <li className="list-empty">加载中...</li>
                      ) : sessionsByAgent[agent.id].length === 0 ? (
                        <li className="list-empty">无活跃 Session</li>
                      ) : (
                        sessionsByAgent[agent.id].map((session) => (
                          <li key={session.key} className="list-row session-row">
                            <span style={{ flex: 1 }}>
                              {session.displayName || session.key.slice(0, 12)}
                            </span>
                            <button
                              type="button"
                              className={`btn btn-small ${
                                notifiedSessions.has(session.key)
                                  ? "btn-danger"
                                  : "btn-primary"
                              }`}
                              onClick={() => toggleNotify(session.key)}
                            >
                              {notifiedSessions.has(session.key)
                                ? "取消通知"
                                : "通知"}
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
```

### Step 8: Add CSS styles for the new section

Append to `apps/connector/src/styles.css`:

```css
/* ── Agent Notification ── */
.agent-row {
  font-weight: 500;
  user-select: none;
}
.agent-expand {
  width: 1.2em;
  font-size: 0.75em;
  color: var(--ink-1);
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-row {
  padding-left: 2em;
}
```

### Step 9: Auto-load agents when connected

Add a `useEffect` to auto-load agents when `fullyConnected` becomes true:

```typescript
  useEffect(() => {
    if (fullyConnected && agents.length === 0) {
      loadAgents();
    }
  }, [fullyConnected]);
```

Place this after the status polling effect.

### Step 10: Build and verify

Run: `cd apps/connector && npx tsc --noEmit && cargo check`
Expected: Both TypeScript and Rust compile without errors

### Step 11: Commit

```bash
git add apps/connector/src/pages/ConnectionPage.tsx apps/connector/src/styles.css
git commit -m "feat(ui): add agent/session browsing and chat.inject notification"
```

---

## Task 4: Manual Integration Test

**Files:** None (testing only)

### Step 1: Start the app

Run: `cd apps/connector && cargo tauri dev`

### Step 2: Connect to Gateway

Fill in connection form and click "连接". Wait for "SSH + WebSocket 已连接".

### Step 3: Verify agent list loads automatically

The "Agent 通知" section should appear and auto-load the agent list.

### Step 4: Test session browsing

Click an agent to expand. Sessions should load.

### Step 5: Test notification

Click "通知" on a session. Activity log should show "已通知 session [...]". Check the agent's chat to verify the injected message appeared.

### Step 6: Test disconnect notification

Click "断开". Activity log should show "向 N 个 session 发送断开通知..." before disconnecting.

### Step 7: Verify cleanup

After disconnect, the Agent section should disappear. Reconnect — agent list should re-load fresh.

---

## Task 5: Adjust API Response Parsing (if needed)

**Files:**
- Modify: `apps/connector/src/pages/ConnectionPage.tsx` (if response format differs)
- Modify: `apps/connector/src-tauri/src/lib.rs` (if RPC params format differs)

### Step 1: Check Gateway API response format

If `agents.list` or `sessions.list` returns a wrapped response (e.g., `{ agents: [...] }` instead of `[...]`), update the `loadAgents`/`loadSessions` functions to extract the array from the correct field.

### Step 2: Check `chat.inject` params format

If `chat.inject` expects different params (e.g., `{ sessionKey, messages: [{role, content}] }` instead of `{ sessionKey, message }`), update the `inject_message` command in `lib.rs`.

### Step 3: Iterate until working

This task is a catch-all for any Gateway API format mismatches. Fix, rebuild, retest.

### Step 4: Final commit

```bash
git add -u
git commit -m "fix: adjust Gateway RPC params/response parsing"
```
