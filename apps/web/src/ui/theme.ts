import { DEFAULT_CLOUDX_THEME_ID, isCloudxThemeId, type CloudxThemeId, type ConfigValue } from "@cloudx/shared";

type ThemeTokenMap = Record<string, string>;

interface CloudxTheme {
  id: CloudxThemeId;
  tokens: ThemeTokenMap;
}

const CLOUDX_THEME: CloudxTheme = {
  id: "cloudx-neon",
  tokens: {
    "color-background": "#0a0a0f",
    "color-foreground": "#e0e0e0",
    "color-card": "#12121a",
    "color-muted": "#1c1c2e",
    "color-muted-foreground": "#6b7280",
    "color-accent": "#00ff88",
    "color-accent-secondary": "#ff00ff",
    "color-accent-tertiary": "#00d4ff",
    "color-border": "#2a2a3a",
    "color-input": "#12121a",
    "color-ring": "#00ff88",
    "color-destructive": "#ff3366",
    "color-warning": "#ffd166",
    "font-heading": "\"Orbitron\", \"Share Tech Mono\", monospace",
    "font-body": "\"JetBrains Mono\", \"Fira Code\", Consolas, monospace",
    "font-label": "\"Share Tech Mono\", \"JetBrains Mono\", monospace",
    "terminal-selection-background": "#173d33",
    "shadow-neon": "0 0 5px #00ff88, 0 0 10px #00ff8840",
    "shadow-neon-sm": "0 0 3px #00ff88, 0 0 6px #00ff8830",
    "shadow-neon-lg": "0 0 10px #00ff88, 0 0 20px #00ff8860, 0 0 40px #00ff8830",
    "shadow-neon-secondary": "0 0 5px #ff00ff, 0 0 20px #ff00ff60",
    "shadow-neon-tertiary": "0 0 5px #00d4ff, 0 0 20px #00d4ff60",
    "shadow-danger": "0 0 5px #ff3366, 0 0 18px #ff336650",
    "control-foreground": "var(--color-accent-tertiary)",
    "control-background": "transparent",
    "control-border": "var(--color-border)",
    "control-hover-foreground": "var(--color-background)",
    "control-hover-background": "var(--color-accent-tertiary)",
    "control-hover-border": "var(--color-accent-tertiary)",
    "control-hover-shadow": "var(--shadow-neon-tertiary)",
    "control-selected-foreground": "var(--color-background)",
    "control-selected-background": "var(--color-accent)",
    "control-selected-border": "var(--color-accent)",
    "control-selected-shadow": "var(--shadow-neon-sm)",
    "control-danger-foreground": "var(--color-destructive)",
    "control-danger-border": "rgb(255 51 102 / 0.45)",
    "ambient-primary": "rgb(0 212 255 / 0.08)",
    "ambient-secondary": "rgb(255 0 255 / 0.07)",
    "ambient-tertiary": "rgb(0 255 136 / 0.06)",
    "ambient-surface-primary": "rgb(255 0 255 / 0.035)",
    "ambient-surface-secondary": "rgb(0 255 136 / 0.035)",
    "ambient-surface-line-primary": "rgb(0 212 255 / 0.035)",
    "ambient-surface-line-secondary": "rgb(255 0 255 / 0.03)",
    "grid-line-primary": "rgb(0 255 136 / 0.02)",
    "grid-line-secondary": "rgb(0 255 136 / 0.018)",
    "scanline": "rgb(0 255 136 / 0.035)",
    "top-highlight": "rgb(255 255 255 / 0.025)",
    "chamfer-xs": "polygon(0 4px, 4px 0, calc(100% - 4px) 0, 100% 4px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0 calc(100% - 4px))",
    "chamfer-sm": "polygon(0 7px, 7px 0, calc(100% - 7px) 0, 100% 7px, 100% calc(100% - 7px), calc(100% - 7px) 100%, 7px 100%, 0 calc(100% - 7px))",
    "chamfer": "polygon(0 11px, 11px 0, calc(100% - 11px) 0, 100% 11px, 100% calc(100% - 11px), calc(100% - 11px) 100%, 11px 100%, 0 calc(100% - 11px))",
    "transition-digital": "120ms steps(4)"
  }
};

const MINIMALIST_DARK_THEME: CloudxTheme = {
  id: "minimalist-dark",
  tokens: {
    "color-background": "#0A0A0F",
    "color-foreground": "#FAFAFA",
    "color-card": "rgba(26, 26, 36, 0.6)",
    "color-muted": "#1A1A24",
    "color-muted-foreground": "#71717A",
    "color-accent": "#F59E0B",
    "color-accent-secondary": "rgba(245, 158, 11, 0.15)",
    "color-accent-tertiary": "#FBBF24",
    "color-border": "rgba(255, 255, 255, 0.08)",
    "color-input": "rgba(26, 26, 36, 0.6)",
    "color-ring": "#F59E0B",
    "color-destructive": "#fb7185",
    "color-warning": "#F59E0B",
    "font-heading": "\"Space Grotesk\", system-ui, sans-serif",
    "font-body": "\"Inter\", system-ui, sans-serif",
    "font-label": "\"JetBrains Mono\", monospace",
    "terminal-selection-background": "rgba(245, 158, 11, 0.22)",
    "shadow-neon": "0 0 20px rgba(245, 158, 11, 0.15)",
    "shadow-neon-sm": "0 0 20px rgba(245, 158, 11, 0.15)",
    "shadow-neon-lg": "0 0 60px rgba(245, 158, 11, 0.25)",
    "shadow-neon-secondary": "0 0 40px rgba(245, 158, 11, 0.2)",
    "shadow-neon-tertiary": "0 0 40px rgba(245, 158, 11, 0.2)",
    "shadow-danger": "0 0 20px rgba(251, 113, 133, 0.35)",
    "control-foreground": "#FAFAFA",
    "control-background": "transparent",
    "control-border": "rgba(255, 255, 255, 0.15)",
    "control-hover-foreground": "#FAFAFA",
    "control-hover-background": "rgba(255, 255, 255, 0.05)",
    "control-hover-border": "rgba(255, 255, 255, 0.25)",
    "control-hover-shadow": "0 0 20px rgba(245, 158, 11, 0.4)",
    "control-selected-foreground": "#0A0A0F",
    "control-selected-background": "#F59E0B",
    "control-selected-border": "#F59E0B",
    "control-selected-shadow": "0 0 20px rgba(245, 158, 11, 0.4)",
    "control-danger-foreground": "#fb7185",
    "control-danger-border": "rgba(251, 113, 133, 0.45)",
    "ambient-primary": "rgba(245, 158, 11, 0.035)",
    "ambient-secondary": "rgba(255, 255, 255, 0.018)",
    "ambient-tertiary": "rgba(245, 158, 11, 0.025)",
    "ambient-surface-primary": "rgba(245, 158, 11, 0.035)",
    "ambient-surface-secondary": "rgba(255, 255, 255, 0.018)",
    "ambient-surface-line-primary": "rgba(245, 158, 11, 0.025)",
    "ambient-surface-line-secondary": "rgba(255, 255, 255, 0.018)",
    "grid-line-primary": "rgba(255, 255, 255, 0.018)",
    "grid-line-secondary": "rgba(255, 255, 255, 0.014)",
    "scanline": "rgba(255, 255, 255, 0.018)",
    "top-highlight": "rgba(245, 158, 11, 0.03)",
    "chamfer-xs": "inset(0 round 6px)",
    "chamfer-sm": "inset(0 round 8px)",
    "chamfer": "inset(0 round 12px)",
    "transition-digital": "200ms ease-out"
  }
};

export const CLOUDX_THEMES: CloudxTheme[] = [CLOUDX_THEME, MINIMALIST_DARK_THEME];

export function resolveThemeId(value: ConfigValue | undefined): CloudxThemeId {
  return isCloudxThemeId(value) ? value : DEFAULT_CLOUDX_THEME_ID;
}

export function applyCloudxTheme(themeId: ConfigValue | undefined, root: HTMLElement = document.documentElement): CloudxThemeId {
  const resolvedThemeId = resolveThemeId(themeId);
  const theme = CLOUDX_THEMES.find((candidate) => candidate.id === resolvedThemeId) ?? CLOUDX_THEME;
  root.dataset.theme = theme.id;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${name}`, value);
  }
  return theme.id;
}

export interface TerminalColorTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

export function readTerminalColorTheme(root: HTMLElement = document.documentElement): TerminalColorTheme {
  const styles = getComputedStyle(root);
  return {
    background: tokenValue(styles, "color-background", "#0a0a0f"),
    foreground: tokenValue(styles, "color-foreground", "#e0e0e0"),
    cursor: tokenValue(styles, "color-accent", "#00ff88"),
    selectionBackground: tokenValue(styles, "terminal-selection-background", "#173d33")
  };
}

function tokenValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(`--${name}`).trim() || fallback;
}
