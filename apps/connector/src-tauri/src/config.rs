use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub host: String,
    pub user: String,
    pub key_path: String,
    pub local_port: u16,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub heartbeat_interval_sec: u16,
    pub reconnect_interval_sec: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub server: ServerConfig,
    pub runtime: RuntimeConfig,
    pub global_allow: bool,
    #[serde(default)]
    pub gateway_token: String,
    #[serde(default = "generate_node_id")]
    pub node_id: String,
    #[serde(default = "default_node_name")]
    pub node_name: String,
    #[serde(default = "default_cdp_port")]
    pub cdp_port: u16,
    #[serde(default = "default_cdp_remote_port")]
    pub cdp_remote_port: u16,
}

fn generate_node_id() -> String {
    Uuid::new_v4().to_string()
}

fn default_node_name() -> String {
    "OpenClaw Connector (macOS)".to_string()
}

fn default_cdp_port() -> u16 {
    9222
}

fn default_cdp_remote_port() -> u16 {
    19222
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                user: String::new(),
                key_path: "~/.ssh/id_ed25519".to_string(),
                local_port: 18789,
                remote_port: 18789,
            },
            runtime: RuntimeConfig {
                heartbeat_interval_sec: 15,
                reconnect_interval_sec: 5,
            },
            global_allow: true,
            gateway_token: String::new(),
            node_id: generate_node_id(),
            node_name: default_node_name(),
            cdp_port: default_cdp_port(),
            cdp_remote_port: default_cdp_remote_port(),
        }
    }
}

pub fn load_config(path: &Path) -> Result<AppConfig, String> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read config {}: {err}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse config {}: {err}", path.display()))
}

pub fn save_config(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create config dir {}: {err}", parent.display()))?;
    }
    let data = serde_json::to_string_pretty(config)
        .map_err(|err| format!("failed to serialize config: {err}"))?;
    fs::write(path, data)
        .map_err(|err| format!("failed to write config {}: {err}", path.display()))
}
