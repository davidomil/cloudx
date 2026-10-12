import type { CodexGlobalSettings, CodexGlobalSettingsUpdate } from "@cloudx/shared";

import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;
type ServiceTier = NonNullable<CodexGlobalSettingsUpdate["serviceTier"]>;
export const serviceTiers: { value: ServiceTier; label: string }[] = [
  { value: "priority", label: "On" },
  { value: "default", label: "Off" },
  { value: "flex", label: "Flex" }
];
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const webSearchModes = ["disabled", "cached", "live", "indexed"] as const;
export const personalities = ["none"] as const;
type NativeSetting = "reasoningEffort" | "webSearch" | "personality";
const quickSettings = {
  model: "model", serviceTier: "service_tier", reasoningEffort: "model_reasoning_effort", webSearch: "web_search", personality: "personality"
} as const;
type QuickSetting = keyof typeof quickSettings;

interface EditorState {
  settings?: CodexGlobalSettings;
  model: string;
  serviceTier: string;
  modeSelected: boolean;
  yoloMode: boolean;
  autoTrustWorkspace: boolean;
  defaultSkills: CodexGlobalSettings["defaultSkills"];
  reasoningEffort: string;
  webSearch: string;
  personality: string;
  nativeDrafts: Record<string, string>;
  targetProfile?: string;
  configProfile: string;
  busy: "loading" | "saving" | null;
  error?: string;
  saved: boolean;
}

const initialState: EditorState = {
  model: "", serviceTier: "", modeSelected: false, yoloMode: true, autoTrustWorkspace: false,
  defaultSkills: [], reasoningEffort: "", webSearch: "", personality: "", nativeDrafts: {}, configProfile: "", busy: "loading", saved: false
};

export class CodexSettingsEditor {
  private state = initialState;
  private listeners = new Set<() => void>();
  private callHook?: CallHook;
  private started = false;
  private requestVersion = 0;

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  load(callHook: CallHook): void {
    this.callHook = callHook;
    if (this.started) return;
    this.started = true;
    void this.read();
  }

  get selectedTier() {
    return serviceTiers.find(tier => tier.value === this.state.serviceTier)?.value;
  }

  get canSave() {
    return !this.state.busy && !this.nativeError && Object.keys(this.changedSettings()).length > 0;
  }

  get nativeError(): string | undefined {
    for (const [family, value] of Object.entries(this.state.nativeDrafts)) {
      if (!value.trim()) continue;
      try {
        const parsed = JSON.parse(value);
        if (Object.values(quickSettings).some(key => key === family) && parsed !== null && typeof parsed !== "string")
          return `${family} must be a JSON string, or use Unset to inherit.`;
      } catch { return `Enter valid JSON for ${family}, or use Unset to inherit.`; }
    }
  }

  setNativeOption(family: string, value: string): void {
    if (this.state.busy) return;
    this.update({ nativeDrafts: { ...this.state.nativeDrafts, [family]: value }, ...(family === "service_tier" ? { modeSelected: true } : {}), saved: false });
  }

  selectLaunchProfile(configProfile: string): void {
    if (!this.state.busy) this.update({ configProfile, saved: false });
  }

  async selectTargetProfile(targetProfile?: string): Promise<void> {
    if (this.state.busy) return;
    this.update({ targetProfile });
    await this.read();
  }

  setModel(model: string): void {
    this.setNativeOption("model", model ? JSON.stringify(model) : "");
  }

  selectMode(serviceTier: string): void {
    this.setNativeOption("service_tier", serviceTier ? JSON.stringify(serviceTier) : "");
  }

  enableFastMode(): void {
    if (!this.state.busy && this.selectedTier) this.update({ modeSelected: true, saved: false });
  }

  setYoloMode(yoloMode: boolean): void {
    if (!this.state.busy) this.update({ yoloMode, saved: false });
  }

  setAutoTrustWorkspace(autoTrustWorkspace: boolean): void {
    if (!this.state.busy) this.update({ autoTrustWorkspace, saved: false });
  }

  setDefaultSkill(id: string, enabled: boolean): void {
    if (!this.state.busy) this.update({ defaultSkills: this.state.defaultSkills.map(skill => skill.id === id ? { ...skill, enabled } : skill), saved: false });
  }

  selectNativeSetting(field: NativeSetting, value: string): void {
    this.setNativeOption(quickSettings[field], value ? JSON.stringify(value) : "");
  }

  async reload(): Promise<void> {
    if (!this.state.busy) await this.read();
  }

  async save(): Promise<void> {
    const { settings } = this.state;
    if (!settings || !this.canSave || !this.callHook) return;
    const update: CodexGlobalSettingsUpdate = { expectedRevision: settings.revision, ...(this.state.targetProfile ? { targetProfile: this.state.targetProfile } : {}), ...this.changedSettings() };
    const version = ++this.requestVersion;
    this.update({ busy: "saving", error: undefined, saved: false });
    try {
      const result = await this.callHook<{ settings: CodexGlobalSettings }>("codex-settings.update", { ...update });
      if (version === this.requestVersion) this.acceptSettings(result.settings, true);
    } catch (error) {
      if (version === this.requestVersion) this.update({ error: errorMessage(error) });
    } finally {
      if (version === this.requestVersion) this.update({ busy: null });
    }
  }

  dispose(): void {
    this.requestVersion += 1;
    this.started = false;
    this.callHook = undefined;
    this.state = initialState;
  }

  private async read(): Promise<void> {
    if (!this.callHook) return;
    const version = ++this.requestVersion;
    this.update({ busy: "loading", error: undefined, saved: false });
    try {
      const result = await this.callHook<{ settings: CodexGlobalSettings }>("codex-settings.read", this.state.targetProfile ? { targetProfile: this.state.targetProfile } : {});
      if (version === this.requestVersion) this.acceptSettings(result.settings, false);
    } catch (error) {
      if (version === this.requestVersion) this.update({ error: errorMessage(error) });
    } finally {
      if (version === this.requestVersion) this.update({ busy: null });
    }
  }

  private acceptSettings(settings: CodexGlobalSettings, saved: boolean): void {
    this.update({
      settings, model: settings.model ?? "", serviceTier: settings.serviceTier ?? "", modeSelected: false,
      yoloMode: settings.yoloMode, autoTrustWorkspace: settings.autoTrustWorkspace, defaultSkills: settings.defaultSkills,
      reasoningEffort: settings.reasoningEffort ?? "", webSearch: settings.webSearch ?? "", personality: settings.personality ?? "", nativeDrafts: {}, configProfile: settings.configProfile ?? "", saved
    });
  }

  private changedSettings(): Omit<CodexGlobalSettingsUpdate, "expectedRevision"> {
    const { settings, yoloMode, autoTrustWorkspace, defaultSkills } = this.state;
    if (!settings) return {};
    const update: Omit<CodexGlobalSettingsUpdate, "expectedRevision"> = {};
    if (yoloMode !== settings.yoloMode) update.yoloMode = yoloMode;
    if (autoTrustWorkspace !== settings.autoTrustWorkspace) update.autoTrustWorkspace = autoTrustWorkspace;
    const skillChanges = Object.fromEntries(defaultSkills
      .filter(skill => settings.defaultSkills.find(saved => saved.id === skill.id)?.enabled !== skill.enabled)
      .map(skill => [skill.id, skill.enabled]));
    if (Object.keys(skillChanges).length) update.defaultSkills = skillChanges;
    if (!this.state.targetProfile && this.state.configProfile !== (settings.configProfile ?? "")) update.configProfile = this.state.configProfile || null;
    const nativeOptions: NonNullable<CodexGlobalSettingsUpdate["nativeOptions"]> = {};
    for (const [family, draft] of Object.entries(this.state.nativeDrafts)) {
      const value = draft.trim() ? JSON.parse(draft) : null;
      const field = (Object.keys(quickSettings) as QuickSetting[]).find(field => quickSettings[field] === family);
      const original = field ? settings[field] : settings.configuration?.values[family] ?? null;
      if (JSON.stringify(value) === JSON.stringify(original)) continue;
      if (field && supportedQuickValue(field, value)) Object.assign(update, { [field]: value });
      else nativeOptions[family] = value;
    }
    if (this.state.modeSelected && this.selectedTier && settings.fastModeEnabled === false) update.serviceTier = this.selectedTier;
    if (Object.keys(nativeOptions).length) update.nativeOptions = nativeOptions;
    return update;
  }

  private update(change: Partial<EditorState>): void {
    this.state = { ...this.state, ...change };
    for (const field of Object.keys(quickSettings) as QuickSetting[]) {
      const draft = this.state.nativeDrafts[quickSettings[field]];
      let value: unknown = this.state.settings?.[field];
      if (draft !== undefined) {
        try { value = draft.trim() ? JSON.parse(draft) : null; }
        catch { value = null; }
      }
      this.state[field] = typeof value === "string" ? value : "";
    }
    this.listeners.forEach(listener => listener());
  }
}

function supportedQuickValue(field: QuickSetting, value: unknown): boolean {
  if (value === null) return true;
  if (field === "model") return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
  const options = field === "serviceTier" ? serviceTiers.map(tier => tier.value)
    : field === "reasoningEffort" ? reasoningEfforts : field === "webSearch" ? webSearchModes : personalities;
  return typeof value === "string" && options.some(option => option === value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
