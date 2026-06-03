import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudxConfigResponse, RulesSkillsStore } from "@cloudx/shared";

import { SettingsDialog } from "./SettingsDialog.js";

describe("SettingsDialog", () => {
  it("renders the global default personality template selector", () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        config={configResponse()}
        rulesSkillsStore={rulesSkillsStore()}
        onCancel={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveDefaultTemplate={vi.fn(async () => undefined)}
      />
    );

    expect(html).toContain("Default template");
    expect(html).toContain("Focused (default)");
    expect(html).toContain("Review");
    expect(html).not.toContain(">Inherited<");
  });
});

function configResponse(): CloudxConfigResponse {
  return {
    globalFields: [],
    plugins: [],
    values: {
      global: {},
      plugins: {}
    }
  };
}

function rulesSkillsStore(): RulesSkillsStore {
  return {
    defaultTemplateId: "focused",
    rules: [],
    systemRules: [],
    skills: [],
    systemSkills: [],
    templates: [
      { id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] },
      { id: "review", name: "Review", color: "red", ruleIds: [], skillIds: [] }
    ]
  };
}
