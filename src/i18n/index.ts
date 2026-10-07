import { createInstance } from "i18next";
import { catalogs } from "./catalogs.js";
import type { Language, MessageDescriptor, MessageParams } from "./types.js";

export * from "./types.js";
export * from "./registry.js";
export * from "./format.js";

export const i18n = createInstance();
void i18n.init({
  resources: Object.fromEntries(Object.entries(catalogs).map(([language, modules]) => [language, { translation: Object.assign({}, ...Object.values(modules)) }])),
  lng: "en", supportedLngs: ["zh-CN", "en"], fallbackLng: "en", load: "currentOnly",
  initAsync: false, keySeparator: false, nsSeparator: false,
  interpolation: { escapeValue: false }, returnNull: false, returnEmptyString: false,
});

/** 未登记文案使用英文兜底，不向产品显示稳定标识。 */
export function translate(language: Language, key: string, params?: MessageParams): string {
  const fallback = i18n.t("common.translationUnavailable", { lng: "en" });
  return i18n.t(key, { ...params, lng: language, defaultValue: fallback });
}

export function translateMessage(language: Language, message: MessageDescriptor): string {
  return translate(language, message.key, message.params);
}

/** 服务旧标识可能已不在目录中；只有可识别描述才能替代原始内容。 */
export function isMessageDescriptorKnown(message: MessageDescriptor | undefined): message is MessageDescriptor {
  return !!message && i18n.exists(message.key, { ...message.params, lng: "en" });
}

export function translateMessageOrOriginal(language: Language, message: MessageDescriptor | undefined, original?: string): string {
  return isMessageDescriptorKnown(message) ? translateMessage(language, message) : original ?? translate(language, "common.notRecorded");
}
