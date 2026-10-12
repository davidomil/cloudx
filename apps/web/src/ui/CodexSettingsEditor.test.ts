import { describe, expect, it } from "vitest";
import type { CodexGlobalSettings } from "@cloudx/shared";
import { CodexSettingsEditor } from "./CodexSettingsEditor.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

const aliases = [
  { field: "model", family: "model", initial: "gpt-6.1-sol", quick: "gpt-6-sol", native: "gpt-6-astra" },
  { field: "serviceTier", family: "service_tier", initial: "priority", quick: "default", native: "flex" },
  { field: "reasoningEffort", family: "model_reasoning_effort", initial: "low", quick: "high", native: "xhigh" },
  { field: "webSearch", family: "web_search", initial: "cached", quick: "live", native: "disabled" },
  { field: "personality", family: "personality", initial: "friendly", quick: "none", native: "none" }
] as const;

type Alias = typeof aliases[number];
function quickEdit(editor: CodexSettingsEditor, alias: Alias, value: string) {
  if (alias.field === "model") editor.setModel(value);
  else if (alias.field === "serviceTier") editor.selectMode(value);
  else editor.selectNativeSetting(alias.field, value);
}

async function editorFixture(fastModeEnabled = true, model = "gpt-6.1-sol") {
  const settings: CodexGlobalSettings = {
    revision: "a".repeat(64), model, serviceTier: "priority", fastModeEnabled,
    reasoningEffort: "low", webSearch: "cached", personality: "friendly", yoloMode: true, autoTrustWorkspace: false, defaultSkills: [],
    configuration: {
      selectedVersion: "0.162.1", baselineVersion: "0.162.1", selectedCommand: "/bin/codex", sourcePath: "/codex/config.toml", blockedReason: null,
      values: { ...Object.fromEntries(aliases.map(alias => [alias.family, alias.initial])), model }, effectiveValues: {}, overrides: [], layers: []
    }
  };
  const updates: Record<string, unknown>[] = [];
  let fail = false;
  const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hook: string, input: Record<string, unknown> = {}) => {
    if (hook === "codex-settings.update") {
      updates.push(input);
      if (fail) throw new Error("Reload before saving again.");
    }
    return { settings } as unknown as T;
  };
  const editor = new CodexSettingsEditor();
  editor.load(callHook);
  await Promise.resolve();
  return { editor, updates, rejectSave: () => { fail = true; } };
}

describe("one draft per native Codex option", () => {
  for (const alias of aliases) {
    it.each(["quick then native", "native then quick"] as const)(`${alias.family} saves the latest value after %s edits`, async order => {
      const { editor, updates } = await editorFixture();
      if (order === "quick then native") {
        quickEdit(editor, alias, alias.quick);
        editor.setNativeOption(alias.family, JSON.stringify(alias.native));
      } else {
        editor.setNativeOption(alias.family, JSON.stringify(alias.native));
        quickEdit(editor, alias, alias.quick);
      }
      const latest = order === "quick then native" ? alias.native : alias.quick;
      expect(editor.getSnapshot()[alias.field]).toBe(latest);
      expect(JSON.parse(editor.getSnapshot().nativeDrafts[alias.family])).toBe(latest);
      await editor.save();
      expect(updates).toEqual([{ expectedRevision: "a".repeat(64), [alias.field]: latest }]);
    });
    it.each(["native unset", "quick unset"] as const)(`${alias.family} inherits after %s replaces the other control`, async order => {
      const { editor, updates } = await editorFixture();
      if (order === "native unset") {
        quickEdit(editor, alias, alias.quick);
        editor.setNativeOption(alias.family, "");
      } else {
        editor.setNativeOption(alias.family, JSON.stringify(alias.native));
        quickEdit(editor, alias, "");
      }
      expect(editor.getSnapshot()[alias.field]).toBe("");
      expect(editor.getSnapshot().nativeDrafts[alias.family]).toBe("");
      await editor.save();
      expect(updates).toEqual([{ expectedRevision: "a".repeat(64), [alias.field]: null }]);
    });
  }

  it("keeps the shared draft after a rejected save and a quick edit replaces invalid structured JSON", async () => {
    const { editor, rejectSave } = await editorFixture();
    editor.setNativeOption("model", '"gpt-6-astra"');
    rejectSave();
    await editor.save();
    expect(editor.getSnapshot()).toMatchObject({ model: "gpt-6-astra", nativeDrafts: { model: '"gpt-6-astra"' }, error: "Reload before saving again." });
    editor.setNativeOption("model", "{");
    expect(editor.canSave).toBe(false);
    editor.setModel("gpt-6-sol");
    expect(editor.nativeError).toBeUndefined();
    expect(editor.getSnapshot().nativeDrafts.model).toBe('"gpt-6-sol"');
  });

  it("leaves enum validation to the native boundary without silently resetting an unknown structured value", async () => {
    const { editor, updates } = await editorFixture();
    editor.setNativeOption("model_reasoning_effort", '"future-effort"');
    await editor.save();
    expect(updates).toEqual([{ expectedRevision: "a".repeat(64), nativeOptions: { model_reasoning_effort: "future-effort" } }]);
  });

  it("enables disabled fast mode support when the same native tier is explicitly selected", async () => {
    const { editor, updates } = await editorFixture(false);
    expect(editor.canSave).toBe(false);
    editor.setNativeOption("service_tier", '"priority"');
    expect(editor.canSave).toBe(true);
    await editor.save();
    expect(updates).toEqual([{ expectedRevision: "a".repeat(64), serviceTier: "priority" }]);
  });

  it.each(["local/model@preview", "x".repeat(129)])("routes the native model string %s without narrowing it to the quick identifier contract", async model => {
    const { editor, updates } = await editorFixture();
    editor.setModel("gpt-6-sol");
    editor.setNativeOption("model", JSON.stringify(model));
    expect(editor.getSnapshot().model).toBe(model);
    expect(editor.canSave).toBe(true);
    await editor.save();
    expect(updates).toEqual([{ expectedRevision: "a".repeat(64), nativeOptions: { model } }]);
  });

  it("preserves a saved provider-native model when only a launch preference changes", async () => {
    const { editor, updates } = await editorFixture(true, "local/model@preview");
    editor.setYoloMode(false);
    expect(editor.getSnapshot().model).toBe("local/model@preview");
    await editor.save();
    expect(updates).toEqual([{ expectedRevision: "a".repeat(64), yoloMode: false }]);
  });

  it.each(aliases)("keeps a non-string $family draft local rather than converting it into unset", async alias => {
    const { editor, updates } = await editorFixture();
    editor.setNativeOption(alias.family, '{"invalid":"type"}');
    expect(editor.nativeError).toContain("must be a JSON string");
    expect(editor.canSave).toBe(false);
    await editor.save();
    expect(updates).toEqual([]);
    quickEdit(editor, alias, alias.quick);
    expect(editor.canSave).toBe(true);
  });
});
