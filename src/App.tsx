import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { ConnectionPage } from "./pages/ConnectionPage";
import { useConfigStore } from "./store/useConfigStore";
import type { ConnectorConfig } from "./types/config";
import { Terminal, ShieldCheck } from "lucide-react";

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
    <main className="max-w-[1040px] mx-auto px-4 md:px-6 py-8 min-h-screen">
      <header className="mb-8 p-6 md:p-8 rounded-2xl bg-gradient-to-br from-[#1E293B] to-[#0F172A] border border-border shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl pointer-events-none"></div>
        
        <div className="relative z-10 flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-primary mb-2">
              <Terminal className="w-6 h-6" />
              <span className="font-mono text-sm tracking-widest font-bold uppercase">OpenClaw Node</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              连接器控制台
            </h1>
            <p className="text-slate-400 max-w-lg text-sm md:text-base leading-relaxed">
              被动 Node 客户端，通过加密 SSH 隧道接收网关任务，在完全隔离的环境下安全执行本地指令。
            </p>
          </div>
          
          <div className="flex items-center gap-2 bg-[#0F172A] border border-border rounded-lg px-4 py-2 shadow-inner">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium text-slate-300">端到端加密</span>
          </div>
        </div>
      </header>
      
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <ConnectionPage />
      </div>
    </main>
  );
}
