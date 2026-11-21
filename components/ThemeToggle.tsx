"use client";
import { useSyncExternalStore } from "react";

type Theme = "dark" | "light";

const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};

/** Runs in <head> before paint so a stored "white" choice never flashes black. */
export const themeBootScript = `(function(){try{var t=localStorage.getItem("theme");if(!t&&window.matchMedia("(prefers-color-scheme: light)").matches)t="light";if(t==="light")document.documentElement.dataset.theme="light"}catch(e){}})();`;

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, () => "dark" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        if (next === "light") document.documentElement.dataset.theme = "light";
        else delete document.documentElement.dataset.theme;
        try { localStorage.setItem("theme", next); } catch { /* private mode: choice lasts this visit */ }
      }}
      aria-label={`switch to ${next === "light" ? "white" : "black"} theme`}
      className="bg-surface hover:bg-surface-2 text-heading text-sm px-3 py-1.5 rounded-sm active:scale-95 transition"
    >
      {theme === "dark" ? "◐ white" : "◑ black"}
    </button>
  );
}
