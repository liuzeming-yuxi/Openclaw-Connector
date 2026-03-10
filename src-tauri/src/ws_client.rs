use crate::device_identity::{self, DeviceIdentity};
use crate::executor::TaskExecutor;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// Events emitted from the WebSocket client to the UI layer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NodeEvent {
    Connected,
    Authenticated,
    Disconnected { reason: String },
    TaskReceived { task_id: String, action: String },
    TaskCompleted { task_id: String, exit_code: i32, duration_ms: u128 },
    TaskFailed { task_id: String, error: String },
    Error { message: String },
}

#[derive(Debug, Deserialize)]
struct WsEnvelope {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(flatten)]
    inner: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct EventFrame {
    event: String,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ResponseFrame {
    id: String,
    ok: bool,
    payload: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

struct ReqIdGen(std::sync::atomic::AtomicU64);
impl ReqIdGen {
    fn new() -> Self { Self(std::sync::atomic::AtomicU64::new(1)) }
    fn next(&self) -> String {
        let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("node-{n}")
    }
}

pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
    pub response_tx: tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>,
}

/// Connect to the Gateway WebSocket and run the Node Host message loop.
#[allow(clippy::too_many_arguments)]
pub async fn run_ws_loop(
    ws_url: &str,
    gateway_token: &str,
    node_id: &str,
    node_name: &str,
    identity: &DeviceIdentity,
    event_tx: mpsc::UnboundedSender<NodeEvent>,
    rpc_rx: &mut mpsc::UnboundedReceiver<RpcRequest>,
    ws_connected: Arc<Mutex<bool>>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    latency: Arc<std::sync::atomic::AtomicU64>,
) -> Result<(), String> {
    let (ws_stream, _response) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let _ = event_tx.send(NodeEvent::Connected);

    let (mut write, mut read) = ws_stream.split();
    let executor = TaskExecutor::new();
    let req_id_gen = ReqIdGen::new();
    let mut authenticated = false;
    let mut connect_req_id: Option<String> = None;

    let mut pending_rpcs: HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>> = HashMap::new();

    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(15));
    ping_interval.tick().await; // skip immediate first tick
    let mut ping_sent_at: Option<tokio::time::Instant> = None;

    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)), if shutdown.load(std::sync::atomic::Ordering::Relaxed) => {
                eprintln!("[ws_client] shutdown flag detected");
                break;
            }
            _ = ping_interval.tick(), if authenticated => {
                ping_sent_at = Some(tokio::time::Instant::now());
                let _ = write.send(Message::Ping(vec![0x01])).await;
            }
            msg_opt = read.next() => {
                let msg_result = match msg_opt {
                    Some(r) => r,
                    None => break, // stream ended
                };

                let msg = match msg_result {
                    Ok(m) => m,
                    Err(e) => {
                        if let Ok(mut c) = ws_connected.lock() { *c = false; }
                        let _ = event_tx.send(NodeEvent::Disconnected { reason: format!("{e}") });
                        for (_, tx) in pending_rpcs.drain() {
                            let _ = tx.send(Err(format!("WebSocket read error: {e}")));
                        }
                        return Err(format!("WebSocket read error: {e}"));
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let envelope: WsEnvelope = match serde_json::from_str(&text) {
                            Ok(e) => e,
                            Err(_) => continue,
                        };

                        match envelope.msg_type.as_str() {
                            "event" => {
                                let frame: EventFrame = match serde_json::from_value(envelope.inner) {
                                    Ok(f) => f,
                                    Err(_) => continue,
                                };

                                if frame.event == "connect.challenge" {
                                    let nonce = frame.payload.as_ref()
                                        .and_then(|p| p.get("nonce"))
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("")
                                        .to_string();

                                    if nonce.is_empty() {
                                        let _ = event_tx.send(NodeEvent::Error {
                                            message: "connect.challenge missing nonce".to_string(),
                                        });
                                        continue;
                                    }

                                    eprintln!("[ws_client] received connect.challenge, sending auth as node-host...");
                                    let connect_req = build_connect_request(gateway_token, node_id, node_name, identity, &nonce);
                                    connect_req_id = connect_req.get("id").and_then(|v| v.as_str()).map(String::from);
                                    if let Err(e) = write.send(Message::Text(connect_req.to_string())).await {
                                        let _ = event_tx.send(NodeEvent::Error {
                                            message: format!("failed to send connect: {e}"),
                                        });
                                    }
                                } else if frame.event == "node.invoke.request" && authenticated {
                                    if let Some(payload) = frame.payload {
                                        let invoke_id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let invoke_node_id = payload.get("nodeId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let command = payload.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();

                                        if invoke_id.is_empty() || command.is_empty() { continue; }

                                        eprintln!("[ws_client] node.invoke.request id={invoke_id} command={command}");
                                        let _ = event_tx.send(NodeEvent::TaskReceived {
                                            task_id: invoke_id.clone(),
                                            action: command.clone(),
                                        });

                                        let params = if let Some(pj) = payload.get("paramsJSON").and_then(|v| v.as_str()) {
                                            serde_json::from_str(pj).unwrap_or(serde_json::Value::Null)
                                        } else {
                                            payload.get("params").cloned().unwrap_or(serde_json::Value::Null)
                                        };

                                        let result = handle_node_invoke(&command, &params, &executor, &event_tx, &invoke_id);

                                        // Gateway expects payloadJSON (string), not payload (object)
                                        let payload_json = result.payload
                                            .as_ref()
                                            .map(|v| serde_json::to_string(v).unwrap_or_default());

                                        let mut result_params = serde_json::json!({
                                            "id": invoke_id,
                                            "nodeId": invoke_node_id,
                                            "ok": result.ok,
                                        });
                                        if let Some(pj) = &payload_json {
                                            result_params["payloadJSON"] = serde_json::Value::String(pj.clone());
                                        }
                                        if let Some(err) = &result.error {
                                            result_params["error"] = err.clone();
                                        }

                                        let result_req = serde_json::json!({
                                            "type": "req",
                                            "id": req_id_gen.next(),
                                            "method": "node.invoke.result",
                                            "params": result_params,
                                        });

                                        if let Err(e) = write.send(Message::Text(result_req.to_string())).await {
                                            let _ = event_tx.send(NodeEvent::Error {
                                                message: format!("WebSocket write error: {e}"),
                                            });
                                        }
                                    }
                                }
                            }
                            "res" => {
                                let frame: ResponseFrame = match serde_json::from_value(envelope.inner) {
                                    Ok(f) => f,
                                    Err(_) => continue,
                                };

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
                                    let is_connect_response = connect_req_id
                                        .as_ref()
                                        .map(|id| id == &frame.id)
                                        .unwrap_or(true);

                                    if is_connect_response {
                                        if frame.ok {
                                            authenticated = true;
                                            if let Ok(mut c) = ws_connected.lock() { *c = true; }
                                            eprintln!("[ws_client] authenticated as node-host successfully");
                                            let _ = event_tx.send(NodeEvent::Authenticated);
                                        } else {
                                            let err_msg = frame.error.as_ref()
                                                .and_then(|e| e.get("message"))
                                                .and_then(|m| m.as_str())
                                                .or_else(|| frame.error.as_ref().and_then(|e| e.as_str()))
                                                .unwrap_or("unknown auth error");
                                            let _ = event_tx.send(NodeEvent::Error {
                                                message: format!("Gateway auth failed: {err_msg}"),
                                            });
                                            return Err(format!("auth failed: {err_msg}"));
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
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
                    Message::Pong(_) => {
                        if let Some(sent) = ping_sent_at.take() {
                            let rtt = sent.elapsed().as_millis() as u64;
                            latency.store(rtt, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    _ => {}
                }
            }
            rpc_req = rpc_rx.recv() => {
                match rpc_req {
                    Some(req) => {
                        let rpc_msg = serde_json::json!({
                            "type": "req",
                            "id": req.id,
                            "method": req.method,
                            "params": req.params,
                        });
                        if let Err(e) = write.send(Message::Text(rpc_msg.to_string())).await {
                            let _ = req.response_tx.send(Err(format!("WebSocket write error: {e}")));
                        } else {
                            pending_rpcs.insert(req.id, req.response_tx);
                        }
                    }
                    None => {
                        // rpc_rx channel closed, continue running WS loop
                    }
                }
            }
        }
    }

    // Send Close Frame for graceful shutdown
    eprintln!("[ws_client] sending Close frame");
    let _ = write.send(Message::Close(None)).await;

    // Wait briefly for server Close response
    let close_deadline = tokio::time::sleep(std::time::Duration::from_secs(3));
    tokio::pin!(close_deadline);
    loop {
        tokio::select! {
            msg_opt = read.next() => {
                match msg_opt {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
            _ = &mut close_deadline => {
                eprintln!("[ws_client] Close frame timeout, forcing disconnect");
                break;
            }
        }
    }

    for (_, tx) in pending_rpcs.drain() {
        let _ = tx.send(Err("WebSocket connection closed".to_string()));
    }

    Ok(())
}

/// Build the connect request with Ed25519 device identity signature.
fn build_connect_request(
    gateway_token: &str,
    node_id: &str,
    node_name: &str,
    identity: &DeviceIdentity,
    nonce: &str,
) -> serde_json::Value {
    let req_id = format!("connect-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let signed_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let role = "node";
    let scopes: &[&str] = &[];

    // Build and sign device auth payload V3
    let payload = device_identity::build_auth_payload_v3(
        &identity.device_id,
        "node-host",
        "node",
        role,
        scopes,
        signed_at_ms,
        gateway_token,
        nonce,
        "darwin",
    );

    let signature = device_identity::sign_payload(&identity.private_key_pem, &payload)
        .unwrap_or_default();
    let public_key = device_identity::public_key_raw_base64url(&identity.public_key_pem)
        .unwrap_or_default();

    serde_json::json!({
        "type": "req",
        "id": req_id,
        "method": "connect",
        "params": {
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": {
                "id": "node-host",
                "displayName": node_name,
                "version": "0.1.0",
                "platform": "darwin",
                "mode": "node",
                "instanceId": node_id
            },
            "caps": ["system"],
            "commands": [
                "system.run.prepare",
                "system.run",
                "system.which"
            ],
            "auth": {
                "token": gateway_token
            },
            "role": role,
            "scopes": scopes,
            "device": {
                "id": identity.device_id,
                "publicKey": public_key,
                "signature": signature,
                "signedAt": signed_at_ms,
                "nonce": nonce
            }
        }
    })
}

struct InvokeResult {
    ok: bool,
    payload: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

fn handle_node_invoke(
    command: &str,
    params: &serde_json::Value,
    executor: &TaskExecutor,
    event_tx: &mpsc::UnboundedSender<NodeEvent>,
    invoke_id: &str,
) -> InvokeResult {
    match command {
        "system.run" => {
            let cmd_parts: Vec<String> = if let Some(arr) = params.get("command").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            } else {
                vec![]
            };

            if cmd_parts.is_empty() {
                let _ = event_tx.send(NodeEvent::TaskFailed {
                    task_id: invoke_id.to_string(),
                    error: "system.run: command array required".to_string(),
                });
                return InvokeResult {
                    ok: false, payload: None,
                    error: Some(serde_json::json!({ "code": "INVALID_REQUEST", "message": "command array required" })),
                };
            }

            eprintln!("[ws_client] system.run: {}", cmd_parts.join(" "));

            match executor.execute_command(&cmd_parts) {
                Ok(output) => {
                    let _ = event_tx.send(NodeEvent::TaskCompleted {
                        task_id: invoke_id.to_string(),
                        exit_code: output.exit_code,
                        duration_ms: output.duration_ms,
                    });
                    InvokeResult {
                        ok: output.exit_code == 0,
                        payload: Some(serde_json::to_value(&output).unwrap_or_default()),
                        error: None,
                    }
                }
                Err(err) => {
                    let _ = event_tx.send(NodeEvent::TaskFailed {
                        task_id: invoke_id.to_string(),
                        error: err.clone(),
                    });
                    InvokeResult {
                        ok: false, payload: None,
                        error: Some(serde_json::json!({ "code": "EXEC_FAILED", "message": err })),
                    }
                }
            }
        }
        "system.which" => {
            let bins = params.get("bins")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
                .unwrap_or_default();

            let mut results = serde_json::Map::new();
            for bin in bins {
                let found = std::process::Command::new("which")
                    .arg(bin)
                    .output()
                    .ok()
                    .and_then(|o| if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else { None });
                results.insert(bin.to_string(), match found {
                    Some(path) => serde_json::json!(path),
                    None => serde_json::Value::Null,
                });
            }
            InvokeResult { ok: true, payload: Some(serde_json::Value::Object(results)), error: None }
        }
        "system.run.prepare" => {
            // Gateway sends: { command: [...argv], rawCommand: "...", cwd: "...", agentId: "...", sessionKey: "..." }
            // Must return: { cmdText: "...", plan: { argv: [...], rawCommand: "...", cwd: "...", agentId: "...", sessionKey: "..." } }
            let argv: Vec<String> = if let Some(arr) = params.get("command").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
            } else { vec![] };
            let raw_command = params.get("rawCommand").and_then(|v| v.as_str()).unwrap_or("");
            let cwd = params.get("cwd").and_then(|v| v.as_str());
            let agent_id = params.get("agentId").and_then(|v| v.as_str());
            let session_key = params.get("sessionKey").and_then(|v| v.as_str());

            let cmd_text = if raw_command.is_empty() { argv.join(" ") } else { raw_command.to_string() };

            let mut plan = serde_json::json!({ "argv": argv });
            if !raw_command.is_empty() { plan["rawCommand"] = serde_json::json!(raw_command); }
            if let Some(c) = cwd { plan["cwd"] = serde_json::json!(c); }
            if let Some(a) = agent_id { plan["agentId"] = serde_json::json!(a); }
            if let Some(s) = session_key { plan["sessionKey"] = serde_json::json!(s); }

            InvokeResult {
                ok: true,
                payload: Some(serde_json::json!({
                    "cmdText": cmd_text,
                    "plan": plan
                })),
                error: None,
            }
        }
        other => {
            eprintln!("[ws_client] unsupported command: {other}");
            InvokeResult {
                ok: false, payload: None,
                error: Some(serde_json::json!({ "code": "UNAVAILABLE", "message": format!("command not supported: {other}") })),
            }
        }
    }
}

pub fn build_ws_url(local_port: u16) -> String {
    format!("ws://127.0.0.1:{local_port}")
}

/// Operator WebSocket loop: authenticates as operator to call management APIs.
pub async fn run_operator_loop(
    ws_url: &str,
    local_port: u16,
    gateway_token: &str,
    rpc_rx: &mut mpsc::UnboundedReceiver<RpcRequest>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let mut request = ws_url.into_client_request()
        .map_err(|e| format!("bad URL: {e}"))?;
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{local_port}").parse().unwrap(),
    );

    let (ws_stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("Operator WS connect failed: {e}"))?;

    eprintln!("[operator_ws] connected");

    let (mut write, mut read) = ws_stream.split();
    let req_id_gen = ReqIdGen::new();
    let mut authenticated = false;
    let mut connect_req_id: Option<String> = None;
    let mut pending_rpcs: HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>> = HashMap::new();

    // Buffer RPC requests that arrive before authentication completes.
    let mut auth_pending: Vec<RpcRequest> = Vec::new();

    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)), if shutdown.load(std::sync::atomic::Ordering::Relaxed) => {
                eprintln!("[operator_ws] shutdown flag detected");
                break;
            }
            msg_opt = read.next() => {
                let msg = match msg_opt {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        for (_, tx) in pending_rpcs.drain() {
                            let _ = tx.send(Err("operator connection lost".to_string()));
                        }
                        for req in auth_pending.drain(..) {
                            let _ = req.response_tx.send(Err("operator connection lost".to_string()));
                        }
                        return Err(format!("Operator WS read error: {e}"));
                    }
                    None => break,
                };

                match msg {
                    Message::Text(text) => {
                        let envelope: WsEnvelope = match serde_json::from_str(&text) {
                            Ok(e) => e,
                            Err(_) => continue,
                        };

                        match envelope.msg_type.as_str() {
                            "event" => {
                                let frame: EventFrame = match serde_json::from_value(envelope.inner) {
                                    Ok(f) => f,
                                    Err(_) => continue,
                                };

                                if frame.event == "connect.challenge" {
                                    let id = req_id_gen.next();
                                    connect_req_id = Some(id.clone());

                                    let connect_req = serde_json::json!({
                                        "type": "req",
                                        "id": id,
                                        "method": "connect",
                                        "params": {
                                            "minProtocol": 3,
                                            "maxProtocol": 3,
                                            "client": {
                                                "id": "openclaw-control-ui",
                                                "version": "0.1.0",
                                                "platform": "darwin",
                                                "mode": "webchat",
                                                "instanceId": "connector-operator"
                                            },
                                            "role": "operator",
                                            "scopes": ["operator.read", "operator.write", "operator.admin"],
                                            "auth": {
                                                "token": gateway_token
                                            }
                                        }
                                    });

                                    eprintln!("[operator_ws] sending operator auth...");
                                    let _ = write.send(Message::Text(connect_req.to_string())).await;
                                }
                            }
                            "res" => {
                                let frame: ResponseFrame = match serde_json::from_value(envelope.inner) {
                                    Ok(f) => f,
                                    Err(_) => continue,
                                };

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
                                    let is_connect = connect_req_id
                                        .as_ref()
                                        .map(|id| id == &frame.id)
                                        .unwrap_or(true);

                                    if is_connect {
                                        if frame.ok {
                                            authenticated = true;
                                            eprintln!("[operator_ws] authenticated as operator");

                                            // Flush buffered RPC requests now that we're authenticated
                                            for req in auth_pending.drain(..) {
                                                let outgoing = serde_json::json!({
                                                    "type": "req",
                                                    "id": req.id,
                                                    "method": req.method,
                                                    "params": req.params,
                                                });
                                                if let Err(e) = write.send(Message::Text(outgoing.to_string())).await {
                                                    let _ = req.response_tx.send(Err(format!("write error: {e}")));
                                                } else {
                                                    pending_rpcs.insert(req.id, req.response_tx);
                                                }
                                            }
                                        } else {
                                            let err = frame.error
                                                .as_ref()
                                                .and_then(|e| e.get("message"))
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("auth failed");
                                            // Reject all buffered requests
                                            for req in auth_pending.drain(..) {
                                                let _ = req.response_tx.send(Err(format!("Operator auth failed: {err}")));
                                            }
                                            return Err(format!("Operator auth failed: {err}"));
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Message::Ping(data) => {
                        let _ = write.send(Message::Pong(data)).await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            rpc_req = rpc_rx.recv() => {
                if let Some(req) = rpc_req {
                    if !authenticated {
                        // Buffer the request — it will be sent once authentication completes
                        eprintln!("[operator_ws] buffering RPC '{}' until authenticated", req.method);
                        auth_pending.push(req);
                        continue;
                    }
                    let outgoing = serde_json::json!({
                        "type": "req",
                        "id": req.id,
                        "method": req.method,
                        "params": req.params,
                    });
                    if let Err(e) = write.send(Message::Text(outgoing.to_string())).await {
                        let _ = req.response_tx.send(Err(format!("write error: {e}")));
                    } else {
                        pending_rpcs.insert(req.id, req.response_tx);
                    }
                }
            }
        }
    }

    // Send Close Frame for graceful shutdown
    eprintln!("[operator_ws] sending Close frame");
    let _ = write.send(Message::Close(None)).await;

    // Wait briefly for server Close response
    let close_deadline = tokio::time::sleep(std::time::Duration::from_secs(3));
    tokio::pin!(close_deadline);
    loop {
        tokio::select! {
            msg_opt = read.next() => {
                match msg_opt {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
            _ = &mut close_deadline => {
                eprintln!("[operator_ws] Close frame timeout, forcing disconnect");
                break;
            }
        }
    }

    for (_, tx) in pending_rpcs.drain() {
        let _ = tx.send(Err("operator connection closed".to_string()));
    }
    for req in auth_pending.drain(..) {
        let _ = req.response_tx.send(Err("operator connection closed before authentication".to_string()));
    }

    Ok(())
}
