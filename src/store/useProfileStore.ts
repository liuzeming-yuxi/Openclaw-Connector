import { useConfigStore } from "./useConfigStore";
import {
  createDefaultProfile,
  type ConnectionProfile,
} from "../types/config";

export function getProfiles(): ConnectionProfile[] {
  return useConfigStore.getState().config.profiles;
}

export function getActiveProfile(): ConnectionProfile | null {
  const { profiles, activeProfileId } = useConfigStore.getState().config;
  if (!activeProfileId) return profiles[0] ?? null;
  return profiles.find((p) => p.id === activeProfileId) ?? null;
}

export function addProfile(profile: ConnectionProfile) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  store.setConfig({
    ...cfg,
    profiles: [...cfg.profiles, profile],
    activeProfileId: profile.id,
  });
}

export function updateProfile(
  id: string,
  patch: Partial<ConnectionProfile>,
) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  store.setConfig({
    ...cfg,
    profiles: cfg.profiles.map((p) =>
      p.id === id ? { ...p, ...patch, server: { ...p.server, ...(patch.server ?? {}) } } : p,
    ),
  });
}

export function removeProfile(id: string) {
  const store = useConfigStore.getState();
  const cfg = store.config;
  const remaining = cfg.profiles.filter((p) => p.id !== id);
  store.setConfig({
    ...cfg,
    profiles: remaining,
    activeProfileId:
      cfg.activeProfileId === id
        ? remaining[0]?.id ?? null
        : cfg.activeProfileId,
  });
}

export function setActiveProfileId(id: string | null) {
  const store = useConfigStore.getState();
  store.patchConfig({ activeProfileId: id });
}

export { createDefaultProfile };
