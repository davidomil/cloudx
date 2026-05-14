import type { ConfigValue } from "@cloudx/shared";

export const DEFAULT_UI_SCALE = 100;
export const MIN_UI_SCALE = 75;
export const MAX_UI_SCALE = 150;

export function normalizeUiScale(value: ConfigValue | undefined): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_UI_SCALE;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, numeric));
}

export function uiScaleFactor(scale: number): string {
  return trimScaleFactor(normalizeUiScale(scale) / 100);
}

export function scaledTerminalFontSize(baseFontSize: number, scale: number): number {
  return Math.round(baseFontSize * normalizeUiScale(scale) / 100);
}

function trimScaleFactor(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
