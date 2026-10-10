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
    for (const [name, value] of Object.entries(appearanceVariables(appearance, theme))) document.documentElement.style.setProperty(name, value);
  }, [appearance, theme]);
  return theme;
}
