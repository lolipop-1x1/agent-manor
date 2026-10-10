export const themePresets = { blue: "#3268d4", terracotta: "#b75537", celadon: "#28786a", amber: "#9b6818", berry: "#a84272", graphite: "#566171" } as const;
export type ThemeMode = "auto" | "light" | "dark";
export type ThemePreset = keyof typeof themePresets | "custom";
export interface Appearance { mode: ThemeMode; preset: ThemePreset; customColor: string }
export const defaultAppearance: Appearance = { mode: "auto", preset: "blue", customColor: "#3268d4" };
export const isThemeColor = (value: unknown): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
export function isAppearancePatch(value: unknown): value is Partial<Appearance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  return Object.keys(patch).length > 0 && Object.keys(patch).every(key => ["mode", "preset", "customColor"].includes(key))
    && (!("mode" in patch) || ["auto", "light", "dark"].includes(patch.mode as string))
    && (!("preset" in patch) || typeof patch.preset === "string" && (patch.preset === "custom" || Object.hasOwn(themePresets, patch.preset)))
    && (!("customColor" in patch) || isThemeColor(patch.customColor));
}
export function isAppearance(value: unknown): value is Appearance {
  return isAppearancePatch(value) && "mode" in value && "preset" in value && "customColor" in value;
}
const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
export function mixColor(first: string, second: string, amount: number): string {
  const other = rgb(second);
  return `#${rgb(first).map((value, index) => Math.round(value + (other[index]! - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}
function luminance(color: string): number {
  const channels = rgb(color).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}
export const contrastRatio = (first: string, second: string): number => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05);
function readableAccent(color: string, background: string, dark: boolean): string {
  let adjusted = color;
  for (let step = 1; contrastRatio(adjusted, background) < 4.5 && step <= 100; step++) adjusted = mixColor(color, dark ? "#ffffff" : "#000000", step / 100);
  return adjusted;
}
/** 单一色种派生明暗色阶；状态色不参与外观替换。 */
export function appearanceVariables(appearance: Appearance, theme: "light" | "dark"): Record<string, string> {
  const dark = theme === "dark", surface = dark ? "#171d28" : "#ffffff";
  const seed = appearance.preset === "custom" ? appearance.customColor : themePresets[appearance.preset];
  let accent = readableAccent(seed, surface, dark);
  // 选中项使用浅色底，主题文字也需要在这些背景上保持可读。
  const alternate = dark ? "#1d2635" : "#f3f6fb";
  for (let step = 1; step <= 100 && (contrastRatio(accent, mixColor(surface, accent, .11)) < 4.5 || contrastRatio(accent, alternate) < 4.5); step++) accent = mixColor(seed, dark ? "#ffffff" : "#000000", step / 100);
  const foreground = contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#111722") ? "#ffffff" : "#111722";
  const variables: Record<string, string> = { "--accent": accent, "--accent-hover": mixColor(accent, dark ? "#ffffff" : "#000000", .12), "--accent-soft": mixColor(surface, accent, .11), "--on-accent": foreground, "--map-strong-text": dark ? "#111722" : "#ffffff", "--code-exact": mixColor(surface, accent, .15) };
  const strong = readableAccent(seed, dark ? "#111722" : "#ffffff", dark);
  [0.055, .17, .34, .58, 1].forEach((amount, index) => { variables[`--map-${index}`] = mixColor(surface, strong, amount); });
  for (let index = 0; index <= 4; index++) {
    const color = variables[`--map-${index}`]!;
    variables[`--map-${index}-text`] = contrastRatio(color, "#ffffff") >= contrastRatio(color, "#000000") ? "#ffffff" : "#000000";
    const borderSeed = dark ? "#5c6c82" : "#a6b4ca";
    const borderTarget = contrastRatio(color, "#19273c") >= contrastRatio(color, "#e7edf7") ? "#19273c" : "#e7edf7";
    let border = borderSeed;
    for (let step = 1; contrastRatio(color, border) < 2 && step <= 100; step++) border = mixColor(borderSeed, borderTarget, step / 100);
    variables[`--map-${index}-border`] = border;
  }
  return variables;
}
