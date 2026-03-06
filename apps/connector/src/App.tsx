import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ActivityPage } from "./pages/ActivityPage";
import { BindingsPage } from "./pages/BindingsPage";
import { ConnectionPage } from "./pages/ConnectionPage";
import { DangerPage } from "./pages/DangerPage";
import { HealthPage } from "./pages/HealthPage";
import { useConfigStore } from "./store/useConfigStore";
import type { ConnectorConfig } from "./types/config";

const tabs = ["connection", "bindings", "health", "activity", "danger"] as const;
type Tab = (typeof tabs)[number];

const tabLabel: Record<Tab, string> = {
  connection: "连接",
  bindings: "绑定",
  health: "健康",
  activity: "活动",
  danger: "危险"
};

export default function App() {
  const [tab, setTab] = useState<Tab>("connection");
  const setConfig = useConfigStore((s) => s.setConfig);

  useEffect(() => {
    invoke("load_app_config")
      .then((cfg) => {
        if (cfg) setConfig(cfg as ConnectorConfig);
      })
      .catch(() => {
        // use default config from store
      });
  }, [setConfig]);

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <h1>OpenClaw 连接器</h1>
          <p>本地控制台，用于连接私有 Linux 网关并管理按 Agent 的本机绑定。</p>
        </div>
      </header>

      <nav className="tabbar" aria-label="Primary">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            className={`tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {tabLabel[t]}
          </button>
        ))}
      </nav>

      <section className="page-wrap">
        {tab === "connection" && <ConnectionPage />}
        {tab === "bindings" && <BindingsPage />}
        {tab === "health" && <HealthPage />}
        {tab === "activity" && <ActivityPage />}
        {tab === "danger" && <DangerPage />}
      </section>
    </main>
  );
}
