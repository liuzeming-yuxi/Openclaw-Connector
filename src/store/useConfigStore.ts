import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createDefaultConfig, type AppConfig } from "../types/config";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(cfg: AppConfig) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_app_config", { cfg }).catch((err) => {
      console.error("[config] auto-save failed:", err);
    });
  }, 300);
}

type ConfigState = {
  config: AppConfig;
  loaded: boolean;
  setConfig: (config: AppConfig) => void;
  patchConfig: (patch: Partial<AppConfig>) => void;
};

export const useConfigStore = create<ConfigState>()((set, get) => ({
  config: createDefaultConfig(),
  loaded: false,
  setConfig: (config) => {
    set({ config, loaded: true });
    debouncedSave(config);
  },
  patchConfig: (patch) => {
    const prev = get().config;
    const next = {
      ...prev,
      ...patch,
      runtime: { ...prev.runtime, ...(patch.runtime ?? {}) },
    };
    set({ config: next });
    debouncedSave(next);
  },
}));
