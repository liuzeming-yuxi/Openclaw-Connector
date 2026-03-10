import { create } from "zustand";

type Theme = "light" | "dark" | "system";

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  cycleTheme: () => void;
};

function getEffectiveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function applyTheme(theme: Theme) {
  const effective = getEffectiveTheme(theme);
  document.documentElement.classList.toggle("dark", effective === "dark");
}

const stored = localStorage.getItem("openclaw-theme") as Theme | null;
const initial: Theme = stored && ["light", "dark", "system"].includes(stored) ? stored : "dark";
applyTheme(initial);

export const useThemeStore = create<ThemeState>()((set, get) => ({
  theme: initial,
  setTheme: (theme) => {
    localStorage.setItem("openclaw-theme", theme);
    applyTheme(theme);
    set({ theme });
  },
  cycleTheme: () => {
    const order: Theme[] = ["dark", "light", "system"];
    const current = get().theme;
    const next = order[(order.indexOf(current) + 1) % order.length];
    get().setTheme(next);
  },
}));

if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { theme } = useThemeStore.getState();
    if (theme === "system") applyTheme(theme);
  });
}
