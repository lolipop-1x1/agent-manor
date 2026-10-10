import assert from "node:assert/strict";
import test from "node:test";
import { appearanceVariables, contrastRatio, defaultAppearance, isAppearance, isAppearancePatch, themePresets } from "../src/appearance.js";

test("外观严格校验，预设与自定义色完整记录", () => {
  assert.equal(isAppearance(defaultAppearance), true);
  assert.equal(isAppearancePatch({ mode: "dark" }), true);
  for (const value of [null, [], {}, { mode: "system" }, { preset: "toString" }, { preset: { toString: {} } }, { preset: [] }, { customColor: "#fff" }, { customColor: "red" }, { customColor: "#112233;" }, { extra: true }]) assert.equal(isAppearancePatch(value), false);
});

test("所有预设与极端自定义色在明暗模式有可读按钮和地图文字，语义色保持独立", () => {
  const colors = [...Object.values(themePresets), "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#777777"];
  for (const color of colors) for (const theme of ["light", "dark"] as const) {
    const variables = appearanceVariables({ ...defaultAppearance, preset: "custom", customColor: color }, theme);
    assert.ok(contrastRatio(variables["--accent"]!, variables["--accent-soft"]!) >= 4.5);
    assert.ok(contrastRatio(variables["--accent"]!, theme === "dark" ? "#1d2635" : "#f3f6fb") >= 4.5);
    for (const background of ["--accent", "--accent-hover"]) assert.ok(contrastRatio(variables[background]!, variables["--on-accent"]!) >= 4.5, `${theme} ${color} ${background}`);
    for (let index = 0; index <= 4; index++) assert.ok(contrastRatio(variables[`--map-${index}`]!, variables[`--map-${index}-text`]!) >= 4.5, `${theme} ${color} map-${index}`);
    for (const index of [4]) assert.ok(contrastRatio(variables[`--map-${index}`]!, variables["--map-strong-text"]!) >= 4.5);
    for (const semantic of ["--danger", "--near", "--code-near", "--unknown"]) assert.equal(variables[semantic], undefined);
  }
});
