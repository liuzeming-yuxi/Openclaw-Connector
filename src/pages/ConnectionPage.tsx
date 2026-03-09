import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { useActivityStore } from "../store/useActivityStore";
import { useConfigStore } from "../store/useConfigStore";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { 
  Server, Shield, Activity, RefreshCw, Unplug, Globe, 
  Chrome, ChevronRight, ChevronDown, MessageSquare,
  AlertCircle, CheckCircle2, Play, Square, ExternalLink, Terminal
} from "lucide-react";

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
      } catch { /* polling — ignore */ }
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
    if (fullyConnected) return "status-dot status-dot-online";
    if (isConnected) return "status-dot status-dot-pending";
    if (status.tunnelState === "connecting" || status.tunnelState === "reconnecting")
      return "status-dot status-dot-pending animate-pulse";
    return "status-dot status-dot-offline";
  }, [fullyConnected, isConnected, status.tunnelState]);

  const statusText = useMemo(() => {
    if (fullyConnected) return "已连接";
    if (isConnected) return "SSH 已连接，WS 连接中";
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
      } catch { /* polling — ignore */ }
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
        } catch { /* best-effort notification */ }
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-20">
      
      <div className="lg:col-span-7 space-y-6">
        {/* ── Connection Form ── */}
        <Card className="glass-card">
          <CardHeader>
            <CardTitle>
              <Server className="w-5 h-5 text-emerald-400" />
              隧道连接
            </CardTitle>
            <div className="flex items-center gap-2 bg-slate-900/80 border border-slate-700 rounded-full px-3 py-1 font-mono text-xs">
              <span className={statusClass} />
              <span className="text-slate-200">{statusText}</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              <div>
                <label className="label-base">主机地址</label>
                <Input
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.host}
                  onChange={(e) => setServer((p) => ({ ...p, host: e.target.value }))}
                />
              </div>
              <div>
                <label className="label-base">用户</label>
                <Input
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.user}
                  onChange={(e) => setServer((p) => ({ ...p, user: e.target.value }))}
                />
              </div>
              <div className="md:col-span-2 lg:col-span-1">
                <label className="label-base">节点名称</label>
                <Input
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder="OpenClaw Connector"
                />
              </div>
              <div className="md:col-span-2">
                <label className="label-base">Gateway Token</label>
                <Input
                  type="password"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={gatewayToken}
                  onChange={(e) => setGatewayToken(e.target.value)}
                  placeholder="gateway.auth.token 的值"
                />
              </div>
              <div className="md:col-span-2 lg:col-span-1">
                <label className="label-base">密钥路径</label>
                <Input
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.keyPath}
                  onChange={(e) => setServer((p) => ({ ...p, keyPath: e.target.value }))}
                />
              </div>
              <div>
                <label className="label-base">远程端口</label>
                <Input
                  type="number"
                  value={server.remotePort}
                  onChange={(e) => setServer((p) => ({ ...p, remotePort: Number(e.target.value) || 18789 }))}
                />
              </div>
              <div>
                <label className="label-base">本地端口</label>
                <Input
                  type="number"
                  value={server.localPort}
                  onChange={(e) => setServer((p) => ({ ...p, localPort: Number(e.target.value) || 18789 }))}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={connect} disabled={busy} variant={fullyConnected ? "secondary" : "default"}>
                <RefreshCw className={`w-4 h-4 mr-2 ${busy ? 'animate-spin' : ''}`} />
                {busy ? "处理中..." : (fullyConnected ? "重新连接" : "连接网关")}
              </Button>
              
              <Button onClick={doDisconnect} disabled={busy || (!isConnected && status.tunnelState === "disconnected")} variant="outline" className="border-red-900/50 hover:bg-red-900/20 text-red-200 hover:text-red-100">
                <Unplug className="w-4 h-4 mr-2" />
                断开
              </Button>
              
              {fullyConnected && (
                <Button onClick={openGateway} variant="secondary" className="ml-auto">
                  <Globe className="w-4 h-4 mr-2 text-blue-400" />
                  管理控制台
                </Button>
              )}
            </div>

            {status.tunnelLastError && (
              <div className="mt-4 flex items-start gap-2 text-sm text-red-400 bg-red-950/30 p-3 rounded-lg border border-red-900/50">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p>最近错误：{status.tunnelLastError}</p>
              </div>
            )}
            {error && (
              <div className="mt-4 flex items-start gap-2 text-sm text-red-400 bg-red-950/30 p-3 rounded-lg border border-red-900/50">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Browser CDP ── */}
        {fullyConnected && (
          <Card className="glass-card animate-in fade-in slide-in-from-bottom-4">
            <CardHeader>
              <CardTitle>
                <Chrome className="w-5 h-5 text-blue-400" />
                浏览器自动化
              </CardTitle>
              <div className="flex items-center gap-2 bg-slate-900/80 border border-slate-700 rounded-full px-3 py-1 font-mono text-xs">
                <span className={browserRunning && browserTunnelRunning ? "status-dot status-dot-online" : browserRunning ? "status-dot status-dot-pending" : "status-dot status-dot-offline"} />
                <span className="text-slate-200">
                  {browserRunning && browserTunnelRunning ? "隧道就绪" : browserRunning ? "运行中" : "未启动"}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="label-base">CDP 端口 (本地)</label>
                  <Input
                    type="number"
                    value={cdpPort}
                    onChange={(e) => setCdpPort(Number(e.target.value) || 9222)}
                    disabled={browserRunning}
                  />
                </div>
                <div>
                  <label className="label-base">远程映射端口</label>
                  <Input
                    type="number"
                    value={cdpRemotePort}
                    onChange={(e) => setCdpRemotePort(Number(e.target.value) || 19222)}
                    disabled={browserRunning}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                {!browserRunning ? (
                  <Button onClick={startBrowser} disabled={browserBusy} className="bg-blue-600 hover:bg-blue-500 border-blue-500 text-white">
                    <Play className="w-4 h-4 mr-2" />
                    {browserBusy ? "启动中..." : "启动 Chrome"}
                  </Button>
                ) : (
                  <Button onClick={stopBrowser} disabled={browserBusy} variant="destructive">
                    <Square className="w-4 h-4 mr-2" />
                    {browserBusy ? "停止中..." : "停止 Chrome"}
                  </Button>
                )}
              </div>

              {browserRunning && browserTunnelRunning && (
                <div className="mt-4 text-sm text-slate-400 bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                  <p>
                    CDP 隧道已建立。远程 Agent 可通过 <code className="text-emerald-400 bg-slate-800 px-1 py-0.5 rounded font-mono text-xs">localhost:{cdpRemotePort}</code> 连接。
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="lg:col-span-5 space-y-6">
        {/* ── Agent Notification ── */}
        {fullyConnected && (
          <Card className="glass-card animate-in fade-in slide-in-from-bottom-4 h-[400px] flex flex-col">
            <CardHeader className="pb-4">
              <CardTitle>
                <Activity className="w-5 h-5 text-purple-400" />
                会话注入
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={loadAgents} disabled={loadingAgents} className="h-8 w-8 ml-auto text-slate-400 hover:text-slate-100">
                <RefreshCw className={`w-4 h-4 ${loadingAgents ? 'animate-spin' : ''}`} />
              </Button>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto pt-0">
              {agents.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3">
                  <MessageSquare className="w-10 h-10 opacity-20" />
                  <p className="text-sm">
                    {loadingAgents ? "正在加载 Agent..." : "暂无可用的 Agent"}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {agents.map((agent) => (
                    <li key={agent.id} className="bg-slate-900/40 rounded-lg border border-slate-700/50 overflow-hidden">
                      <button
                        className="w-full flex items-center gap-3 p-3 hover:bg-slate-800/60 transition-colors text-left cursor-pointer"
                        onClick={() => toggleAgent(agent.id)}
                      >
                        {expandedAgent === agent.id ? (
                          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                        )}
                        <span className="font-medium text-slate-200 truncate">
                          {agent.displayName || agent.id}
                        </span>
                        {sessionsByAgent[agent.id] && (
                          <Badge variant="secondary" className="ml-auto text-xs py-0 h-5 border border-slate-600">
                            {sessionsByAgent[agent.id].length}
                          </Badge>
                        )}
                      </button>
                      
                      {expandedAgent === agent.id && (
                        <div className="bg-slate-950/50 p-2 border-t border-slate-800/80">
                          <ul className="space-y-1.5">
                            {!sessionsByAgent[agent.id] ? (
                              <li className="text-sm text-slate-500 p-2 text-center animate-pulse">加载中...</li>
                            ) : sessionsByAgent[agent.id].length === 0 ? (
                              <li className="text-sm text-slate-500 p-2 text-center">无活跃 Session</li>
                            ) : (
                              sessionsByAgent[agent.id].map((session) => (
                                <li key={session.key} className="bg-slate-800/50 rounded-md border border-slate-700/50">
                                  <div className="flex items-center gap-2 p-2">
                                    <button
                                      className="flex-1 flex items-center gap-2 min-w-0 hover:text-emerald-400 transition-colors text-left cursor-pointer"
                                      title={session.displayName || session.key}
                                      onClick={() => toggleSession(session.key)}
                                    >
                                      {expandedSession === session.key ? (
                                        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                      ) : (
                                        <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                      )}
                                      <span className="font-mono text-xs text-slate-300 truncate">
                                        {session.displayName || session.key}
                                      </span>
                                    </button>
                                    <Button
                                      size="sm"
                                      variant={notifiedSessions.has(session.key) ? "destructive" : "secondary"}
                                      className={`h-7 text-xs px-2 shrink-0 ${notifiedSessions.has(session.key) ? '' : 'text-emerald-400 hover:text-emerald-300'}`}
                                      onClick={() => toggleNotify(session.key)}
                                    >
                                      {notifiedSessions.has(session.key) ? "断开" : "注入"}
                                    </Button>
                                  </div>
                                  
                                  {expandedSession === session.key && (
                                    <div className="px-2 pb-2">
                                      <div className="bg-slate-900 border border-slate-800 rounded p-2 max-h-48 overflow-y-auto space-y-2 font-mono text-xs">
                                        {loadingHistory === session.key ? (
                                          <p className="text-slate-500 italic text-center">加载历史...</p>
                                        ) : !chatHistory[session.key] || chatHistory[session.key].length === 0 ? (
                                          <p className="text-slate-500 italic text-center">空</p>
                                        ) : (
                                          chatHistory[session.key].map((msg, i) => {
                                            const role = String(msg?.role ?? msg?.type ?? "unknown");
                                            const isUser = role === "user";
                                            
                                            const c = msg?.content ?? msg?.text ?? msg?.message ?? "";
                                            let text: string;
                                            if (typeof c === "string") text = c;
                                            else if (Array.isArray(c)) text = c.map((b: Record<string, unknown>) => typeof b === "string" ? b : String(b?.text ?? b?.content ?? "")).join(" ");
                                            else text = String(c);
                                            
                                            if (!text && !role) return null;
                                            
                                            return (
                                              <div key={i} className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
                                                <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${isUser ? 'bg-blue-900/50 text-blue-300 border border-blue-800/50' : 'bg-emerald-900/50 text-emerald-300 border border-emerald-800/50'}`}>
                                                  {isUser ? '用户' : 'AI'}
                                                </span>
                                                <div className={`p-1.5 rounded-md max-w-[90%] break-words border ${isUser ? 'bg-slate-800/80 text-slate-300 border-slate-700' : 'bg-transparent text-slate-400 border-transparent'}`}>
                                                  {text.slice(0, 150)}{text.length > 150 ? "..." : ""}
                                                </div>
                                              </div>
                                            );
                                          })
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </li>
                              ))
                            )}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Activity Log ── */}
        <Card className={`glass-card flex flex-col ${fullyConnected ? 'h-[400px]' : 'h-[600px]'}`}>
          <CardHeader className="pb-4">
            <CardTitle>
              <Terminal className="w-5 h-5 text-slate-400" />
              活动日志
            </CardTitle>
            {entries.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearActivity} className="h-8 text-xs text-slate-400 hover:text-slate-200 ml-auto">
                清空
              </Button>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto pt-0 font-mono text-xs">
            {entries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic">
                &gt; 等待事件...
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 hover:bg-slate-800/50 p-1.5 rounded transition-colors group">
                    <span className="text-slate-500 shrink-0 select-none">[{entry.timestamp}]</span>
                    <span className={`shrink-0 ${entry.level === 'info' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {entry.level === 'info' ? '→' : '✕'}
                    </span>
                    <span className={`break-words ${entry.level === 'info' ? 'text-slate-300' : 'text-red-300'}`}>
                      {entry.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
