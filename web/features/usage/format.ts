import { formatNumber } from "../../../src/i18n/format";
import type { Language } from "../../../src/i18n/types";

/** 百万单位只影响展示；较小正值增加精度，避免显示成零。 */
export function formatTokenMillions(language: Language, value: number | null | undefined): string {
  if (value == null) return "—";
  return `${formatNumber(language, value / 1e6, { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 10000 ? 6 : 2 })}M`;
}
