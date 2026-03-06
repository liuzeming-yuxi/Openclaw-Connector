import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useActivityStore } from "../store/useActivityStore";
import { useBindingsStore } from "../store/useBindingsStore";

export function ActivityPage() {
  const entries = useActivityStore((s) => s.entries);
  const clear = useActivityStore((s) => s.clear);
  const pushActivity = useActivityStore((s) => s.push);
  const bindings = useBindingsStore((s) => s.bindings);

  const [agentId, setAgentId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);

  const agentIds = Object.keys(bindings);

  const execute = async () => {
    if (!command.trim()) return;
    setBusy(true);

    const selectedAgent = agentId || agentIds[0] || "default";
    const selectedNode = nodeId || "local";

    pushActivity("info", `执行任务：[${selectedAgent}] ${command}`);

    try {
      const result = await invoke<{
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      }>("execute_task", {
        localNodeId: selectedNode,
        task: {
          taskId: crypto.randomUUID(),
          agentId: selectedAgent,
          action: "system.run",
          args: { command },
          timeoutSec: 30
        }
      });

      pushActivity(
        result.exitCode === 0 ? "info" : "error",
        `[exit=${result.exitCode} ${result.durationMs}ms] ${result.stdout || result.stderr}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushActivity("error", `执行失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  const levelText = (level: "info" | "error") => (level === "info" ? "信息" : "错误");

  return (
    <section className="card">
      <div className="card-header">
        <h2>活动</h2>
        <button type="button" className="btn btn-small" onClick={clear}>
          清空
        </button>
      </div>

      <div className="execute-panel">
        <h3>快速执行</h3>
        <div className="form-grid two-col">
          <label>
            Agent
            <select
              aria-label="Agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">
                {agentIds.length ? "选择 Agent..." : "无绑定"}
              </option>
              {agentIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            本机 Node
            <input
              aria-label="本机 Node"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              placeholder="mac-node-1"
            />
          </label>
        </div>
        <label>
          命令
          <input
            aria-label="命令"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="echo hello"
            onKeyDown={(e) => {
              if (e.key === "Enter") execute();
            }}
          />
        </label>
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={execute}
            disabled={busy || !command.trim()}
          >
            {busy ? "执行中..." : "执行"}
          </button>
        </div>
      </div>

      <ul className="list">
        {entries.length === 0 && <li className="list-empty">暂无活动记录。</li>}
        {entries.map((entry) => (
          <li key={entry.id} className="list-row">
            <span className={`pill ${entry.level}`}>{levelText(entry.level)}</span>
            <span>{entry.message}</span>
            <time>{entry.timestamp}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
