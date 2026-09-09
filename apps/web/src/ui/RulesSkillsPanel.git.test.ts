// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesSkillsGitState, RulesSkillsStore } from "@cloudx/shared";

import { RulesSkillsPanel } from "./RulesSkillsPanel.js";

const checkout: RulesSkillsGitState = { isRepository: true, rootPath: "/catalog", branch: "main", originUrl: "git@example.test:team/catalog.git", hasChanges: false, hasCommits: true };
const store: RulesSkillsStore = {
  templates: [{ id: "default", name: "Default", color: "green", ruleIds: ["focused"], skillIds: [] }],
  rules: [{ id: "focused", description: "Keep focused.", text: "Keep focused." }],
  skills: [], systemRules: [], systemSkills: []
};
const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount(onPullGit = vi.fn(async () => checkout)) {
  const props = {
    store,
    onSaveTemplate: async () => undefined,
    onDeleteTemplate: async () => undefined,
    onSetDefault: async () => undefined,
    onSaveRule: async () => undefined,
    onDeleteRule: async () => undefined,
    gitActions: { onLoadGit: async () => checkout, onSetGitOrigin: async () => checkout, onPushGit: async () => checkout, onPullGit }
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  async function render(currentStore = store) { await act(async () => root.render(createElement(RulesSkillsPanel, { ...props, store: currentStore }))); }
  await render();
  return { container, onPullGit, render };
}
function button(container: Element, label: string) {
  const found = [...container.querySelectorAll("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(container: Element, label: string) { await act(async () => button(container, label).click()); }
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("catalog Git and template drafts", () => {
  it.each(["template", "new rule", "rule edit", "new template"])("blocks pull while there is a %s draft", async (draft) => {
    const { container, onPullGit } = await mount();
    expect(button(container, "Pull").disabled).toBe(false);
    if (draft === "template") await fill(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!, "Unsaved template");
    if (draft === "new rule") await fill(container.querySelector<HTMLInputElement>('[placeholder="Add short rule sentence"]')!, "Unsaved rule");
    if (draft === "rule edit") await click(container, "Edit rule focused");
    if (draft === "new template") await click(container, "Create template");
    expect(button(container, "Pull").disabled).toBe(true);
    expect(container.textContent).toContain("Save or discard template and rule edits before pulling.");
    await click(container, "Pull");
    expect(onPullGit).not.toHaveBeenCalled();
  });

  it("blocks editing throughout pull and adopts the returned catalog after it completes", async () => {
    let finish!: (state: RulesSkillsGitState) => void;
    const onPullGit = vi.fn(() => new Promise<RulesSkillsGitState>(resolve => { finish = resolve; }));
    const { container, render } = await mount(onPullGit);
    await click(container, "Pull");
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
    expect(button(container, "Create template").disabled).toBe(true);
    expect(button(container, "Default").disabled).toBe(true);
    expect(button(container, "Push commits").disabled).toBe(true);
    await render({ ...store, templates: [{ ...store.templates[0], name: "Pulled template" }], rules: [{ ...store.rules[0], text: "Pulled rule." }] });
    await act(async () => finish(checkout));
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Pulled template");
    expect(container.textContent).toContain("Pulled rule.");
    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Saved");
  });

  it("restores editing and preserves the selected template when pull fails", async () => {
    const { container } = await mount(vi.fn(async () => { throw new Error("Branches have diverged. Resolve this locally."); }));
    await click(container, "Pull");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Branches have diverged. Resolve this locally.");
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Default");
  });
});
