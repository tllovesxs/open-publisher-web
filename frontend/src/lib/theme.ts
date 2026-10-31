import { useEffect, useState } from "react";

/**
 * 主题设置：浅色 / 深色 / 跟随系统。
 * 状态持久化在 localStorage，跨页面（App 外壳、设置页）通过
 * opw-theme-change 事件保持同步；system 模式监听 prefers-color-scheme。
 */

export type ThemeSetting = "light" | "dark" | "system";

const STORAGE_KEY = "opw-theme-setting";
const THEME_EVENT = "opw-theme-change";

export function getThemeSetting(): ThemeSetting {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

export function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return setting;
}

export function applyTheme(setting: ThemeSetting): "light" | "dark" {
  const resolved = resolveTheme(setting);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function setThemeSetting(setting: ThemeSetting): void {
  localStorage.setItem(STORAGE_KEY, setting);
  applyTheme(setting);
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

export function useThemeSetting(): {
  setting: ThemeSetting;
  resolved: "light" | "dark";
  setSetting: (next: ThemeSetting) => void;
} {
  const [setting, setSettingState] = useState<ThemeSetting>(() => getThemeSetting());
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveTheme(setting));

  useEffect(() => {
    setResolved(applyTheme(setting));
  }, [setting]);

  useEffect(() => {
    const sync = () => {
      const next = getThemeSetting();
      setSettingState(next);
      setResolved(applyTheme(next));
    };
    window.addEventListener(THEME_EVENT, sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) sync();
    };
    window.addEventListener("storage", onStorage);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (getThemeSetting() === "system") setResolved(applyTheme("system"));
    };
    media.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystem);
    };
  }, []);

  return { setting, resolved, setSetting: setThemeSetting };
}
