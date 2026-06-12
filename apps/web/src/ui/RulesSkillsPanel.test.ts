// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { CloudxRule, PersonalityTemplate, RulesSkillsStore } from "@cloudx/shared";

import { cloudxRuleFromEdit, cloudxRuleFromText, draftWithRuleEnabled, personalityTemplatesEqual, RulesSkillsPanel, templateDraftsEqual, templateFromDraft, type TemplateDraft } from "./RulesSkillsPanel.js";

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
    expect(cloudxRuleFromText(" !!! ")).toBeUndefined();
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

  it("tracks template drafts as dirty only when the saved payload changes", () => {
    const draft: TemplateDraft = {
      id: "default",
      name: "Default ",
      color: "green",
      ruleIds: ["keep-focused", "test-first"],
      skillIds: ["reviewer"]
    };
    const saved: TemplateDraft = {
      id: "default",
      name: "Default",
      color: "green",
      ruleIds: ["keep-focused", "test-first"],
      skillIds: ["reviewer"]
    };

    expect(templateDraftsEqual(draft, saved)).toBe(true);
    expect(personalityTemplatesEqual(templateFromDraft(draft), { ...templateFromDraft(saved), ruleIds: ["test-first", "keep-focused"] })).toBe(false);
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

  it("renders one rule editor when refreshed rules contain duplicate ids", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const store = rulesSkillsStore();
    const duplicateStore: RulesSkillsStore = {
      ...store,
      rules: [
        ...store.rules,
        { id: "keep-focused", description: "Duplicate focused rule.", text: "Duplicate focused rule." }
      ]
    };
    const props = {
      onSaveTemplate: async () => undefined,
      onDeleteTemplate: async () => undefined,
      onSetDefault: async () => undefined,
      onSaveRule: async () => undefined,
      onDeleteRule: async () => undefined
    };

    await act(async () => {
      root.render(createElement(RulesSkillsPanel, { ...props, store }));
    });
    const editButton = container.querySelector('[aria-label="Edit rule keep-focused"]') as HTMLButtonElement;
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelectorAll(".rule-option-editing")).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Rule text for keep-focused"]')).toHaveLength(1);

    await act(async () => {
      root.render(createElement(RulesSkillsPanel, { ...props, store: duplicateStore }));
    });

    expect(container.querySelectorAll(".rule-option-editing")).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Rule text for keep-focused"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Edit rule keep-focused"]')).toHaveLength(0);

    await unmount(root);
  });

  it("separates template saving from runtime injection and shows dirty state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const savedTemplates: PersonalityTemplate[] = [];
    let injections = 0;

    await act(async () => {
      root.render(
        createElement(RulesSkillsPanel, {
          store: rulesSkillsStore(),
          onSaveTemplate: async (template: PersonalityTemplate) => {
            savedTemplates.push(template);
          },
          onDeleteTemplate: async () => undefined,
          onSetDefault: async () => undefined,
          onSaveRule: async () => undefined,
          onDeleteRule: async () => undefined,
          onInjectRuntime: async () => {
            injections += 1;
            return 2;
          }
        })
      );
    });

    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Saved");
    const injectButton = container.querySelector('[aria-label="Inject saved rules and skills"]') as HTMLButtonElement;
    await act(async () => {
      injectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(injections).toBe(1);
    expect(savedTemplates).toEqual([]);

    const nameInput = container.querySelector("label input") as HTMLInputElement;
    setInputValue(nameInput, "Default Codex");
    await act(async () => {
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Unsaved");
    expect(injectButton.disabled).toBe(true);

    const saveButton = container.querySelector('[aria-label="Save template"]') as HTMLButtonElement;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(savedTemplates).toEqual([
      {
        id: "default",
        name: "Default Codex",
        color: "green",
        ruleIds: ["keep-focused"],
        skillIds: []
      }
    ]);
    expect(injections).toBe(1);

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
    systemRules: [],
    skills: [],
    systemSkills: []
  };
}

function setTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}
