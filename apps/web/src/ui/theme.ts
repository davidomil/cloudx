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
    "terminal-selection-background": "#173d33",
    "shadow-neon": "0 0 5px #00ff88, 0 0 10px #00ff8840",
    "shadow-neon-sm": "0 0 3px #00ff88, 0 0 6px #00ff8830",
    "shadow-neon-lg": "0 0 10px #00ff88, 0 0 20px #00ff8860, 0 0 40px #00ff8830",
    "shadow-neon-secondary": "0 0 5px #ff00ff, 0 0 20px #ff00ff60",
    "shadow-neon-tertiary": "0 0 5px #00d4ff, 0 0 20px #00d4ff60",
    "shadow-danger": "0 0 5px #ff3366, 0 0 18px #ff336650"
  }
};

const GRAPHITE_THEME: CloudxTheme = {
  id: "graphite",
  tokens: {
    "color-background": "#0c0f12",
    "color-foreground": "#e8ecef",
    "color-card": "#151a1f",
    "color-muted": "#202830",
    "color-muted-foreground": "#8b97a3",
    "color-accent": "#7dd3fc",
    "color-accent-secondary": "#f0abfc",
    "color-accent-tertiary": "#86efac",
    "color-border": "#33404c",
    "color-input": "#11171d",
    "color-ring": "#7dd3fc",
    "color-destructive": "#fb7185",
    "color-warning": "#facc15",
    "terminal-selection-background": "#1e3a4a",
    "shadow-neon": "0 0 5px #7dd3fc, 0 0 10px rgb(125 211 252 / 0.25)",
    "shadow-neon-sm": "0 0 3px #7dd3fc, 0 0 6px rgb(125 211 252 / 0.2)",
    "shadow-neon-lg": "0 0 10px #7dd3fc, 0 0 20px rgb(125 211 252 / 0.34), 0 0 40px rgb(125 211 252 / 0.18)",
    "shadow-neon-secondary": "0 0 5px #f0abfc, 0 0 20px rgb(240 171 252 / 0.35)",
    "shadow-neon-tertiary": "0 0 5px #86efac, 0 0 20px rgb(134 239 172 / 0.32)",
    "shadow-danger": "0 0 5px #fb7185, 0 0 18px rgb(251 113 133 / 0.35)"
  }
};

export const CLOUDX_THEMES: CloudxTheme[] = [CLOUDX_THEME, GRAPHITE_THEME];

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
