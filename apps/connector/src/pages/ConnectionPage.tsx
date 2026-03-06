import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { useActivityStore } from "../store/useActivityStore";
import { useConfigStore } from "../store/useConfigStore";
import type { TunnelStatus } from "../types/tunnel";

function prettyState(state: TunnelStatus["state"]): string {
  switch (state) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    default:
      return "未连接";
  }
}

export function ConnectionPage() {
  const config = useConfigStore((s) => s.config);
  const [server, setServer] = useState(config.server);
  const [status, setStatus] = useState<TunnelStatus>({
    state: "disconnected",
    reconnectAttempts: 0,
    lastError: null
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushActivity = useActivityStore((s) => s.push);

  const statusClass = useMemo(() => {
    if (status.state === "connected") {
      return "status-dot online";
    }
    if (status.state === "connecting" || status.state === "reconnecting") {
      return "status-dot pending";
    }
    return "status-dot offline";
  }, [status.state]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    pushActivity("info", `发起连接：${server.user}@${server.host}`);

    try {
      const next = await invoke<TunnelStatus>("start_tunnel", { server });
      setStatus(next);
      pushActivity("info", `隧道状态 -> ${prettyState(next.state)}`);
      // Persist config on successful connection
      await invoke("save_app_config", {
        cfg: { ...config, server }
      }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", `连接失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    pushActivity("info", "发起断开");

    try {
      const next = await invoke<TunnelStatus>("stop_tunnel");
      setStatus(next);
      pushActivity("info", "隧道已断开");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", `断开失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshStatus = async () => {
    try {
      const next = await invoke<TunnelStatus>("get_tunnel_status");
      setStatus(next);
      pushActivity("info", `状态刷新 -> ${prettyState(next.state)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushActivity("error", `状态刷新失败：${message}`);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <h2>连接</h2>
        <div className="status-chip" aria-live="polite">
          <span className={statusClass} />
          {prettyState(status.state)}
        </div>
      </div>

      <div className="form-grid">
        <label>
          主机
          <input
            aria-label="主机"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={server.host}
            onChange={(e) => setServer((prev) => ({ ...prev, host: e.target.value }))}
          />
        </label>
        <label>
          用户
          <input
            aria-label="用户"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={server.user}
            onChange={(e) => setServer((prev) => ({ ...prev, user: e.target.value }))}
          />
        </label>
        <label>
          密钥路径
          <input
            aria-label="密钥路径"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={server.keyPath}
            onChange={(e) => setServer((prev) => ({ ...prev, keyPath: e.target.value }))}
          />
        </label>
      </div>

      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>
          {busy ? "处理中..." : "连接"}
        </button>
        <button type="button" className="btn" onClick={disconnect} disabled={busy}>
          断开
        </button>
        <button type="button" className="btn" onClick={refreshStatus} disabled={busy}>
          刷新
        </button>
      </div>

      <p className="hint">
        重连次数：{status.reconnectAttempts}
        {status.lastError ? ` | 最近错误：${status.lastError}` : ""}
      </p>
      {error && <p className="error-banner">{error}</p>}
    </section>
  );
}
