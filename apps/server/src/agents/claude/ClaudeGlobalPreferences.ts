import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "@cloudx/shared";
import { JsonStateFile } from "../../jsonStateFile.js";

const KEYS = ["copyOnSelect", "copyFullResponse", "externalEditorContext"] as const;
type Preferences = Partial<Record<typeof KEYS[number], boolean>>;
interface PreferenceState {
  version: 1;
  values: Preferences;
  personal?: Preferences;
  overlays: Record<string, Preferences>;
}

// Native /config writes the tab's isolated .claude.json. Only these personal
// preferences cross tabs; account, trust and session state never enter this file.
export class ClaudeGlobalPreferences {
  private static queues = new Map<string, Promise<unknown>>();
  private readonly file: JsonStateFile;

  constructor(private readonly dataDir: string) {
    this.file = new JsonStateFile(dataDir, "claude-global-preferences.json", "Claude global preferences", 0o600);
  }

  seed(configDir: string, personalPath: string | undefined, initialize: (state: Record<string, unknown>) => void): Promise<void> {
    const key = this.file.filePath;
    const pending = ClaudeGlobalPreferences.queues.get(key) ?? Promise.resolve();
    const run = pending.then(() => this.seedAfterPending(configDir, personalPath, initialize));
    ClaudeGlobalPreferences.queues.set(key, run);
    void run.finally(() => {
      if (ClaudeGlobalPreferences.queues.get(key) === run) ClaudeGlobalPreferences.queues.delete(key);
    }).catch(() => undefined);
    return run;
  }

  private async seedAfterPending(configDir: string, personalPath: string | undefined, initialize: (state: Record<string, unknown>) => void): Promise<void> {
    const saved = await this.file.read<unknown>();
    if (saved !== undefined && (!isRecord(saved) || saved.version !== 1 || !isPreferences(saved.values) || !isRecord(saved.overlays) ||
      Object.keys(saved).some(key => !["version", "values", "personal", "overlays"].includes(key)) ||
      !Object.entries(saved.overlays).every(([name, preferences]) => safeOverlayName(name) && isPreferences(preferences)) ||
      saved.personal !== undefined && !isPreferences(saved.personal))) throw new Error("Invalid CloudX Claude global preferences file.");
    const shared = (saved as PreferenceState | undefined) ?? { version: 1, values: {}, overlays: {} };
    const updates: Array<{ at: number; values: Preferences; previous: Preferences }> = [];
    if (personalPath) {
      const personal = await readState(personalPath);
      const values = preferences(personal.value);
      if (shared.personal === undefined) {
        shared.values = { ...values, ...shared.values };
      } else updates.push({ at: personal.at, values, previous: shared.personal });
      shared.personal = values;
    }
    for (const [name, previous] of Object.entries(shared.overlays)) {
      const source = await readState(path.join(this.dataDir, "claude-launches", name, ".claude.json"));
      if (!source.value) continue;
      const values = preferences(source.value);
      updates.push({ at: source.at, values, previous });
      shared.overlays[name] = values;
    }
    // If several clients changed a preference before the next launch, the
    // newest native configuration file wins for future tabs. Open tabs retain
    // their own values. Unrelated native writes cannot reapply an old choice.
    for (const update of updates.sort((a, b) => a.at - b.at)) {
      for (const key of KEYS) if (update.values[key] !== update.previous[key]) {
        if (update.values[key] === undefined) delete shared.values[key];
        else shared.values[key] = update.values[key];
      }
    }
    const target = path.join(configDir, ".claude.json");
    const current = await readState(target);
    const state = { ...shared.values, ...current.value };
    initialize(state);
    await new JsonStateFile(configDir, ".claude.json", "Claude tab state", 0o600).write(state);
    shared.overlays[path.basename(configDir)] = preferences(state);
    await this.file.write(shared);
  }
}

function preferences(state: Record<string, unknown> | undefined): Preferences {
  return Object.fromEntries(KEYS.flatMap(key => typeof state?.[key] === "boolean" ? [[key, state[key]]] : []));
}

function isPreferences(value: unknown): value is Preferences {
  return isRecord(value) && Object.entries(value).every(([key, choice]) => (KEYS as readonly string[]).includes(key) && typeof choice === "boolean");
}

function safeOverlayName(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.:-]+$/u.test(value);
}

async function readState(file: string): Promise<{ value?: Record<string, unknown>; at: number }> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid state file");
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isRecord(value)) throw new Error("Invalid state object");
    return { value, at: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { at: 0 };
    throw new Error(`Cannot read Claude global preferences from ${file}: the file must be a readable JSON object.`);
  }
}
