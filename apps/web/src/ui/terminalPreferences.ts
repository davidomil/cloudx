export interface TerminalPreferences {
  macOptionIsMeta?: boolean;
  fontFamily?: string;
  scrollback?: number;
  links?: "confirm" | "disabled";
  attachments?: "review" | "disabled";
  shiftEnter?: "modified-enter" | "ctrl-j";
}

export const TERMINAL_PREFERENCES_KEY = "cloudx.terminal-preferences.v1";
const changed = "cloudx-terminal-preferences-changed";
export const TERMINAL_DEFAULTS = {
  macOptionIsMeta: false,
  fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
  scrollback: 1000,
  links: "confirm",
  attachments: "review",
  shiftEnter: "modified-enter"
} as const;

export function terminalPreferenceState(): { preferences: TerminalPreferences; error?: string } {
  try {
    const text = window.localStorage.getItem(TERMINAL_PREFERENCES_KEY);
    return { preferences: text ? validateTerminalPreferences(JSON.parse(text)) : {} };
  } catch (error) {
    return { preferences: {}, error: `Saved terminal preferences could not be used: ${error instanceof Error ? error.message : String(error)}. CloudX is using bounded host defaults. Reset the saved preferences or allow browser storage.` };
  }
}

export function readTerminalPreferences(): TerminalPreferences {
  return terminalPreferenceState().preferences;
}

export function validateTerminalPreferences(value: unknown): TerminalPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Terminal preferences must be an object.");
  const p = value as Record<string, unknown>;
  const result: TerminalPreferences = {};
  if (p.macOptionIsMeta !== undefined) {
    if (typeof p.macOptionIsMeta !== "boolean") throw new Error("Option as Meta must be true or false.");
    result.macOptionIsMeta = p.macOptionIsMeta;
  }
  if (p.fontFamily !== undefined) {
    if (typeof p.fontFamily !== "string" || !p.fontFamily.trim() || p.fontFamily.length > 300 || /[\u0000-\u001f]/u.test(p.fontFamily)) throw new Error("Choose a font family of 1–300 characters.");
    result.fontFamily = p.fontFamily.trim();
  }
  if (p.scrollback !== undefined) {
    if (!Number.isInteger(p.scrollback) || Number(p.scrollback) < 0 || Number(p.scrollback) > 100_000) throw new Error("Scrollback must be 0–100000 lines.");
    result.scrollback = Number(p.scrollback);
  }
  for (const [key, choices] of Object.entries({ links: ["confirm", "disabled"], attachments: ["review", "disabled"], shiftEnter: ["modified-enter", "ctrl-j"] })) {
    if (p[key] !== undefined) {
      if (!choices.includes(p[key] as string)) throw new Error(`Unsupported terminal ${key} preference.`);
      Object.assign(result, { [key]: p[key] });
    }
  }
  return result;
}

export function saveTerminalPreferences(preferences: TerminalPreferences): void {
  window.localStorage.setItem(TERMINAL_PREFERENCES_KEY, JSON.stringify(validateTerminalPreferences(preferences)));
  window.dispatchEvent(new Event(changed));
}

export function onTerminalPreferencesChanged(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === TERMINAL_PREFERENCES_KEY || event.key === null) listener(); };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener("storage", storage); };
}
