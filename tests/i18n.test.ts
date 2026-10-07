import assert from "node:assert/strict";
import test from "node:test";
import { catalogs } from "../src/i18n/catalogs.js";
import { detectLanguage, formatDate, formatDateTime, formatNumber, formatPercent, i18n, isMessageDescriptorKnown, translateMessageOrOriginal, languageRegistry, supportedLanguages, translate, translateMessage } from "../src/i18n/index.js";
import { validateCatalogs } from "../src/i18n/validate.js";

const copy = () => structuredClone(catalogs);

test("旧描述标识保留原始详情，可识别复数描述按参数查找", () => {
  const unknown = { key: "diagnostics.synthetic.obsolete", params: { count: 1 } };
  assert.equal(isMessageDescriptorKnown(unknown), false);
  assert.equal(isMessageDescriptorKnown(undefined), false);
  assert.equal(isMessageDescriptorKnown({ key: "common.itemCount", params: { count: 1 } }), true);
  for (const language of supportedLanguages) {
    assert.equal(translateMessageOrOriginal(language, unknown, "原始详情: synthetic"), "原始详情: synthetic");
    assert.equal(translateMessageOrOriginal(language, undefined, "真实同名原文"), "真实同名原文");
    assert.equal(translateMessageOrOriginal(language, { key: "common.itemCount", params: { count: 1 } }, "原始计数"), translate(language, "common.itemCount", { count: 1 }));
  }
});

test("自动检测按语言列表首个支持系列选择，未支持及系统通用环境回退英文", () => {
  assert.equal(detectLanguage(["fr-FR", "zh-Hant", "en-US"]), "zh-CN");
  assert.equal(detectLanguage(["de-DE", "en-GB", "zh-CN"]), "en");
  assert.equal(detectLanguage(["zh_TW.UTF-8"]), "zh-CN");
  assert.equal(detectLanguage(["EN_us.UTF-8"]), "en");
  for (const languages of [[], ["fr-FR"], ["C"], ["POSIX"], [undefined, "", " "]]) assert.equal(detectLanguage(languages), "en");
});

test("翻译使用参数及本语言复数，运行时缺失先回退英文且未知键不显示裸标识", () => {
  assert.equal(translate("en", "common.itemCount", { count: 1 }), "1 item");
  assert.equal(translate("en", "common.itemCount", { count: 2 }), "2 items");
  assert.equal(translate("en", "common.itemCount", { count: 0 }), "0 items");
  assert.equal(translate("en", "common.itemCount", { count: 1234 }), "1,234 items");
  assert.equal(translateMessage("zh-CN", { key: "common.itemCount", params: { count: 1 } }), "1 项");
  assert.equal(translateMessage("zh-CN", { key: "common.itemCount", params: { count: 2 } }), "2 项");
  i18n.addResource("en", "translation", "common.testFallback", "Saved {{name}}");
  try { assert.equal(translate("zh-CN", "common.testFallback", { name: "example" }), "Saved example"); }
  finally { delete i18n.getResourceBundle("en", "translation")["common.testFallback"]; }
  assert.equal(translate("zh-CN", "unknown.product.label"), "Translation unavailable");
});

test("数字、百分比及日期按显示语言格式化，保留输入数值、时区和时间", () => {
  const date = new Date("2026-10-07T08:15:00.000Z");
  const timestamp = date.toISOString();
  for (const language of supportedLanguages) {
    const locale = languageRegistry[language].formatLocale;
    assert.equal(formatNumber(language, 12345.6), new Intl.NumberFormat(locale).format(12345.6));
    assert.equal(formatPercent(language, 0.125), new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(0.125));
    assert.equal(formatDate(language, date, { dateStyle: "medium", timeZone: "UTC" }), new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date));
    assert.equal(formatDateTime(language, date, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }), new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date));
    assert.ok(languageRegistry[language].calendarLocale);
  }
  assert.equal(date.toISOString(), timestamp);
  assert.notEqual(formatDate("en", date), formatDate("zh-CN", date));
});

test("完整目录通过；缺少消息、目录或参数差异使检查失败", () => {
  assert.deepEqual(validateCatalogs(), []);
  const missing = copy();
  delete missing["zh-CN"].common["common.loading"];
  assert.ok(validateCatalogs(missing).some(value => value.includes("common.loading")));
  const different = copy();
  different["zh-CN"].common["common.loading"] = "加载 {{name}}";
  assert.ok(validateCatalogs(different).some(value => value.includes("参数")));
  const absent = copy();
  delete (absent["zh-CN"] as Partial<typeof absent["zh-CN"]>).sessions;
  assert.ok(validateCatalogs(absent).some(value => value.includes("缺少目录")));
});

test("完整性检查遵循中英文不同复数规则，并拒绝缺项、不支持项及复数参数差异", () => {
  const incomplete = copy();
  delete incomplete.en.common["common.itemCount_one"];
  assert.ok(validateCatalogs(incomplete).some(value => value.includes("缺少复数项 one")));
  const unsupported = copy();
  unsupported["zh-CN"].common["common.itemCount_one"] = "{{count}} 项";
  assert.ok(validateCatalogs(unsupported).some(value => value.includes("不支持复数项 one")));
  const different = copy();
  different.en.common["common.itemCount_one"] = "{{name}} item";
  assert.ok(validateCatalogs(different).some(value => value.includes("复数项参数")));
});
