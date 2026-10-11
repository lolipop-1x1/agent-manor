import { useI18n } from "../../shared/i18n";
import { formatTokenMillions } from "./format";

export function TokenAmount({ value }: { value: number | null | undefined }) {
  const { language, t } = useI18n();
  return <span title={value == null ? undefined : t("usage.tokens.exact", { count: value })}>{formatTokenMillions(language, value)}</span>;
}
