import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
  const [latencyMs, setLatencyMs] = useState(0);

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
          pushActivity("info", t("events.ws_connected"));
          break;
        case "authenticated":
          pushActivity("info", t("events.authenticated"));
          break;
        case "disconnected":
          pushActivity("error", t("events.ws_disconnected", { reason: e.reason }));
          break;
        case "taskReceived":
          pushActivity("info", t("events.task_received", { id: e.taskId.slice(0, 8), action: e.action }));
          break;
        case "taskCompleted":
          pushActivity("info", t("events.task_completed", { id: e.taskId.slice(0, 8), code: e.exitCode, ms: e.durationMs }));
          break;
        case "taskFailed":
          pushActivity("error", t("events.task_failed", { id: e.taskId.slice(0, 8), error: e.error }));
          break;
        case "error":
          if (e.message === "tunnel_reconnecting") {
            pushActivity("error", t("events.tunnel_reconnecting"));
          } else if (e.message === "tunnel_reconnect_failed") {
            pushActivity("error", t("events.tunnel_reconnect_failed"));
          } else {
            pushActivity("error", e.message);
          }
          break;
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [pushActivity, t]);

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
    if (fullyConnected) {
      return latencyMs > 0 ? t("connection.status_connected_latency", { ms: latencyMs }) : t("connection.status_connected");
    }
    if (isConnected) return t("connection.status_ssh_ok_ws_pending");
    if (status.tunnelState === "connecting") return t("connection.status_connecting");
    if (status.tunnelState === "reconnecting") return t("connection.status_reconnecting");
    return t("connection.status_disconnected");
  }, [fullyConnected, isConnected, status.tunnelState, latencyMs, t]);

  // Poll health summary for latency
  useEffect(() => {
    if (!fullyConnected) {
      setLatencyMs(0);
      return;
    }
    const poll = async () => {
      try {
        const h = await invoke<{ latencyMs: number }>("get_health_summary");
        setLatencyMs(h.latencyMs);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [fullyConnected]);

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

  const loadAgents = async (retries = 3) => {
    setLoadingAgents(true);
    setChatHistory({});
    setExpandedSession(null);
    try {
      const result = await invoke<unknown>("list_agents");
      const list = Array.isArray(result) ? result : (result as Record<string, unknown>)?.agents ?? (result as Record<string, unknown>)?.list ?? [];
      setAgents(Array.isArray(list) ? list as AgentInfo[] : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Operator WS may still be authenticating after node WS connected — retry
      if (msg.includes("not authenticated yet") && retries > 0) {
        await new Promise((r) => setTimeout(r, 1500));
        return loadAgents(retries - 1);
      }
      pushActivity("error", t("events.agent_load_failed", { msg }));
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
      pushActivity("error", t("events.session_load_failed", { msg: err instanceof Error ? err.message : String(err) }));
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
        pushActivity("error", t("events.chat_load_failed", { msg: err instanceof Error ? err.message : String(err) }));
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
      : `[系统通知] 本地节点 "${nodeName}" 已连接。\n- Node ID: ${config.nodeId}\n- 环境: 本地\n- 能力: 命令执行 (system.run)\n\n当用户的请求需要在本地环境执行时，你可以使用这个节点。${cdpBlock}`;
    try {
      await invoke("inject_message", { sessionKey, content: message });
      setNotifiedSessions((prev) => {
        const next = new Set(prev);
        if (isLinked) {
          next.delete(sessionKey);
          pushActivity("info", t("events.session_unlinked", { key: sessionKey.slice(0, 8) }));
        } else {
          next.add(sessionKey);
          pushActivity("info", t("events.session_linked", { key: sessionKey.slice(0, 8) }));
        }
        return next;
      });
    } catch (err) {
      pushActivity("error", t("events.action_failed", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const connect = async (force = false) => {
    setBusy(true);
    setError(null);
    const target = `${server.user}@${server.host}`;
    pushActivity("info", force ? t("events.connect_force", { target }) : t("events.connect_init", { target }));
    try {
      await invoke("connect", { server, gatewayToken, nodeId: config.nodeId, nodeName, force });
      pushActivity("info", t("events.tunnel_ok"));
      patchConfig({ server, gatewayToken, nodeName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", t("events.connect_failed", { msg: message }));
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    setBusy(true);
    setError(null);

    // Send disconnect notifications to all notified sessions
    if (notifiedSessions.size > 0) {
      pushActivity("info", t("events.disconnect_notify", { count: notifiedSessions.size }));
      const disconnectMsg = `[系统通知] 本地节点 "${nodeName}" 已断开，不再可用。`;
      for (const sessionKey of notifiedSessions) {
        try {
          await invoke("inject_message", { sessionKey, content: disconnectMsg });
        } catch { /* best-effort notification */ }
      }
      setNotifiedSessions(new Set());
    }

    pushActivity("info", t("events.disconnect_init"));
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
      pushActivity("info", t("events.disconnected"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", t("events.disconnect_failed", { msg: message }));
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
      if (result.running) {
        pushActivity("info", t("events.chrome_started", { cdp: cdpPort, remote: cdpRemotePort }));
      } else {
        pushActivity("error", t("events.chrome_cdp_failed"));
      }
      patchConfig({ cdpPort, cdpRemotePort });
    } catch (err) {
      pushActivity("error", t("events.chrome_start_failed", { msg: err instanceof Error ? err.message : String(err) }));
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
      pushActivity("info", t("events.chrome_stopped"));
    } catch (err) {
      pushActivity("error", t("events.chrome_stop_failed", { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBrowserBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-20">

      <div className="lg:col-span-7 space-y-6">
        {/* ── Connection Form ── */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <CardTitle>
              <Server className="w-5 h-5 text-primary" />
              {t("connection.tunnel_title")}
            </CardTitle>
            <div className="flex items-center gap-2 bg-background border border-border rounded-full px-3 py-1 font-mono text-xs">
              <span className={statusClass} />
              <span className="text-foreground">{statusText}</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="host">{t("connection.host")}</label>
                <Input
                  id="host"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.host}
                  onChange={(e) => setServer((p) => ({ ...p, host: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="user">{t("connection.user")}</label>
                <Input
                  id="user"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.user}
                  onChange={(e) => setServer((p) => ({ ...p, user: e.target.value }))}
                />
              </div>
              <div className="md:col-span-2 lg:col-span-1">
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="nodeName">{t("connection.node_name")}</label>
                <Input
                  id="nodeName"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder={t("connection.node_name_placeholder")}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="gatewayToken">{t("connection.gateway_token")}</label>
                <Input
                  id="gatewayToken"
                  type="password"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={gatewayToken}
                  onChange={(e) => setGatewayToken(e.target.value)}
                  placeholder={t("connection.gateway_token_placeholder")}
                />
              </div>
              <div className="md:col-span-2 lg:col-span-1">
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="keyPath">{t("connection.key_path")}</label>
                <Input
                  id="keyPath"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={server.keyPath}
                  onChange={(e) => setServer((p) => ({ ...p, keyPath: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="remotePort">{t("connection.remote_port")}</label>
                <Input
                  id="remotePort"
                  type="number"
                  value={server.remotePort}
                  onChange={(e) => setServer((p) => ({ ...p, remotePort: Number(e.target.value) || 18789 }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="localPort">{t("connection.local_port")}</label>
                <Input
                  id="localPort"
                  type="number"
                  value={server.localPort}
                  onChange={(e) => setServer((p) => ({ ...p, localPort: Number(e.target.value) || 18789 }))}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => connect()} disabled={busy} variant={fullyConnected ? "secondary" : "default"}>
                <RefreshCw className={`w-4 h-4 mr-2 ${busy ? 'animate-spin' : ''}`} />
                {busy ? t("connection.processing") : (fullyConnected ? t("connection.reconnect") : t("connection.connect"))}
              </Button>

              <Button onClick={doDisconnect} disabled={busy || (!isConnected && status.tunnelState === "disconnected")} variant="destructive">
                <Unplug className="w-4 h-4 mr-2" />
                {t("connection.disconnect")}
              </Button>

              {fullyConnected && (
                <Button onClick={openGateway} variant="outline" className="ml-auto border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                  <Globe className="w-4 h-4 mr-2" />
                  {t("connection.console")}
                </Button>
              )}
            </div>

            {status.tunnelLastError && (
              <div className="mt-4 flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-lg border border-destructive/20">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p>{t("connection.recent_error", { msg: status.tunnelLastError })}</p>
              </div>
            )}
            {error && (
              <div className="mt-4 flex items-start gap-2 text-sm text-destructive bg-destructive/10 p-3 rounded-lg border border-destructive/20">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div className="flex-1">
                  <p>{error}</p>
                  {error.includes("already in use") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 text-xs border-destructive/50 text-destructive hover:bg-destructive/20"
                      disabled={busy}
                      onClick={() => connect(true)}
                    >
                      {t("connection.force_connect")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Browser CDP ── */}
        {fullyConnected && (
          <Card className="animate-in fade-in slide-in-from-bottom-4">
            <CardHeader className="flex flex-row items-center justify-between pb-4">
              <CardTitle>
                <Chrome className="w-5 h-5 text-blue-500" />
                {t("browser.title")}
              </CardTitle>
              <div className="flex items-center gap-2 bg-background border border-border rounded-full px-3 py-1 font-mono text-xs">
                <span className={browserRunning && browserTunnelRunning ? "status-dot status-dot-online" : browserRunning ? "status-dot status-dot-pending" : "status-dot status-dot-offline"} />
                <span className="text-foreground">
                  {browserRunning && browserTunnelRunning ? t("browser.status_tunnel_ready") : browserRunning ? t("browser.status_running") : t("browser.status_stopped")}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="cdpPort">{t("browser.cdp_local")}</label>
                  <Input
                    id="cdpPort"
                    type="number"
                    value={cdpPort}
                    onChange={(e) => setCdpPort(Number(e.target.value) || 9222)}
                    disabled={browserRunning}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5" htmlFor="cdpRemotePort">{t("browser.cdp_remote")}</label>
                  <Input
                    id="cdpRemotePort"
                    type="number"
                    value={cdpRemotePort}
                    onChange={(e) => setCdpRemotePort(Number(e.target.value) || 19222)}
                    disabled={browserRunning}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                {!browserRunning ? (
                  <Button onClick={startBrowser} disabled={browserBusy} className="bg-blue-600 hover:bg-blue-700 text-white border-blue-600">
                    <Play className="w-4 h-4 mr-2" />
                    {browserBusy ? t("browser.starting") : t("browser.start")}
                  </Button>
                ) : (
                  <Button onClick={stopBrowser} disabled={browserBusy} variant="destructive">
                    <Square className="w-4 h-4 mr-2" />
                    {browserBusy ? t("browser.stopping") : t("browser.stop")}
                  </Button>
                )}
              </div>

              {browserRunning && browserTunnelRunning && (
                <div className="mt-4 text-sm text-foreground bg-accent/50 p-3 rounded-lg border border-border flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                  <p dangerouslySetInnerHTML={{ __html: t("browser.cdp_ready", { port: cdpRemotePort }) }} />
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="lg:col-span-5 space-y-6">
        {/* ── Agent Notification ── */}
        {fullyConnected && (
          <Card className="animate-in fade-in slide-in-from-bottom-4 h-[400px] flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between pb-4">
              <CardTitle>
                <Activity className="w-5 h-5 text-purple-500" />
                {t("agents.title")}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={() => loadAgents()} disabled={loadingAgents} className="h-8 w-8 text-muted-foreground hover:text-foreground">
                <RefreshCw className={`w-4 h-4 ${loadingAgents ? 'animate-spin' : ''}`} />
              </Button>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto pt-0">
              {agents.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground/60 gap-3">
                  <MessageSquare className="w-10 h-10 opacity-20" />
                  <p className="text-sm">
                    {loadingAgents ? t("agents.loading") : t("agents.empty")}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {agents.map((agent) => (
                    <li key={agent.id} className="bg-background rounded-lg border border-border overflow-hidden shadow-sm">
                      <button
                        className="w-full flex items-center gap-3 p-3 hover:bg-accent/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => toggleAgent(agent.id)}
                      >
                        {expandedAgent === agent.id ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        )}
                        <span className="font-medium text-foreground truncate">
                          {agent.displayName || agent.id}
                        </span>
                        {sessionsByAgent[agent.id] && (
                          <Badge variant="secondary" className="ml-auto text-xs py-0 h-5 border border-border bg-muted">
                            {sessionsByAgent[agent.id].length}
                          </Badge>
                        )}
                      </button>

                      {expandedAgent === agent.id && (
                        <div className="bg-muted/30 p-2 border-t border-border">
                          <ul className="space-y-1.5">
                            {!sessionsByAgent[agent.id] ? (
                              <li className="text-sm text-muted-foreground/70 p-2 text-center animate-pulse">{t("agents.loading_sessions")}</li>
                            ) : sessionsByAgent[agent.id].length === 0 ? (
                              <li className="text-sm text-muted-foreground/70 p-2 text-center">{t("agents.no_sessions")}</li>
                            ) : (
                              sessionsByAgent[agent.id].map((session) => (
                                <li key={session.key} className="bg-background rounded-md border border-border shadow-sm">
                                  <div className="flex items-center gap-2 p-2">
                                    <button
                                      className="flex-1 flex items-center gap-2 min-w-0 hover:text-primary transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
                                      title={session.displayName || session.key}
                                      onClick={() => toggleSession(session.key)}
                                    >
                                      {expandedSession === session.key ? (
                                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                      ) : (
                                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                      )}
                                      <span className="font-mono text-xs text-foreground/80 truncate">
                                        {session.displayName || session.key}
                                      </span>
                                    </button>
                                    <Button
                                      size="sm"
                                      variant={notifiedSessions.has(session.key) ? "destructive" : "secondary"}
                                      className={`h-7 text-xs px-2 shrink-0 ${notifiedSessions.has(session.key) ? '' : 'text-primary bg-primary/10 border-primary/20 hover:bg-primary/20 hover:text-primary'}`}
                                      onClick={() => toggleNotify(session.key)}
                                    >
                                      {notifiedSessions.has(session.key) ? t("agents.disconnect") : t("agents.inject")}
                                    </Button>
                                  </div>

                                  {expandedSession === session.key && (
                                    <div className="px-2 pb-2">
                                      <div className="bg-accent/40 border border-border rounded p-2 max-h-48 overflow-y-auto space-y-2 font-mono text-xs">
                                        {loadingHistory === session.key ? (
                                          <p className="text-muted-foreground/70 italic text-center">{t("agents.loading_history")}</p>
                                        ) : !chatHistory[session.key] || chatHistory[session.key].length === 0 ? (
                                          <p className="text-muted-foreground/70 italic text-center">{t("agents.empty_history")}</p>
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
                                                <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded border ${isUser ? 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800/50' : 'bg-primary/10 text-primary border-primary/20 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50'}`}>
                                                  {isUser ? t("agents.role_user") : t("agents.role_ai")}
                                                </span>
                                                <div className={`p-1.5 rounded-md max-w-[90%] break-words border ${isUser ? 'bg-background text-foreground/90 border-border shadow-sm' : 'bg-transparent text-muted-foreground border-transparent'}`}>
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
        <Card className={`flex flex-col ${fullyConnected ? 'h-[400px]' : 'h-[600px]'}`}>
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <CardTitle>
              <Terminal className="w-5 h-5 text-muted-foreground" />
              {t("activity.title")}
            </CardTitle>
            {entries.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearActivity} className="h-8 text-xs text-muted-foreground hover:text-foreground">
                {t("activity.clear")}
              </Button>
            )}
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto pt-0 font-mono text-xs">
            {entries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground/50 italic">
                {t("activity.waiting")}
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 hover:bg-accent/50 p-1.5 rounded transition-colors group">
                    <span className="text-muted-foreground/60 shrink-0 select-none">[{entry.timestamp}]</span>
                    <span className={`shrink-0 ${entry.level === 'info' ? 'text-primary' : 'text-destructive'}`}>
                      {entry.level === 'info' ? '→' : '✕'}
                    </span>
                    <span className={`break-words ${entry.level === 'info' ? 'text-foreground/90' : 'text-destructive/90'}`}>
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
