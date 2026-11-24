import { describe, expect, it } from "vitest";

import { AGENT_EXEC_MODEL_OPTIONS, CLAUDE_EXEC_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, DOCUMENTATION_AI_USE_VOICE_MODEL } from "./aiModelOptions.js";
import { GLOBAL_CONFIG_FIELDS } from "./configService.js";
import { DocumentationClient } from "./documentation/DocumentationClient.js";
import { DocumentationIngestQueue } from "./documentation/DocumentationIngestQueue.js";
import { forgeConfigFields } from "./forge/ForgeSettingsService.js";
import { PathPolicy } from "./pathPolicy.js";
import { DocumentationPlugin } from "./plugins/DocumentationPlugin.js";

describe("Settings model choices", () => {
  it("offers only the currently supported Codex models", () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5"
    ]);
  });

  it("declares reviewed native requirements without replacing explicit defaults", () => {
    for (const value of ["gpt-6.2-sol", "gpt-6.2-astra"]) expect(CODEX_MODEL_OPTIONS.find(option => option.value === value)?.nativeRequirement)
      .toEqual({ providerId: "codex", minimumVersion: "0.166.0" });
    expect(CLAUDE_EXEC_MODEL_OPTIONS.find(option => option.value === "claude-fable-5-2")?.nativeRequirement)
      .toEqual({ providerId: "claude", minimumVersion: "2.1.321" });
    expect(CLAUDE_EXEC_MODEL_OPTIONS.find(option => option.value === "claude-haiku-5-5")?.nativeRequirement)
      .toEqual({ providerId: "claude", minimumVersion: "2.1.293" });
    expect(GLOBAL_CONFIG_FIELDS.find(field => field.key === "voiceModel")?.defaultValue).toBe("gpt-5.6-luna");
    expect(forgeConfigFields().find(field => field.key === "workerModel")?.defaultValue).toBe("gpt-6.1-sol");
  });

  it("offers identical Codex and Claude choices in every Voice, Forge, and documentation model dropdown", () => {
    const documentation = new DocumentationPlugin(new DocumentationClient(), new PathPolicy(["/tmp"]), new DocumentationIngestQueue());
    const fields = [...GLOBAL_CONFIG_FIELDS, ...forgeConfigFields(), ...documentation.descriptor().configFields]
      .filter((field) => field.key.endsWith("Model"));

    expect(fields.map((field) => field.key)).toEqual([
      "voiceModel", "workerModel", "reviewModel", "aiImageAnalysisModel", "aiTextAnalysisModel", "aiAnswerModel"
    ]);
    for (const field of fields) {
      expect(field.type, field.key).toBe("select");
      expect(field.options?.filter((option) => option.value !== DOCUMENTATION_AI_USE_VOICE_MODEL), field.key).toEqual(AGENT_EXEC_MODEL_OPTIONS);
      expect(field.options?.map((option) => option.value), `${field.key} default`).toContain(field.defaultValue);
    }
    for (const field of documentation.configFields.filter((field) => field.key.endsWith("Model"))) {
      expect(field.options?.[0], field.key).toMatchObject({ value: DOCUMENTATION_AI_USE_VOICE_MODEL, label: "Same as voice control" });
    }
  });

  it("offers only concrete Claude model ids for one-shot requests", () => {
    expect(CLAUDE_EXEC_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "claude-fable-5-2", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"
    ]);
  });
});
