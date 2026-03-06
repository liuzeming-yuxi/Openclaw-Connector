pub mod bindings;
pub mod config;
pub mod emergency;
pub mod executor;
pub mod health;
pub mod heartbeat;
pub mod ssh_tunnel;
pub mod tasks;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

struct AppState {
    tunnel: Mutex<ssh_tunnel::TunnelManager>,
    bindings: Mutex<bindings::BindingMap>,
    task_loop: Mutex<tasks::TaskLoopControl>,
    heartbeat: Mutex<heartbeat::HeartbeatMonitor>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tunnel: Mutex::new(ssh_tunnel::TunnelManager::new()),
            bindings: Mutex::new(bindings::BindingMap::default()),
            task_loop: Mutex::new(tasks::TaskLoopControl::new()),
            heartbeat: Mutex::new(heartbeat::HeartbeatMonitor::new(3)),
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

#[tauri::command]
fn start_tunnel(
    state: tauri::State<'_, AppState>,
    server: config::ServerConfig,
) -> Result<ssh_tunnel::TunnelStatus, String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;

    eprintln!(
        "[connector] start_tunnel host={} user={} local_port={} remote_port={}",
        server.host, server.user, server.local_port, server.remote_port
    );
    match tunnel.start(server) {
        Ok(()) => {
            let status = tunnel.refresh_status();
            eprintln!("[connector] start_tunnel success state={:?}", status.state);
            if let Ok(mut hb) = state.heartbeat.lock() {
                hb.record_sample(health::HeartbeatSample {
                    latency_ms: 0,
                    tunnel_connected: true,
                    gateway_ok: true,
                });
            }
            Ok(status)
        }
        Err(err) => {
            eprintln!("[connector] start_tunnel failed: {err}");
            if let Ok(mut hb) = state.heartbeat.lock() {
                hb.record_failure();
            }
            Err(err)
        }
    }
}

#[tauri::command]
fn stop_tunnel(state: tauri::State<'_, AppState>) -> Result<ssh_tunnel::TunnelStatus, String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;

    eprintln!("[connector] stop_tunnel");
    tunnel.stop()?;
    let status = tunnel.refresh_status();
    eprintln!("[connector] stop_tunnel state={:?}", status.state);
    Ok(status)
}

#[tauri::command]
fn get_tunnel_status(state: tauri::State<'_, AppState>) -> Result<ssh_tunnel::TunnelStatus, String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;
    Ok(tunnel.refresh_status())
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
    let heartbeat = state
        .heartbeat
        .lock()
        .map_err(|_| "failed to acquire heartbeat lock".to_string())?;

    let status = tunnel.refresh_status();
    let connected = status.state == ssh_tunnel::TunnelState::Connected;

    Ok(HealthSummaryResponse {
        latency_ms: 0,
        tunnel_connected: connected,
        gateway_ok: connected,
        consecutive_failures: heartbeat.consecutive_failures(),
    })
}

#[tauri::command]
fn set_agent_binding(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    node_id: String,
) -> Result<(), String> {
    state
        .bindings
        .lock()
        .map_err(|_| "failed to acquire bindings lock".to_string())?
        .set(agent_id, node_id);
    Ok(())
}

#[tauri::command]
fn remove_agent_binding(state: tauri::State<'_, AppState>, agent_id: String) -> Result<(), String> {
    state
        .bindings
        .lock()
        .map_err(|_| "failed to acquire bindings lock".to_string())?
        .remove(&agent_id);
    Ok(())
}

#[tauri::command]
fn list_agent_bindings(state: tauri::State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let map = state
        .bindings
        .lock()
        .map_err(|_| "failed to acquire bindings lock".to_string())?
        .all();
    Ok(map)
}

#[tauri::command]
fn execute_task(
    state: tauri::State<'_, AppState>,
    local_node_id: String,
    task: tasks::IncomingTask,
) -> Result<executor::TaskExecutionOutput, String> {
    let bindings = state
        .bindings
        .lock()
        .map_err(|_| "failed to acquire bindings lock".to_string())?
        .clone();

    let router = tasks::TaskRouter::new(local_node_id);
    if !router.should_execute(&task, &bindings) {
        return Err(format!(
            "task {} ignored because agent {} is not bound to this node",
            task.task_id, task.agent_id
        ));
    }

    let executor = executor::TaskExecutor::new();
    executor.execute(&task)
}

/// MVP simplified command: run a shell command directly, no binding check.
#[tauri::command]
fn run_command(command: String) -> Result<executor::TaskExecutionOutput, String> {
    let task = tasks::IncomingTask {
        task_id: String::new(),
        agent_id: String::new(),
        action: "system.run".to_string(),
        args: serde_json::json!({ "command": command }),
        timeout_sec: 30,
    };
    let executor = executor::TaskExecutor::new();
    executor.execute(&task)
}

#[tauri::command]
fn emergency_disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut tunnel = state
        .tunnel
        .lock()
        .map_err(|_| "failed to acquire tunnel lock".to_string())?;
    let mut task_loop = state
        .task_loop
        .lock()
        .map_err(|_| "failed to acquire task loop lock".to_string())?;

    emergency::emergency_disconnect_internal(&mut tunnel, &mut task_loop)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_app_config,
            save_app_config,
            start_tunnel,
            stop_tunnel,
            get_tunnel_status,
            get_health_summary,
            set_agent_binding,
            remove_agent_binding,
            list_agent_bindings,
            execute_task,
            run_command,
            emergency_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
