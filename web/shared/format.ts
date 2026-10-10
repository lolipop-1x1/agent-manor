import { formatDateTime, formatNumber, formatPercent } from "../../src/i18n";
import { getLanguage, t } from "./i18n";

export const fmt = (value: number) => formatNumber(getLanguage(), value);
export const percent = (numerator: number, denominator: number) => denominator ? formatPercent(getLanguage(), numerator / denominator, { minimumFractionDigits: 1 }) : "—";
export const dateLabel = (value?: string) => value ? formatDateTime(getLanguage(), value, { dateStyle: "medium", timeStyle: "medium", hour12: false }) : t("common.timeUnknown");
