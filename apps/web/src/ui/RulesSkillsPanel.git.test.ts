// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxRule, RulesSkillsGitState, RulesSkillsStore } from "@cloudx/shared";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(onPullGit = vi.fn(async () => checkout), onRefreshStore?: () => Promise<void>, onSaveRule: (rule: CloudxRule) => Promise<void> = async () => undefined) {
  const props = {
    store,
    onSaveTemplate: async () => undefined,
    onDeleteTemplate: async () => undefined,
    onSetDefault: async () => undefined,
    onSaveRule,
    onDeleteRule: async () => undefined,
    onRefreshStore,
    gitActions: { git: checkout, onLoadGit: async () => checkout, onSetGitOrigin: async () => checkout, onPushGit: async () => checkout, onPullGit }
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
  it("keeps a removed rule draft accessible after saving fails and permits cancellation", async () => {
    const onSaveRule = vi.fn(async () => { throw new Error("Could not save rule."); });
    const { container, render } = await mount(undefined, undefined, onSaveRule);
    await click(container, "Edit rule focused");
    await act(async () => {
      const editor = container.querySelector<HTMLElement>('[aria-label="Rule text for focused"]')!;
      editor.textContent = "Keep this draft.";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render({ ...store, rules: [], templates: [{ ...store.templates[0], ruleIds: [] }] });
    await click(container, "Save rule focused");
    expect(container.textContent).toContain("Could not save rule.");
    expect(container.querySelector('[aria-label="Rule text for focused"]')?.textContent).toBe("Keep this draft.");
    expect(button(container, "Save rule focused").disabled).toBe(false);
    expect(button(container, "Pull").disabled).toBe(true);
    await click(container, "Cancel editing focused");
    expect(container.querySelector('[aria-label="Rule text for focused"]')).toBeNull();
    expect(button(container, "Pull").disabled).toBe(false);
  });

  it("retains missing selections until the user deselects them or the catalog restores them", async () => {
    const { container, render } = await mount();
    await fill(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!, "Keep this template name");
    await render({ ...store, rules: [], templates: [{ ...store.templates[0], ruleIds: [] }] });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Missing rule focused"]')?.checked).toBe(true);
    expect(button(container, "Save template").disabled).toBe(true);
    await render(store);
    expect(container.querySelector('[aria-label="Missing rule focused"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('.rule-option input[type="checkbox"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Keep this template name");
    expect(button(container, "Save template").disabled).toBe(false);
  });

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

  it.each(["before", "after"])("loads the explicitly refreshed template when its catalog arrives %s the refresh completes", async (timing) => {
    let finish!: () => void;
    const onRefreshStore = vi.fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { container, render } = await mount(undefined, onRefreshStore);
    const refreshedStore = { ...store, templates: [{ ...store.templates[0], name: "Refreshed template" }] };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await fill(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!, "Discard this draft");
    await click(container, "Refresh rules and skills");
    if (timing === "before") await render(refreshedStore);
    await act(async () => finish());
    if (timing === "after") await render(refreshedStore);
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Refreshed template");
    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Saved");
  });

  it("keeps a draft if an explicitly confirmed refresh fails", async () => {
    const onRefreshStore = vi.fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Catalog refresh failed."));
    const { container } = await mount(undefined, onRefreshStore);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await fill(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!, "Keep this draft");
    await click(container, "Refresh rules and skills");
    expect(container.textContent).toContain("Catalog refresh failed.");
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Keep this draft");
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Unsaved");
  });

  it("confirms discarding a dirty selection and then adopts later updates to the selected template", async () => {
    const { container, render } = await mount();
    const secondTemplate = { ...store.templates[0], id: "second", name: "Second" };
    await render({ ...store, templates: [...store.templates, secondTemplate] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await fill(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!, "Unsaved template");
    await click(container, "Second");
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Unsaved template");
    confirm.mockReturnValue(true);
    await click(container, "Second");
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Second");
    await render({ ...store, templates: [...store.templates, { ...secondTemplate, name: "Updated second" }] });
    expect(container.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!.value).toBe("Updated second");
    expect(container.querySelector(".rules-skills-save-state")?.textContent).toBe("Saved");
  });
});
