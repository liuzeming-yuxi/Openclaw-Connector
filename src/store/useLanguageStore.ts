import { create } from "zustand";
import i18n from "../i18n";

type Lang = "zh" | "en";

type LangState = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
};

const stored = localStorage.getItem("openclaw-lang") as Lang | null;
const initial: Lang = stored && ["zh", "en"].includes(stored) ? stored : "zh";

export const useLanguageStore = create<LangState>()((set, get) => ({
  lang: initial,
  setLang: (lang) => {
    localStorage.setItem("openclaw-lang", lang);
    i18n.changeLanguage(lang);
    set({ lang });
  },
  toggleLang: () => {
    const next = get().lang === "zh" ? "en" : "zh";
    get().setLang(next);
  },
}));
