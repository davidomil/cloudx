// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RULES_SKILLS_PLUGIN_ID, type CloudxRule, type PersonalityTemplate, type PluginDescriptor, type RulesSkillsGitState, type RulesSkillsStore, type WorkspaceStateResponse, type WorkspaceTab } from "@cloudx/shared";

import { App } from "./App.js";

const checkout: RulesSkillsGitState = { isRepository: true, rootPath: "/catalog", branch: "main", originUrl: "/remotes/catalog.git", hasChanges: false, hasCommits: true };
const initialStore: RulesSkillsStore = {
  templates: [{ id: "default", name: "Default", color: "green", ruleIds: ["focused"], skillIds: [] }],
  rules: [{ id: "focused", description: "Keep focused.", text: "Keep focused." }],
  skills: [], systemRules: [], systemSkills: []
};
const pulledStore: RulesSkillsStore = {
  ...initialStore,
  templates: [{ ...initialStore.templates[0], name: "Pulled template", color: "red", ruleIds: [] }]
};
const plugin: PluginDescriptor = {
  id: RULES_SKILLS_PLUGIN_ID, acronym: "RUL", displayName: "Rules & Skills", description: "Catalog", panelKind: "placeholder", creatable: true, requiresDirectory: false, actions: [], configFields: [],
  uiContributions: [{ id: "rules-skills.templatesPanel", owner: { kind: "plugin", pluginId: RULES_SKILLS_PLUGIN_ID }, slot: "plugin.panel", renderer: "rules-skills.templates-panel", title: "Rules & Skills Templates", targetPluginId: RULES_SKILLS_PLUGIN_ID }]
};
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", class { addEventListener() {} close() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function twoPaneCatalog(startingStore = initialStore) {
  let store = startingStore;
  const savedTemplates: PersonalityTemplate[] = [];
  const savedRules: CloudxRule[] = [];
  const pulls: ReturnType<typeof deferred<Response>>[] = [];
  const tabs: WorkspaceTab[] = ["first", "second"].map(id => ({ id, pluginId: RULES_SKILLS_PLUGIN_ID, title: `Rules ${id}`, cwd: "/catalog", status: "idle", indicator: { color: "green", label: "Ready", updatedAt: "2026-09-09" }, createdAt: "2026-09-09", updatedAt: "2026-09-09" }));
  const workspace: WorkspaceStateResponse = {
    tabs, activeTabId: tabs[0].id, activeWindowId: "window", templates: [],
    windows: [{ id: "window", name: "Catalog", defaultCwd: "/catalog", createdAt: "2026-09-09", updatedAt: "2026-09-09", layout: {
      activePaneId: "first-pane",
      root: { type: "split", id: "split", direction: "row", sizes: [50, 50], children: [
        { type: "pane", pane: { id: "first-pane", tabIds: [tabs[0].id], activeTabId: tabs[0].id } },
        { type: "pane", pane: { id: "second-pane", tabIds: [tabs[1].id], activeTabId: tabs[1].id } }
      ] }
    } }]
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/hooks/rules-skills.catalog.list") return reply({ result: { store } });
    if (url === "/api/hooks/rules-skills.git.status") return reply({ result: { git: checkout } });
    if (url === "/api/hooks/rules-skills.git.pull") {
      const pull = deferred<Response>();
      pulls.push(pull);
      return pull.promise;
    }
    if (url === "/api/hooks/rules-skills.templates.save") {
      const { template } = JSON.parse(String(init?.body)).input as { template: PersonalityTemplate };
      savedTemplates.push(template);
      store = { ...store, templates: [...store.templates.filter(saved => saved.id !== template.id), template] };
      return reply({ result: { store } });
    }
    if (url === "/api/hooks/rules-skills.rules.save") {
      const { rule } = JSON.parse(String(init?.body)).input as { rule: CloudxRule };
      savedRules.push(rule);
      store = { ...store, rules: [...store.rules.filter(saved => saved.id !== rule.id), rule] };
      return reply({ result: { store } });
    }
    if (url === "/api/hooks/rules-skills.templates.delete") {
      const { templateId } = JSON.parse(String(init?.body)).input as { templateId: string };
      store = { ...store, templates: store.templates.filter(template => template.id !== templateId) };
      return reply({ result: { store } });
    }
    const responses: Record<string, unknown> = {
      "/api/plugins": { plugins: [plugin] },
      "/api/workspace": workspace,
      "/api/tabs/first/active": {},
      "/api/tabs/second/active": {},
      "/api/config": { globalFields: [], plugins: [], values: { global: { microphoneEnabled: false, voiceCommandsEnabled: false, aiControlEnabled: false }, plugins: {} } },
      "/api/automation/catalog": { nodes: [] },
      "/api/automation/groups": { groups: [] },
      "/api/notifications": { notifications: [] },
      "/api/health": { ok: true }
    };
    if (!(url in responses)) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    return reply(responses[url]);
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(App)));
  const panels = container.querySelectorAll(".rules-skills-panel");
  expect(panels).toHaveLength(2);
  const [first, second] = [...panels];
  expect(button(first, "Pull").disabled).toBe(false);
  expect(button(second, "Pull").disabled).toBe(false);
  return {
    first, second, pulls, savedTemplates, savedRules,
    async finishPull(nextStore = pulledStore) {
      store = nextStore;
      await act(async () => pulls.at(-1)!.resolve(reply({ result: { git: checkout, store } })));
    },
    async failPull() {
      await act(async () => pulls.at(-1)!.resolve(reply({ message: "Branches have diverged." }, 409)));
    }
  };
}

function button(panel: Element, label: string) {
  const found = [...panel.querySelectorAll("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(panel: Element, label: string) { await act(async () => button(panel, label).click()); }
function templateName(panel: Element) { return panel.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!; }
function saveState(panel: Element) { return panel.querySelector(".rules-skills-save-state")?.textContent; }
async function renameTemplate(panel: Element, name: string) {
  await act(async () => {
    const input = templateName(panel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function editRule(panel: Element, ruleId: string, text: string) {
  await click(panel, `Edit rule ${ruleId}`);
  await act(async () => {
    const editor = panel.querySelector<HTMLElement>(`[aria-label="Rule text for ${ruleId}"]`)!;
    editor.textContent = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("catalog Git drafts across App panes", () => {
  it.each([
    ["before", "save"], ["during", "save"], ["before", "cancel"], ["during", "cancel"]
  ])("keeps a rule edited %s another pane pulls its deletion accessible for %s", async (timing, recovery) => {
    const rule = { ...initialStore.rules[0], description: "Separate rule description." };
    const catalog = await twoPaneCatalog({ ...initialStore, rules: [rule] });
    if (timing === "before") await editRule(catalog.second, rule.id, "Keep this unsaved rule.");
    await click(catalog.first, "Pull");
    if (timing === "during") await editRule(catalog.second, rule.id, "Keep this unsaved rule.");
    await catalog.finishPull({ ...initialStore, rules: [], templates: [{ ...initialStore.templates[0], ruleIds: [] }] });

    expect(catalog.second.querySelector(`[aria-label="Rule text for ${rule.id}"]`)?.textContent).toBe("Keep this unsaved rule.");
    expect(catalog.second.textContent).toContain("Removed from catalog. Save to restore this rule or cancel to discard the draft.");
    expect(button(catalog.second, `Save rule ${rule.id}`).disabled).toBe(false);
    expect(button(catalog.second, `Cancel editing ${rule.id}`).disabled).toBe(false);
    expect(button(catalog.second, "Pull").disabled).toBe(true);

    await click(catalog.second, "Refresh rules and skills");
    expect(catalog.second.querySelector(`[aria-label="Rule text for ${rule.id}"]`)?.textContent).toBe("Keep this unsaved rule.");
    await click(catalog.second, recovery === "save" ? `Save rule ${rule.id}` : `Cancel editing ${rule.id}`);
    expect(catalog.second.querySelector(`[aria-label="Rule text for ${rule.id}"]`)).toBeNull();
    expect(button(catalog.second, "Pull").disabled).toBe(false);
    if (recovery === "save") {
      expect(catalog.savedRules).toEqual([{ ...rule, text: "Keep this unsaved rule." }]);
      expect(catalog.first.textContent).toContain("Keep this unsaved rule.");
    } else {
      expect(catalog.savedRules).toEqual([]);
      expect(catalog.second.textContent).not.toContain("Keep this unsaved rule.");
    }
    await click(catalog.second, "Pull");
    expect(catalog.pulls).toHaveLength(2);
    await catalog.finishPull();
  });

  it.each([
    ["before", "rule"], ["during", "rule"], ["before", "skill"], ["during", "skill"]
  ])("reconciles a selected %s-pull missing %s without discarding other template edits", async (timing, removedKind) => {
    const template: PersonalityTemplate = { ...initialStore.templates[0], ruleIds: ["focused", "tested"], skillIds: ["reviewer", "builder"] };
    const store: RulesSkillsStore = {
      ...initialStore,
      templates: [template],
      rules: [...initialStore.rules, { id: "tested", description: "Test changes.", text: "Test changes." }],
      skills: [{ id: "reviewer", name: "Reviewer", description: "Review changes." }, { id: "builder", name: "Builder", description: "Build changes." }]
    };
    const catalog = await twoPaneCatalog(store);
    async function editTemplate() {
      await renameTemplate(catalog.second, "Keep this renamed template");
      await act(async () => {
        const color = catalog.second.querySelector<HTMLSelectElement>(".rules-skills-template-fields select")!;
        color.value = "yellow";
        color.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    if (timing === "before") await editTemplate();
    await click(catalog.first, "Pull");
    if (timing === "during") await editTemplate();
    const reconciledTemplate = { ...template, ruleIds: removedKind === "rule" ? ["tested"] : template.ruleIds, skillIds: removedKind === "skill" ? ["builder"] : template.skillIds };
    await catalog.finishPull({ ...store, templates: [reconciledTemplate], rules: removedKind === "rule" ? store.rules.slice(1) : store.rules, skills: removedKind === "skill" ? store.skills.slice(1) : store.skills });

    const removedId = removedKind === "rule" ? "focused" : "reviewer";
    const missingSelection = catalog.second.querySelector<HTMLInputElement>(`[aria-label="Missing ${removedKind} ${removedId}"]`);
    expect(missingSelection?.checked).toBe(true);
    expect(button(catalog.second, "Save template").disabled).toBe(true);
    expect(catalog.second.textContent).toContain("Deselect missing rules and skills or restore them before saving this template.");
    await act(async () => missingSelection!.click());
    expect(templateName(catalog.second).value).toBe("Keep this renamed template");
    expect(button(catalog.second, "Save template").disabled).toBe(false);
    await click(catalog.second, "Save template");
    expect(catalog.savedTemplates).toEqual([{ ...reconciledTemplate, name: "Keep this renamed template", color: "yellow" }]);
    expect(saveState(catalog.second)).toBe("Saved");
    expect(button(catalog.second, "Pull").disabled).toBe(false);
  });

  it.each(["before", "during"])("preserves edits made %s another pane pulls, then saves the preserved template", async timing => {
    const catalog = await twoPaneCatalog();
    if (timing === "before") await renameTemplate(catalog.second, "Unsaved template");
    await click(catalog.first, "Pull");
    if (timing === "during") await renameTemplate(catalog.second, "Unsaved template");
    expect(catalog.pulls).toHaveLength(1);
    await catalog.finishPull();

    expect(templateName(catalog.first).value).toBe("Pulled template");
    expect(saveState(catalog.first)).toBe("Saved");
    expect(templateName(catalog.second).value).toBe("Unsaved template");
    expect(saveState(catalog.second)).toBe("Unsaved");
    expect(button(catalog.second, "Pull").disabled).toBe(true);
    await click(catalog.second, "Save template");
    expect(catalog.savedTemplates).toEqual([{ ...initialStore.templates[0], name: "Unsaved template" }]);
    expect(saveState(catalog.second)).toBe("Saved");
    expect(templateName(catalog.first).value).toBe("Unsaved template");

    await click(catalog.first, "Pull");
    await catalog.finishPull();
    expect(templateName(catalog.second).value).toBe("Pulled template");
    expect(saveState(catalog.second)).toBe("Saved");
  });

  it("preserves the other pane's draft when a pull fails and releases the initiating editor for another pull", async () => {
    const catalog = await twoPaneCatalog();
    await click(catalog.first, "Pull");
    await renameTemplate(catalog.second, "Still unsaved");
    await catalog.failPull();
    expect(catalog.first.querySelector('[role="alert"]')?.textContent).toBe("Branches have diverged.");
    expect(templateName(catalog.first).value).toBe("Default");
    expect(catalog.first.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
    expect(templateName(catalog.second).value).toBe("Still unsaved");
    expect(saveState(catalog.second)).toBe("Unsaved");
    await click(catalog.first, "Pull");
    expect(catalog.pulls).toHaveLength(2);
    await catalog.finishPull();
    expect(templateName(catalog.second).value).toBe("Still unsaved");
    expect(catalog.first.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a dirty template that the pulled catalog removed and saves it under its original ID", async () => {
    const catalog = await twoPaneCatalog();
    await renameTemplate(catalog.second, "Keep this template");
    await click(catalog.first, "Pull");
    await catalog.finishPull({ ...pulledStore, templates: [{ ...pulledStore.templates[0], id: "replacement" }] });
    expect(templateName(catalog.first).value).toBe("Pulled template");
    expect(templateName(catalog.second).value).toBe("Keep this template");
    expect(saveState(catalog.second)).toBe("Unsaved");
    await click(catalog.second, "Save template");
    expect(catalog.savedTemplates).toEqual([{ ...initialStore.templates[0], name: "Keep this template" }]);
    expect(saveState(catalog.second)).toBe("Saved");
  });

  it("discards a preserved draft only after the user confirms an explicit refresh", async () => {
    const catalog = await twoPaneCatalog();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renameTemplate(catalog.second, "Unsaved template");
    await click(catalog.first, "Pull");
    await catalog.finishPull();
    await click(catalog.second, "Refresh rules and skills");
    expect(templateName(catalog.second).value).toBe("Unsaved template");
    confirm.mockReturnValue(true);
    await click(catalog.second, "Refresh rules and skills");
    expect(templateName(catalog.second).value).toBe("Pulled template");
    expect(saveState(catalog.second)).toBe("Saved");
  });

  it("adopts the remaining template after explicitly deleting a saved template", async () => {
    const catalog = await twoPaneCatalog();
    await click(catalog.first, "Pull");
    await catalog.finishPull({ ...initialStore, templates: [...initialStore.templates, { ...initialStore.templates[0], id: "second", name: "Second" }] });
    await renameTemplate(catalog.second, "Unsaved template");
    expect(button(catalog.second, "Delete template").disabled).toBe(true);
    await click(catalog.first, "Delete template");
    expect(templateName(catalog.first).value).toBe("Second");
    expect(saveState(catalog.first)).toBe("Saved");
    expect(templateName(catalog.second).value).toBe("Unsaved template");
    expect(saveState(catalog.second)).toBe("Unsaved");
  });
});
