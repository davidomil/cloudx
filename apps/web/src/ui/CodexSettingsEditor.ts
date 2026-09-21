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
export const personalities = ["none", "friendly", "pragmatic"] as const;
type NativeSetting = "reasoningEffort" | "webSearch" | "personality";

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
  busy: "loading" | "saving" | null;
  error?: string;
  saved: boolean;
}

const initialState: EditorState = {
  model: "", serviceTier: "", modeSelected: false, yoloMode: true, autoTrustWorkspace: false,
  defaultSkills: [], reasoningEffort: "", webSearch: "", personality: "", busy: "loading", saved: false
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

  get validModel() {
    return !this.state.model || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(this.state.model);
  }

  private get modelChanged() {
    return Boolean(this.state.settings && this.state.model !== (this.state.settings.model ?? ""));
  }

  private get modeChanged() {
    const { settings, serviceTier, modeSelected } = this.state;
    return Boolean(settings && (serviceTier !== (settings.serviceTier ?? "") || (modeSelected && this.selectedTier && settings.fastModeEnabled === false)));
  }

  get canSave() {
    return !this.state.busy && this.validModel && Object.keys(this.changedSettings()).length > 0;
  }

  setModel(model: string): void {
    if (!this.state.busy) this.update({ model, saved: false });
  }

  selectMode(serviceTier: string): void {
    if (!this.state.busy) this.update({ serviceTier, modeSelected: true, saved: false });
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
    if (!this.state.busy) this.update({ [field]: value, saved: false });
  }

  async reload(): Promise<void> {
    if (!this.state.busy) await this.read();
  }

  async save(): Promise<void> {
    const { settings } = this.state;
    if (!settings || !this.canSave || !this.callHook) return;
    const update: CodexGlobalSettingsUpdate = { expectedRevision: settings.revision, ...this.changedSettings() };
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
      const result = await this.callHook<{ settings: CodexGlobalSettings }>("codex-settings.read", {});
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
      reasoningEffort: settings.reasoningEffort ?? "", webSearch: settings.webSearch ?? "", personality: settings.personality ?? "", saved
    });
  }

  private changedSettings(): Omit<CodexGlobalSettingsUpdate, "expectedRevision"> {
    const { settings, model, yoloMode, autoTrustWorkspace, defaultSkills, reasoningEffort, webSearch, personality } = this.state;
    if (!settings) return {};
    const update: Omit<CodexGlobalSettingsUpdate, "expectedRevision"> = {};
    if (this.modelChanged) update.model = model || null;
    if (this.modeChanged) update.serviceTier = this.selectedTier ?? null;
    if (yoloMode !== settings.yoloMode) update.yoloMode = yoloMode;
    if (autoTrustWorkspace !== settings.autoTrustWorkspace) update.autoTrustWorkspace = autoTrustWorkspace;
    if (reasoningEffort !== (settings.reasoningEffort ?? "")) update.reasoningEffort = reasoningEfforts.find(value => value === reasoningEffort) ?? null;
    if (webSearch !== (settings.webSearch ?? "")) update.webSearch = webSearchModes.find(value => value === webSearch) ?? null;
    if (personality !== (settings.personality ?? "")) update.personality = personalities.find(value => value === personality) ?? null;
    const skillChanges = Object.fromEntries(defaultSkills
      .filter(skill => settings.defaultSkills.find(saved => saved.id === skill.id)?.enabled !== skill.enabled)
      .map(skill => [skill.id, skill.enabled]));
    if (Object.keys(skillChanges).length) update.defaultSkills = skillChanges;
    return update;
  }

  private update(change: Partial<EditorState>): void {
    this.state = { ...this.state, ...change };
    this.listeners.forEach(listener => listener());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
