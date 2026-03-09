import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createDefaultConfig, type ConnectorConfig } from "../types/config";

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(cfg: ConnectorConfig) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_app_config", { cfg }).catch((err) => {
      console.error("[config] auto-save failed:", err);
    });
  }, 300);
}

type ConfigState = {
  config: ConnectorConfig;
  loaded: boolean;
  setConfig: (config: ConnectorConfig) => void;
  patchConfig: (patch: Partial<ConnectorConfig>) => void;
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
      server: { ...prev.server, ...(patch.server ?? {}) },
      runtime: { ...prev.runtime, ...(patch.runtime ?? {}) },
    };
    set({ config: next });
    debouncedSave(next);
  },
}));
