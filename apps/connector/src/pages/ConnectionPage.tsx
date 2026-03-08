import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { useActivityStore } from "../store/useActivityStore";
import { useConfigStore } from "../store/useConfigStore";

type ConnectionStatus = {
  tunnelState: "disconnected" | "connecting" | "connected" | "reconnecting";
  tunnelReconnectAttempts: number;
  tunnelLastError: string | null;
  wsConnected: boolean;
};

type NodeEvent =
  | { kind: "connected" }
  | { kind: "authenticated" }
  | { kind: "disconnected"; reason: string }
  | { kind: "taskReceived"; taskId: string; action: string }
  | { kind: "taskCompleted"; taskId: string; exitCode: number; durationMs: number }
  | { kind: "taskFailed"; taskId: string; error: string }
  | { kind: "error"; message: string };

type AgentInfo = {
  id: string;
  displayName?: string;
};

type SessionInfo = {
  key: string;
  agentId: string;
  displayName?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatMessage = Record<string, any>;

type BrowserStatusResponse = {
  running: boolean;
  cdpPort: number;
  cdpRemotePort: number;
  tunnelRunning: boolean;
  pid: number | null;
};

export function ConnectionPage() {
  const config = useConfigStore((s) => s.config);
  const patchConfig = useConfigStore((s) => s.patchConfig);
  const [server, setServer] = useState(config.server);
  const [gatewayToken, setGatewayToken] = useState(config.gatewayToken);
  const [nodeName, setNodeName] = useState(config.nodeName);
  const [status, setStatus] = useState<ConnectionStatus>({
    tunnelState: "disconnected",
    tunnelReconnectAttempts: 0,
    tunnelLastError: null,
    wsConnected: false
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushActivity = useActivityStore((s) => s.push);
  const entries = useActivityStore((s) => s.entries);
  const clearActivity = useActivityStore((s) => s.clear);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionInfo[]>>({});
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [notifiedSessions, setNotifiedSessions] = useState<Set<string>>(new Set());
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<Record<string, ChatMessage[]>>({});
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const [browserRunning, setBrowserRunning] = useState(false);
  const [browserTunnelRunning, setBrowserTunnelRunning] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [cdpPort, setCdpPort] = useState(config.cdpPort);
  const [cdpRemotePort, setCdpRemotePort] = useState(config.cdpRemotePort);

  // Poll connection status
  useEffect(() => {
    const poll = async () => {
      try {
        const next = await invoke<ConnectionStatus>("get_connection_status");
        setStatus(next);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  // Listen for node events → activity log
  useEffect(() => {
    const unlisten = listen<NodeEvent>("node-event", (event) => {
      const e = event.payload;
      switch (e.kind) {
        case "connected":
          pushActivity("info", "WebSocket 已连接，正在认证...");
          break;
        case "authenticated":
          pushActivity("info", "Gateway 认证成功，等待任务分派");
          break;
        case "disconnected":
          pushActivity("error", `WebSocket 断开：${e.reason}`);
          break;
        case "taskReceived":
          pushActivity("info", `收到任务 [${e.taskId.slice(0, 8)}] ${e.action}`);
          break;
        case "taskCompleted":
          pushActivity("info", `任务完成 [${e.taskId.slice(0, 8)}] exit=${e.exitCode} ${e.durationMs}ms`);
          break;
        case "taskFailed":
          pushActivity("error", `任务失败 [${e.taskId.slice(0, 8)}] ${e.error}`);
          break;
        case "error":
          pushActivity("error", e.message);
          break;
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [pushActivity]);

  const isConnected = status.tunnelState === "connected";
  const fullyConnected = isConnected && status.wsConnected;

  const statusClass = useMemo(() => {
    if (fullyConnected) return "status-dot online";
    if (isConnected) return "status-dot pending";
    if (status.tunnelState === "connecting" || status.tunnelState === "reconnecting")
      return "status-dot pending";
    return "status-dot offline";
  }, [fullyConnected, isConnected, status.tunnelState]);

  const statusText = useMemo(() => {
    if (fullyConnected) return "SSH + WebSocket 已连接";
    if (isConnected) return "SSH 已连接，WebSocket 连接中...";
    if (status.tunnelState === "connecting") return "连接中";
    if (status.tunnelState === "reconnecting") return "重连中";
    return "未连接";
  }, [fullyConnected, isConnected, status.tunnelState]);

  // Poll browser status
  useEffect(() => {
    if (!fullyConnected) return;
    const poll = async () => {
      try {
        const s = await invoke<BrowserStatusResponse>("get_browser_status");
        setBrowserRunning(s.running);
        setBrowserTunnelRunning(s.tunnelRunning);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [fullyConnected]);

  useEffect(() => {
    if (fullyConnected && agents.length === 0) {
      loadAgents();
    }
  }, [fullyConnected]);

  const loadAgents = async () => {
    setLoadingAgents(true);
    setChatHistory({});
    setExpandedSession(null);
    try {
      const result = await invoke<unknown>("list_agents");
      console.log("[loadAgents] raw result:", JSON.stringify(result));
      const list = Array.isArray(result) ? result : (result as Record<string, unknown>)?.agents ?? (result as Record<string, unknown>)?.list ?? [];
      setAgents(Array.isArray(list) ? list as AgentInfo[] : []);
    } catch (err) {
      pushActivity("error", `加载 Agent 列表失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingAgents(false);
    }
  };

  const loadSessions = async (agentId: string) => {
    try {
      const result = await invoke<unknown>("list_sessions", { agentId });
      console.log("[loadSessions] raw result:", JSON.stringify(result));
      const raw = Array.isArray(result) ? result : (result as Record<string, unknown>)?.sessions ?? (result as Record<string, unknown>)?.list ?? [];
      const list = Array.isArray(raw) ? raw as SessionInfo[] : [];
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: list }));
    } catch (err) {
      pushActivity("error", `加载 Session 列表失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

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

  const fetchChatHistory = async (sessionKey: string, showLoading = true) => {
    if (showLoading) setLoadingHistory(sessionKey);
    try {
      const result = await invoke<unknown>("get_chat_history", { sessionKey, limit: 10 });
      console.log("[chatHistory] raw result:", JSON.stringify(result).slice(0, 2000));
      const raw = result as Record<string, unknown>;
      const messages = Array.isArray(raw?.messages) ? raw.messages as ChatMessage[] : Array.isArray(result) ? result as ChatMessage[] : [];
      setChatHistory((prev) => ({ ...prev, [sessionKey]: messages }));
    } catch (err) {
      if (showLoading) {
        pushActivity("error", `加载聊天记录失败：${err instanceof Error ? err.message : String(err)}`);
      }
      setChatHistory((prev) => ({ ...prev, [sessionKey]: [] }));
    } finally {
      if (showLoading) setLoadingHistory(null);
    }
  };

  const toggleSession = (sessionKey: string) => {
    if (expandedSession === sessionKey) {
      setExpandedSession(null);
    } else {
      setExpandedSession(sessionKey);
      fetchChatHistory(sessionKey);
    }
  };

  // Auto-refresh chat history for expanded session
  useEffect(() => {
    if (!expandedSession) return;
    const id = setInterval(() => fetchChatHistory(expandedSession, false), 5000);
    return () => clearInterval(id);
  }, [expandedSession]);

  const toggleNotify = async (sessionKey: string) => {
    const isLinked = notifiedSessions.has(sessionKey);
    const hasBrowser = browserRunning;
    const cdpBlock = hasBrowser
      ? `\n\n[浏览器可用] 用户已将本地浏览器暴露给当前会话。\n- CDP 地址: 127.0.0.1:${cdpRemotePort}\n- 你可以使用任意支持 CDP 的浏览器自动化工具连接此地址，对用户的本地浏览器执行打开页面、查看 tab、截图、点击、输入等操作。\n- 重要：此处 127.0.0.1:${cdpRemotePort} 不是你服务器上的本地回环地址，而是用户通过隧道暴露给你的浏览器入口，在当前会话中可直接连接。\n- 收到此地址后，应优先尝试通过 CDP 连接浏览器再进行操作。`
      : "";
    const message = isLinked
      ? `[系统通知] 本地节点 "${nodeName}" 已断开，不再可用。`
      : `[系统通知] 本地节点 "${nodeName}" 已连接。\n- Node ID: ${config.nodeId}\n- 环境: macOS (本地)\n- 能力: 命令执行 (system.run)\n\n当用户的请求需要在本地环境执行时，你可以使用这个节点。${cdpBlock}`;
    try {
      await invoke("inject_message", { sessionKey, content: message });
      setNotifiedSessions((prev) => {
        const next = new Set(prev);
        if (isLinked) {
          next.delete(sessionKey);
          pushActivity("info", `已断开本地连接 [${sessionKey.slice(0, 8)}]`);
        } else {
          next.add(sessionKey);
          pushActivity("info", `已连接本地到 session [${sessionKey.slice(0, 8)}]`);
        }
        return next;
      });
    } catch (err) {
      pushActivity("error", `操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    pushActivity("info", `发起连接：${server.user}@${server.host}`);
    try {
      await invoke("connect", { server, gatewayToken, nodeId: config.nodeId, nodeName });
      pushActivity("info", "SSH 隧道已连接，WebSocket 正在建立...");
      patchConfig({ server, gatewayToken, nodeName });
      await invoke("save_app_config", {
        cfg: { ...config, server, gatewayToken, nodeName }
      }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", `连接失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    setBusy(true);
    setError(null);

    // Send disconnect notifications to all notified sessions
    if (notifiedSessions.size > 0) {
      pushActivity("info", `向 ${notifiedSessions.size} 个 session 发送断开连接通知...`);
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
        wsConnected: false
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

  const openGateway = () => {
    invoke("open_url", { url: `http://127.0.0.1:${server.localPort}/#token=${gatewayToken}` }).catch(() => {});
  };

  const startBrowser = async () => {
    setBrowserBusy(true);
    try {
      const result = await invoke<BrowserStatusResponse>("start_browser", {
        cdpPort,
        cdpRemotePort,
      });
      setBrowserRunning(result.running);
      setBrowserTunnelRunning(result.tunnelRunning);
      pushActivity("info", `Chrome 已启动，CDP 端口 ${cdpPort}，远程映射 ${cdpRemotePort}`);
      patchConfig({ cdpPort, cdpRemotePort });
      await invoke("save_app_config", {
        cfg: { ...config, cdpPort, cdpRemotePort },
      }).catch(() => {});
    } catch (err) {
      pushActivity("error", `启动浏览器失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBrowserBusy(false);
    }
  };

  const stopBrowser = async () => {
    setBrowserBusy(true);
    try {
      await invoke("stop_browser");
      setBrowserRunning(false);
      setBrowserTunnelRunning(false);
      pushActivity("info", "Chrome 已停止");
    } catch (err) {
      pushActivity("error", `停止浏览器失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBrowserBusy(false);
    }
  };

  return (
    <>
      {/* ── Connection Form ── */}
      <section className="card">
        <div className="card-header">
          <h2>连接</h2>
          <div className="status-chip" aria-live="polite">
            <span className={statusClass} />
            {statusText}
          </div>
        </div>

        <div className="form-grid">
          <label>
            主机
            <input
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={server.host}
              onChange={(e) => setServer((p) => ({ ...p, host: e.target.value }))}
            />
          </label>
          <label>
            用户
            <input
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={server.user}
              onChange={(e) => setServer((p) => ({ ...p, user: e.target.value }))}
            />
          </label>
          <label>
            密钥路径
            <input
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={server.keyPath}
              onChange={(e) => setServer((p) => ({ ...p, keyPath: e.target.value }))}
            />
          </label>
          <label>
            Gateway Token
            <input
              type="password"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={gatewayToken}
              onChange={(e) => setGatewayToken(e.target.value)}
              placeholder="gateway.auth.token 的值"
            />
          </label>
          <label>
            节点名称
            <input
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              placeholder="OpenClaw Connector (macOS)"
            />
          </label>
          <label>
            远程端口
            <input
              type="number"
              value={server.remotePort}
              onChange={(e) => setServer((p) => ({ ...p, remotePort: Number(e.target.value) || 18789 }))}
            />
          </label>
          <label>
            本地端口
            <input
              type="number"
              value={server.localPort}
              onChange={(e) => setServer((p) => ({ ...p, localPort: Number(e.target.value) || 18789 }))}
            />
          </label>
        </div>

        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>
            {busy ? "处理中..." : "连接"}
          </button>
          <button type="button" className="btn" onClick={doDisconnect} disabled={busy}>
            断开
          </button>
          {fullyConnected && (
            <button type="button" className="btn" onClick={openGateway}>
              打开 Gateway
            </button>
          )}
        </div>

        {status.tunnelLastError && (
          <p className="hint">最近错误：{status.tunnelLastError}</p>
        )}
        {error && <p className="error-banner">{error}</p>}
      </section>

      {/* ── Browser CDP ── */}
      {fullyConnected && (
        <section className="card">
          <div className="card-header">
            <h2>浏览器</h2>
            <div className="status-chip">
              <span className={browserRunning && browserTunnelRunning ? "status-dot online" : browserRunning ? "status-dot pending" : "status-dot offline"} />
              {browserRunning && browserTunnelRunning
                ? "Chrome + 隧道就绪"
                : browserRunning
                  ? "Chrome 运行中"
                  : "未启动"}
            </div>
          </div>

          <div className="form-grid two-col">
            <label>
              CDP 端口 (本地)
              <input
                type="number"
                value={cdpPort}
                onChange={(e) => setCdpPort(Number(e.target.value) || 9222)}
                disabled={browserRunning}
              />
            </label>
            <label>
              远程映射端口
              <input
                type="number"
                value={cdpRemotePort}
                onChange={(e) => setCdpRemotePort(Number(e.target.value) || 19222)}
                disabled={browserRunning}
              />
            </label>
          </div>

          <div className="button-row">
            {!browserRunning ? (
              <button type="button" className="btn btn-primary" onClick={startBrowser} disabled={browserBusy}>
                {browserBusy ? "启动中..." : "启动 Chrome"}
              </button>
            ) : (
              <button type="button" className="btn btn-danger" onClick={stopBrowser} disabled={browserBusy}>
                {browserBusy ? "停止中..." : "停止 Chrome"}
              </button>
            )}
          </div>

          {browserRunning && browserTunnelRunning && (
            <p className="hint">
              远程 Agent 可通过 localhost:{cdpRemotePort} 连接 CDP。
            </p>
          )}
        </section>
      )}

      {/* ── Agent Notification ── */}
      {fullyConnected && (
        <section className="card">
          <div className="card-header">
            <h2>Session 管理</h2>
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
            <ul className="agent-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <div
                    className="agent-row"
                    onClick={() => toggleAgent(agent.id)}
                  >
                    <span className="agent-expand">
                      {expandedAgent === agent.id ? "▼" : "▶"}
                    </span>
                    <span className="agent-name">
                      {agent.displayName || agent.id}
                    </span>
                    {sessionsByAgent[agent.id] && (
                      <span className="agent-badge">
                        {sessionsByAgent[agent.id].length} sessions
                      </span>
                    )}
                  </div>
                  {expandedAgent === agent.id && (
                    <ul className="session-list">
                      {!sessionsByAgent[agent.id] ? (
                        <li className="list-empty" style={{ marginLeft: 24 }}>加载中...</li>
                      ) : sessionsByAgent[agent.id].length === 0 ? (
                        <li className="list-empty" style={{ marginLeft: 24 }}>无活跃 Session</li>
                      ) : (
                        sessionsByAgent[agent.id].map((session) => (
                          <li key={session.key}>
                            <div className="session-row">
                              <span
                                className="session-name"
                                title={session.displayName || session.key}
                                onClick={() => toggleSession(session.key)}
                              >
                                <span className="session-expand">
                                  {expandedSession === session.key ? "▾" : "›"}
                                </span>
                                {session.displayName || session.key}
                              </span>
                              <button
                                type="button"
                                className={`btn-pill ${
                                  notifiedSessions.has(session.key)
                                    ? "cancel"
                                    : "notify"
                                }`}
                                onClick={() => toggleNotify(session.key)}
                              >
                                {notifiedSessions.has(session.key)
                                  ? "断开连接"
                                  : "连接本地"}
                              </button>
                            </div>
                            {expandedSession === session.key && (
                              <div className="chat-preview">
                                {loadingHistory === session.key ? (
                                  <p className="chat-empty">加载聊天记录...</p>
                                ) : !chatHistory[session.key] || chatHistory[session.key].length === 0 ? (
                                  <p className="chat-empty">无聊天记录</p>
                                ) : (
                                  chatHistory[session.key].map((msg, i) => {
                                    const role = String(msg?.role ?? msg?.type ?? "unknown");
                                    const roleLabel = role === "user" ? "用户" : role === "assistant" ? "AI" : role;
                                    const roleClass = role === "user" || role === "assistant" ? role : "user";
                                    // content can be string, array of blocks, or missing
                                    let text = "";
                                    const c = msg?.content ?? msg?.text ?? msg?.message ?? "";
                                    if (typeof c === "string") {
                                      text = c;
                                    } else if (Array.isArray(c)) {
                                      text = c.map((b: Record<string, unknown>) => typeof b === "string" ? b : String(b?.text ?? b?.content ?? "")).join(" ");
                                    } else {
                                      text = String(c);
                                    }
                                    if (!text && !role) return null;
                                    const truncated = text.slice(0, 200);
                                    return (
                                      <div key={i} className={`chat-msg ${roleClass}`}>
                                        <span className="chat-role">{roleLabel}</span>
                                        <span className="chat-text">{truncated}{text.length > 200 ? "..." : ""}</span>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            )}
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

      {/* ── Activity Log ── */}
      <section className="card">
        <div className="card-header">
          <h2>活动日志</h2>
          {entries.length > 0 && (
            <button type="button" className="btn btn-small" onClick={clearActivity}>
              清空
            </button>
          )}
        </div>
        <ul className="list">
          {entries.length === 0 && (
            <li className="list-empty">暂无活动记录</li>
          )}
          {entries.map((entry) => (
            <li key={entry.id} className="list-row">
              <span className={`pill ${entry.level}`}>
                {entry.level === "info" ? "信息" : "错误"}
              </span>
              <span>{entry.message}</span>
              <time>{entry.timestamp}</time>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
