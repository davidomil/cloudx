import { describe, expect, it } from "vitest";

import { cloudxRuleFromText, draftWithRuleEnabled, templateFromDraft, type TemplateDraft } from "./RulesSkillsPanel.js";

describe("RulesSkillsPanel helpers", () => {
  it("creates a rule from text using the rule sentence as description", () => {
    expect(cloudxRuleFromText(" Keep changes focused. ")).toEqual({
      id: "keep-changes-focused",
      description: "Keep changes focused.",
      text: "Keep changes focused."
    });
  });

  it("enables newly created rules in the selected template draft without duplicates", () => {
    const draft: TemplateDraft = {
      id: "default-codex",
      name: "Default Codex",
      color: "green",
      ruleIds: ["existing-rule"],
      skillIds: []
    };

    const enabled = draftWithRuleEnabled(draft, "new-rule");
    const duplicate = draftWithRuleEnabled(enabled, "new-rule");

    expect(templateFromDraft(enabled).ruleIds).toEqual(["existing-rule", "new-rule"]);
    expect(templateFromDraft(duplicate).ruleIds).toEqual(["existing-rule", "new-rule"]);
  });
});
