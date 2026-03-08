use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingTask {
    pub task_id: String,
    pub agent_id: String,
    pub action: String,
    pub args: Value,
    pub timeout_sec: u64,
}
