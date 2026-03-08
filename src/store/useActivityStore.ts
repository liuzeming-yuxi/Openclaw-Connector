import { create } from "zustand";

export type ActivityLevel = "info" | "error";

export type ActivityEntry = {
  id: string;
  level: ActivityLevel;
  message: string;
  timestamp: string;
};

type ActivityState = {
  entries: ActivityEntry[];
  push: (level: ActivityLevel, message: string) => void;
  clear: () => void;
};

export const useActivityStore = create<ActivityState>((set) => ({
  entries: [],
  push: (level, message) =>
    set((state) => ({
      entries: [
        {
          id: crypto.randomUUID(),
          level,
          message,
          timestamp: new Date().toLocaleTimeString()
        },
        ...state.entries
      ].slice(0, 200)
    })),
  clear: () => set({ entries: [] })
}));
