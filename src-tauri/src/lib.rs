pub mod browser;
pub mod config;
pub mod device_identity;
pub mod executor;
pub mod health;
pub mod heartbeat;
pub mod ssh_tunnel;
pub mod tasks;
pub mod ws_client;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

struct AppState {
    tunnel: Mutex<ssh_tunnel::TunnelManager>,
    heartbeat: Mutex<heartbeat::HeartbeatMonitor>,
    ws_shutdown: Arc<AtomicBool>,
    ws_connected: Arc<Mutex<bool>>,
    ws_latency_ms: Arc<AtomicU64>,
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
            ws_latency_ms: Arc::new(AtomicU64::new(0)),
            rpc_tx: Mutex::new(None),
            browser: Mutex::new(browser::BrowserManager::new()),
            cdp_tunnel: Mutex::new(ssh_tunnel::CdpTunnel::new()),
        }
    }
}

fn config_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|err| format!("failed to get app config dir: {err}"))?;
    Ok(app_dir.join("connector-config.json"))
}

#[tauri::command]
fn load_app_config(app_handle: tauri::AppHandle) -> Result<config::AppConfig, String> {
    let path = config_path(&app_handle)?;
    config::load_config(&path)
}

#[tauri::command]
fn save_app_config(app_handle: tauri::AppHandle, cfg: config::AppConfig) -> Result<(), String> {
    let path = config_path(&app_handle)?;
    config::save_config(&path, &cfg)
}

/// Connect: establish SSH tunnel, then start WebSocket client in background.
#[tauri::command]
fn connect(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server: config::ServerConfig,
    gateway_token: String,
    node_id: String,
    node_name: String,
    force: Option<bool>,
) -> Result<ssh_tunnel::TunnelStatus, String> {
    // Load or create device identity for node-host authentication
    let identity_path = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to get app config dir: {e}"))?
        .join("device-identity.json");
    let identity = device_identity::load_or_create(&identity_path)?;
    eprintln!("[connector] device identity: {}", identity.device_id);

    // 0. Signal any previous WebSocket loops to shut down
    state.ws_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    // Brief pause to let previous loops detect the flag
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Reset for the new connection
    state.ws_shutdown.store(false, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut c) = state.ws_connected.lock() {
        *c = false;
    }

    // 1. Stop previous tunnel then start new one
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;

    // Always stop first to release the local port
    let _ = tunnel.stop();

    eprintln!(
        "[connector] connect host={} user={} local_port={} remote_port={}",
        server.host, server.user, server.local_port, server.remote_port
    );

    // Force-kill port holder if user explicitly confirmed
    if force.unwrap_or(false) && ssh_tunnel::is_port_in_use(server.local_port) {
        eprintln!("[connector] force mode: killing port {} holder", server.local_port);
        ssh_tunnel::kill_port_holder(server.local_port);
    }

    tunnel.start(server.clone())?;
    let status = tunnel.refresh_status();
    eprintln!("[connector] tunnel connected state={:?}", status.state);

    if let Ok(mut hb) = state.heartbeat.lock() {
        hb.record_sample(health::HeartbeatSample {
            latency_ms: 0,
            tunnel_connected: true,
            gateway_ok: false,
        });
    }

    // 2. Start WebSocket client in background
    let ws_url = ws_client::build_ws_url(server.local_port);

    // RPC channel for management calls (operator WebSocket)
    let (rpc_tx, mut operator_rpc_rx) = mpsc::unbounded_channel::<ws_client::RpcRequest>();
    if let Ok(mut stored_tx) = state.rpc_tx.lock() {
        *stored_tx = Some(rpc_tx);
    }

    // Dummy RPC channel for node WebSocket (not used for management)
    let (_dummy_tx, mut node_rpc_rx) = mpsc::unbounded_channel::<ws_client::RpcRequest>();

    let app = app_handle.clone();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<ws_client::NodeEvent>();

    // Spawn event forwarder: NodeEvent → tauri::emit
    let app_for_events = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = app_for_events.emit("node-event", &event);
        }
    });

    // Spawn operator WebSocket for management API calls
    let operator_ws_url = ws_url.clone();
    let operator_token = gateway_token.clone();
    let local_port = server.local_port;
    let operator_shutdown = Arc::clone(&state.ws_shutdown);
    let app_for_operator = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if operator_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                eprintln!("[connector] Operator WS shutdown, exiting loop");
                break;
            }
            match ws_client::run_operator_loop(&operator_ws_url, local_port, &operator_token, &mut operator_rpc_rx, Arc::clone(&operator_shutdown)).await {
                Ok(()) => eprintln!("[connector] Operator WS closed normally"),
                Err(e) => {
                    eprintln!("[connector] Operator WS error: {e}");
                    let _ = app_for_operator.emit("node-event", &ws_client::NodeEvent::Error {
                        message: format!("Operator WS: {e}"),
                    });
                }
            }
            if operator_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });

    // Spawn node WebSocket loop with auto-reconnect
    let ws_connected = Arc::clone(&app.state::<AppState>().ws_connected);
    let ws_latency = Arc::clone(&app.state::<AppState>().ws_latency_ms);
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
                Arc::clone(&ws_latency),
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

    // Spawn tunnel health monitor for auto-reconnect
    let health_shutdown = Arc::clone(&state.ws_shutdown);
    let health_app = app_handle.clone();
    let health_server = server.clone();
    tauri::async_runtime::spawn(async move {
        let mut was_connected = true;
        let backoffs = [3u64, 6, 12];

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if health_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            let is_connected = {
                let app_state = health_app.state::<AppState>();
                let result = if let Ok(mut t) = app_state.tunnel.lock() {
                    let s = t.refresh_status();
                    s.state == ssh_tunnel::TunnelState::Connected
                } else {
                    false
                };
                result
            };

            if was_connected && !is_connected {
                let _ = health_app.emit("node-event", &ws_client::NodeEvent::Error {
                    message: "tunnel_reconnecting".to_string(),
                });

                let mut reconnected = false;
                for (attempt, delay) in backoffs.iter().enumerate() {
                    if health_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(*delay)).await;

                    let result = {
                        let app_state = health_app.state::<AppState>();
                        let r = if let Ok(mut t) = app_state.tunnel.lock() {
                            t.start(health_server.clone())
                        } else {
                            Err("lock error".to_string())
                        };
                        r
                    };

                    match result {
                        Ok(()) => {
                            let _ = health_app.emit("node-event", &ws_client::NodeEvent::Authenticated);
                            eprintln!("[health] tunnel auto-reconnected on attempt {}", attempt + 1);
                            reconnected = true;
                            break;
                        }
                        Err(e) => {
                            eprintln!("[health] reconnect attempt {} failed: {e}", attempt + 1);
                        }
                    }
                }

                if !reconnected {
                    let _ = health_app.emit("node-event", &ws_client::NodeEvent::Error {
                        message: "tunnel_reconnect_failed".to_string(),
                    });
                }
            }

            was_connected = is_connected;
        }
    });

    Ok(status)
}

/// Disconnect: close WebSocket, then stop SSH tunnel.
#[tauri::command]
fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // 1. Signal all WebSocket loops to shut down
    state.ws_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut connected) = state.ws_connected.lock() {
        *connected = false;
    }

    // Clear RPC channel
    if let Ok(mut rpc_tx) = state.rpc_tx.lock() {
        *rpc_tx = None;
    }

    // Stop CDP tunnel and browser
    if let Ok(mut cdp_tunnel) = state.cdp_tunnel.lock() {
        cdp_tunnel.stop();
    }
    if let Ok(mut browser) = state.browser.lock() {
        let _ = browser.stop();
    }

    // 2. Stop SSH tunnel
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;

    eprintln!("[connector] disconnect");
    tunnel.stop()?;

    if let Ok(mut hb) = state.heartbeat.lock() {
        hb.record_failure();
    }

    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatusResponse {
    tunnel_state: ssh_tunnel::TunnelState,
    tunnel_reconnect_attempts: u32,
    tunnel_last_error: Option<String>,
    ws_connected: bool,
}

#[tauri::command]
fn get_connection_status(
    state: tauri::State<'_, AppState>,
) -> Result<ConnectionStatusResponse, String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;
    let tunnel_status = tunnel.refresh_status();

    let ws_connected = state
        .ws_connected
        .lock()
        .map(|v| *v)
        .unwrap_or(false);

    Ok(ConnectionStatusResponse {
        tunnel_state: tunnel_status.state,
        tunnel_reconnect_attempts: tunnel_status.reconnect_attempts,
        tunnel_last_error: tunnel_status.last_error,
        ws_connected,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthSummaryResponse {
    latency_ms: u64,
    tunnel_connected: bool,
    gateway_ok: bool,
    consecutive_failures: u32,
}

#[tauri::command]
fn get_health_summary(state: tauri::State<'_, AppState>) -> Result<HealthSummaryResponse, String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;
    let mut heartbeat = state
        .heartbeat
        .lock()
        .map_err(|_| "failed to acquire heartbeat lock".to_string())?;

    let status = tunnel.refresh_status();
    let tunnel_connected = status.state == ssh_tunnel::TunnelState::Connected;

    let ws_connected = state
        .ws_connected
        .lock()
        .map(|v| *v)
        .unwrap_or(false);

    let latency_ms = state.ws_latency_ms.load(std::sync::atomic::Ordering::Relaxed);

    // Sync heartbeat with actual connection state so stale failures get cleared
    heartbeat.record_sample(health::HeartbeatSample {
        latency_ms,
        tunnel_connected,
        gateway_ok: ws_connected,
    });

    Ok(HealthSummaryResponse {
        latency_ms,
        tunnel_connected,
        gateway_ok: ws_connected,
        consecutive_failures: heartbeat.consecutive_failures(),
    })
}

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

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let rpc_tx = {
        let guard = state.rpc_tx.lock().map_err(|_| "lock error".to_string())?;
        guard.clone().ok_or_else(|| "not connected".to_string())?
    };
    send_gateway_rpc(rpc_tx, "agents.list", serde_json::json!({})).await
}

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

#[tauri::command]
async fn get_chat_history(
    state: tauri::State<'_, AppState>,
    session_key: String,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let rpc_tx = {
        let guard = state.rpc_tx.lock().map_err(|_| "lock error".to_string())?;
        guard.clone().ok_or_else(|| "not connected".to_string())?
    };
    let mut params = serde_json::json!({ "sessionKey": session_key });
    if let Some(l) = limit {
        params["limit"] = serde_json::json!(l);
    }
    send_gateway_rpc(rpc_tx, "chat.history", params).await
}

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
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cdp_port: Option<u16>,
    cdp_remote_port: Option<u16>,
) -> Result<BrowserStatusResponse, String> {
    let cdp_port = cdp_port.unwrap_or(9222);
    let cdp_remote_port = cdp_remote_port.unwrap_or(19222);

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {e}"))?
        .join("chrome-cdp");

    let mut browser = state.browser.lock().map_err(|_| "browser lock error".to_string())?;
    browser.start(cdp_port, &data_dir)?;

    let tunnel_mgr = state.tunnel.lock().map_err(|_| "tunnel lock error".to_string())?;
    let mut cdp_tunnel = state.cdp_tunnel.lock().map_err(|_| "cdp tunnel lock error".to_string())?;

    if let Some(server) = tunnel_mgr.active_server() {
        if let Err(e) = cdp_tunnel.start(&server, cdp_port, cdp_remote_port) {
            eprintln!("[browser] CDP tunnel failed: {e}");
        }
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
    if let Ok(mut cdp_tunnel) = state.cdp_tunnel.lock() {
        cdp_tunnel.stop();
    }
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
        cdp_remote_port: 0,
        tunnel_running: cdp_tunnel.is_running(),
        pid: bs.pid,
    })
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("failed to open URL: {e}"))
}

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
    let token = val
        .pointer("/gateway/auth/token")
        .and_then(|v| v.as_str())
        .ok_or("gateway.auth.token not found in openclaw.json")?
        .to_string();
    let port = val
        .pointer("/gateway/port")
        .and_then(|v| v.as_u64())
        .unwrap_or(18789) as u16;
    Ok(DetectGatewayResult { token, port })
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_app_config,
            save_app_config,
            connect,
            disconnect,
            get_connection_status,
            get_health_summary,
            open_url,
            detect_local_gateway,
            list_agents,
            list_sessions,
            inject_message,
            get_chat_history,
            start_browser,
            stop_browser,
            get_browser_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
