import { useLayoutEffect, useState } from "react";
import { appearanceVariables, type Appearance } from "../../src/appearance";
export type Theme = "light" | "dark";
export function useTheme(appearance: Appearance): Theme {
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const synchronize = () => setSystemDark(media.matches);
    synchronize(); media.addEventListener("change", synchronize);
    return () => media.removeEventListener("change", synchronize);
  }, []);
  const theme = appearance.mode === "auto" ? systemDark ? "dark" : "light" : appearance.mode;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const colors = appearanceVariables(appearance, theme);
    for (const [name, value] of Object.entries(colors)) document.documentElement.style.setProperty(name, value);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const mark = document.querySelector<SVGElement>(".brand svg");
    if (icon && mark) {
      // 复用页头领结的几何形状，标签图标与应用采用同一套主题对比色。
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${colors["--accent"]}"/><g fill="${colors["--on-accent"]}">${mark.innerHTML}</g></svg>`;
      icon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
  }, [appearance, theme]);
  return theme;
}
