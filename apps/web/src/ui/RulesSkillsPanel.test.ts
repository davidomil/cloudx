// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { CloudxRule, PersonalityTemplate, RulesSkillsStore } from "@cloudx/shared";

import { cloudxRuleFromEdit, cloudxRuleFromText, draftWithRuleEnabled, RulesSkillsPanel, templateFromDraft, type TemplateDraft } from "./RulesSkillsPanel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

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

  it("edits an existing rule without changing its stable id", () => {
    expect(
      cloudxRuleFromEdit(
        {
          id: "keep-changes-focused",
          description: "Keep changes focused.",
          text: "Keep changes focused."
        },
        " Keep changes focused and tested. ",
        " "
      )
    ).toEqual({
      id: "keep-changes-focused",
      description: "Keep changes focused and tested.",
      text: "Keep changes focused and tested."
    });

    expect(cloudxRuleFromEdit({ id: "empty", description: "Empty", text: "Empty" }, "   ", "Unused")).toBeUndefined();
  });

  it("saves edits to an existing rule from the rules picker", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const savedRules: CloudxRule[] = [];

    await act(async () => {
      root.render(
        createElement(RulesSkillsPanel, {
          store: rulesSkillsStore(),
          onSaveTemplate: async () => undefined,
          onDeleteTemplate: async () => undefined,
          onSetDefault: async () => undefined,
          onSaveRule: async (rule: CloudxRule) => {
            savedRules.push(rule);
          },
          onDeleteRule: async () => undefined
        })
      );
    });

    const editButton = container.querySelector('[aria-label="Edit rule keep-focused"]') as HTMLButtonElement;
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textArea = container.querySelector('[aria-label="Rule text for keep-focused"]') as HTMLTextAreaElement;
    setTextAreaValue(textArea, "Keep focused and test the change.");
    await act(async () => {
      textArea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = container.querySelector('[aria-label="Save rule keep-focused"]') as HTMLButtonElement;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(savedRules).toEqual([
      {
        id: "keep-focused",
        description: "Keep focused and test the change.",
        text: "Keep focused and test the change."
      }
    ]);

    await unmount(root);
  });
});

function rulesSkillsStore(): RulesSkillsStore {
  const template: PersonalityTemplate = {
    id: "default",
    name: "Default",
    color: "green",
    ruleIds: ["keep-focused"],
    skillIds: []
  };
  return {
    templates: [template],
    defaultTemplateId: template.id,
    rules: [{ id: "keep-focused", description: "Keep focused.", text: "Keep focused." }],
    skills: [],
    systemSkills: []
  };
}

function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}
