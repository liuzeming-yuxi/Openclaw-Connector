import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionPage } from "./pages/ConnectionPage";
import { useConfigStore } from "./store/useConfigStore";
import type { AppConfig } from "./types/config";
import { Terminal, ShieldCheck, Sun, Moon, Monitor, Languages } from "lucide-react";
import { useThemeStore } from "./store/useThemeStore";
import { useLanguageStore } from "./store/useLanguageStore";

export default function App() {
  const setConfig = useConfigStore((s) => s.setConfig);
  const theme = useThemeStore((s) => s.theme);
  const lang = useLanguageStore((s) => s.lang);
  const { t } = useTranslation();

  useEffect(() => {
    // Clear leftover localStorage from previous versions
    localStorage.removeItem("openclaw-connector-config");

    invoke("load_app_config")
      .then((cfg) => {
        if (cfg) setConfig(cfg as AppConfig);
      })
      .catch((err) => {
        console.warn("[config] failed to load from backend, using defaults:", err);
      });
  }, [setConfig]);

  return (
    <main className="max-w-[1040px] mx-auto px-4 md:px-6 py-8 min-h-screen">
      <header className="mb-8 p-6 md:p-8 rounded-2xl bg-gradient-to-br from-card to-background border border-border shadow-xl relative overflow-hidden transition-colors">
        <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 rounded-full bg-blue-500/10 blur-3xl pointer-events-none"></div>

        <div className="relative z-10 flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-primary mb-2">
              <Terminal className="w-6 h-6" />
              <span className="font-mono text-sm tracking-widest font-bold uppercase">OpenClaw Node</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
              {t("app.title")}
            </h1>
            <p className="text-muted-foreground max-w-lg text-sm md:text-base leading-relaxed">
              {t("app.subtitle")}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => useLanguageStore.getState().toggleLang()}
              className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 shadow-inner hover:bg-accent transition-colors cursor-pointer"
              title={lang === "zh" ? "Switch to English" : "切换到中文"}
            >
              <Languages className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium text-foreground">
                {lang === "zh" ? "EN" : "中"}
              </span>
            </button>

            <button
              onClick={() => useThemeStore.getState().cycleTheme()}
              className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 shadow-inner hover:bg-accent transition-colors cursor-pointer"
              title={theme === "dark" ? t("app.theme_title_dark") : theme === "light" ? t("app.theme_title_light") : t("app.theme_title_system")}
            >
              {theme === "dark" ? <Moon className="w-4 h-4 text-primary" /> :
               theme === "light" ? <Sun className="w-4 h-4 text-amber-500" /> :
               <Monitor className="w-4 h-4 text-blue-400" />}
              <span className="text-xs font-medium text-foreground">
                {theme === "dark" ? t("app.theme_dark") : theme === "light" ? t("app.theme_light") : t("app.theme_system")}
              </span>
            </button>

            <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-4 py-2 shadow-inner">
              <ShieldCheck className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium text-muted-foreground">{t("app.e2e")}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <ConnectionPage />
      </div>
    </main>
  );
}
