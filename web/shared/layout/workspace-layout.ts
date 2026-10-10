import { t } from "../i18n";

export type PanelSide = "sidebar" | "details";
export type PanelWidths = Record<PanelSide, number>;
export type CollapsedPanels = Record<PanelSide, boolean>;
export type PanelSemantics = Partial<Record<PanelSide, { label: string; controls: string }>>;

const defaultPanelSemantics: Record<PanelSide, { label: string; controls: string }> = {
  sidebar: { get label() { return t("common.workspace.sidebarWidth"); }, controls: "repository-navigation-content" },
  details: { get label() { return t("common.workspace.detailsWidth"); }, controls: "file-details-content" },
};

export function panelSemantics(side: PanelSide, overrides: PanelSemantics = {}) {
  return overrides[side] ?? defaultPanelSemantics[side];
}

const limits = { sidebar: { min: 160, max: 480 }, details: { min: 260, max: 640 } };
const mapMinimum = 360;
const railWidth = 44;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function workspaceWidths(viewport: number, preferred: Partial<PanelWidths>, collapsed: CollapsedPanels): PanelWidths {
  const widths = {
    sidebar: collapsed.sidebar ? railWidth : clamp(preferred.sidebar ?? (viewport > 1250 ? 200 : viewport >= 1024 ? 175 : 170), limits.sidebar.min, limits.sidebar.max),
    details: collapsed.details ? railWidth : clamp(preferred.details ?? (viewport > 1250 ? 320 : 285), limits.details.min, limits.details.max),
  };
  if (viewport < 768) return widths;
  const budget = viewport - mapMinimum - (viewport < 1024 && collapsed.details ? railWidth : 0);
  if (viewport < 1024) {
    if (!collapsed.sidebar) widths.sidebar = Math.min(widths.sidebar, budget);
    return widths;
  }
  const excess = widths.sidebar + widths.details - budget;
  if (excess > 0) {
    // 窗口变窄时按可压缩空间分摊，保留面板下限和地图宽度；不丢失用户偏好。
    const leftRoom = collapsed.sidebar ? 0 : widths.sidebar - limits.sidebar.min;
    const rightRoom = collapsed.details ? 0 : widths.details - limits.details.min;
    const room = leftRoom + rightRoom;
    if (room > 0) {
      widths.sidebar -= excess * leftRoom / room;
      widths.details -= excess * rightRoom / room;
    }
  }
  return widths;
}

export function panelWidthRange(side: PanelSide, viewport: number, widths: PanelWidths) {
  const opposite = side === "sidebar" ? widths.details : widths.sidebar;
  const available = viewport - mapMinimum - (viewport >= 1024 || side === "details" || opposite === railWidth ? opposite : 0);
  return { min: limits[side].min, max: Math.max(limits[side].min, Math.min(limits[side].max, available)) };
}
