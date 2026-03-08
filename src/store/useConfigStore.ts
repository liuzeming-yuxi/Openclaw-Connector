import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDefaultConfig, type ConnectorConfig } from "../types/config";

type ConfigState = {
  config: ConnectorConfig;
  setConfig: (config: ConnectorConfig) => void;
  patchConfig: (patch: Partial<ConnectorConfig>) => void;
};

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      config: createDefaultConfig(),
      setConfig: (config) => set({ config }),
      patchConfig: (patch) =>
        set((state) => ({
          config: {
            ...state.config,
            ...patch,
            server: {
              ...state.config.server,
              ...(patch.server ?? {})
            },
            runtime: {
              ...state.config.runtime,
              ...(patch.runtime ?? {})
            }
          }
        }))
    }),
    {
      name: "openclaw-connector-config",
      storage: createJSONStorage(() => localStorage)
    }
  )
);
