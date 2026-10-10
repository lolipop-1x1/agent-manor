import { useEffect, useId, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Palette } from "@phosphor-icons/react";
import { themePresets, type ThemeMode, type ThemePreset } from "../../../src/appearance";
import { useI18n } from "../i18n";
import { FilterSelect } from "./FilterSelect";
import "./appearance.css";
export function AppearanceMenu() {
  const { appearance, setAppearance, saving, t } = useI18n();
  const [color, setColor] = useState(appearance.customColor);
  const colorId = useId();
  useEffect(() => { setColor(appearance.customColor); }, [appearance.customColor]);
  return <Popover.Root><Popover.Trigger className="icon-button" aria-label={t("common.appearance.menu")} title={t("common.appearance.menu")}><Palette size={19} /></Popover.Trigger>
    <Popover.Portal><Popover.Content className="appearance-menu" align="end" sideOffset={8} collisionPadding={12} aria-label={t("common.appearance.menu")}>
      <strong>{t("common.appearance.menu")}</strong>
      <label>{t("common.appearance.mode")}</label>
      <FilterSelect label={t("common.appearance.mode")} value={appearance.mode} disabled={saving} options={["auto", "light", "dark"].map(value => ({ value, label: t(`common.appearance.${value}`) }))} onChange={mode => void setAppearance({ mode: mode as ThemeMode })} />
      <label>{t("common.appearance.color")}</label>
      <div className="appearance-presets" role="group" aria-label={t("common.appearance.color")}>
        {Object.entries(themePresets).map(([preset, seed]) => <button type="button" key={preset} className="appearance-preset" disabled={saving} aria-pressed={appearance.preset === preset} onClick={() => void setAppearance({ preset: preset as ThemePreset })}><span style={{ background: seed }} aria-hidden="true" />{t(`common.appearance.${preset}`)}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); void setAppearance({ preset: "custom", customColor: color.toLowerCase() }); }}>
        <label htmlFor={colorId}>{t("common.appearance.custom")}</label>
        <div className="appearance-custom"><input id={colorId} type="color" value={color} disabled={saving} onChange={event => setColor(event.target.value)} /><button type="submit" disabled={saving} aria-pressed={appearance.preset === "custom"}>{t("common.appearance.apply")}</button></div>
      </form>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
