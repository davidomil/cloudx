import { describe, expect, it } from "vitest";

import { CODEX_MODEL_OPTIONS, DOCUMENTATION_AI_USE_VOICE_MODEL } from "./aiModelOptions.js";
import { GLOBAL_CONFIG_FIELDS } from "./configService.js";
import { DocumentationClient } from "./documentation/DocumentationClient.js";
import { DocumentationIngestQueue } from "./documentation/DocumentationIngestQueue.js";
import { forgeConfigFields } from "./forge/ForgeSettingsService.js";
import { PathPolicy } from "./pathPolicy.js";
import { DocumentationPlugin } from "./plugins/DocumentationPlugin.js";

describe("Settings model choices", () => {
  it("includes the visible GPT-6 and GPT-5.6 models alongside all previous choices", () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark"
    ]);
  });

  it("offers identical concrete choices in every Voice, Forge, and documentation model dropdown", () => {
    const documentation = new DocumentationPlugin(new DocumentationClient(), new PathPolicy(["/tmp"]), new DocumentationIngestQueue());
    const fields = [...GLOBAL_CONFIG_FIELDS, ...forgeConfigFields(), ...documentation.descriptor().configFields]
      .filter((field) => field.key.endsWith("Model"));

    expect(fields.map((field) => field.key)).toEqual([
      "voiceModel", "workerModel", "reviewModel", "aiImageAnalysisModel", "aiTextAnalysisModel", "aiAnswerModel"
    ]);
    for (const field of fields) {
      expect(field.type, field.key).toBe("select");
      expect(field.options?.filter((option) => option.value !== DOCUMENTATION_AI_USE_VOICE_MODEL), field.key).toEqual(CODEX_MODEL_OPTIONS);
    }
    for (const field of documentation.configFields.filter((field) => field.key.endsWith("Model"))) {
      expect(field.options?.[0], field.key).toMatchObject({ value: DOCUMENTATION_AI_USE_VOICE_MODEL, label: "Same as voice control" });
    }
  });
});
