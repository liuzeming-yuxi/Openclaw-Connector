import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { ConnectionPage } from "./pages/ConnectionPage";
import { useConfigStore } from "./store/useConfigStore";
import type { ConnectorConfig } from "./types/config";

export default function App() {
  const setConfig = useConfigStore((s) => s.setConfig);

  useEffect(() => {
    invoke("load_app_config")
      .then((cfg) => {
        if (cfg) setConfig(cfg as ConnectorConfig);
      })
      .catch(() => {});
  }, [setConfig]);

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <h1>OpenClaw 连接器</h1>
          <p>被动 Node 客户端，通过 SSH 隧道接收 Gateway 任务并在本机执行。</p>
        </div>
      </header>
      <ConnectionPage />
    </main>
  );
}
