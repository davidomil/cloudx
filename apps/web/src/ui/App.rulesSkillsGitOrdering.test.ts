// @vitest-environment jsdom

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RULES_SKILLS_PLUGIN_ID, type PluginDescriptor, type RulesSkillsStore, type WorkspaceStateResponse, type WorkspaceTab } from "@cloudx/shared";

import { App } from "./App.js";

interface Catalog {
  catalogRoot(): string;
  list(): Promise<RulesSkillsStore>;
  saveTemplate(template: Record<string, unknown>): Promise<RulesSkillsStore>;
}
interface Hooks {
  register(hook: unknown): void;
  call(id: string, input: Record<string, unknown>, context: { caller: { kind: "ui" } }): Promise<Record<string, unknown>>;
}

// Load the real server modules without including their sources in the web TypeScript project.
const { RulesSkillsCatalogService } = await vi.importActual<{ RulesSkillsCatalogService: new (dataDir: string) => Catalog }>("../../../server/src/rulesSkills/RulesSkillsCatalogService.js");
const { RulesSkillsPlugin } = await vi.importActual<{ RulesSkillsPlugin: new (catalog: Catalog) => { hooks: unknown[]; descriptor(): PluginDescriptor } }>("../../../server/src/plugins/RulesSkillsPlugin.js");
const { HookRegistry } = await vi.importActual<{ HookRegistry: new () => Hooks }>("../../../server/src/hooks/HookRegistry.js");

const execute = promisify(execFile);
const roots: Root[] = [];
const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", class { addEventListener() {} close() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
});

afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  await act(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("catalog response ordering across App panes", () => {
  describe.each(["request", "response"] as const)("rule saves queued behind a delayed pull %s", delay => {
    it.each(["before", "during"])("keeps pulled metadata with text drafted %s pull", async timing => {
      const catalog = await twoPaneCatalog();
      const description = "Description updated on origin.";
      const text = "Keep this queued local rule text.";
      const incomingHead = await catalog.publishRuleDescription(description);
      if (timing === "before") await editRule(catalog.second, catalog.ruleId, text);
      const pulling = delay === "request" ? catalog.holdNextRequest("git.pull") : catalog.holdNextResponse("git.pull");
      await click(catalog.first, "Pull");
      await pulling.ready;
      if (timing === "during") await editRule(catalog.second, catalog.ruleId, text);
      await catalog.queue(catalog.second, `Save rule ${catalog.ruleId}`);
      await act(async () => pulling.release());
      await catalog.finishRequests();

      expect(await catalog.head()).toBe(incomingHead);
      expect(await catalog.savedRuleFile()).toContain(`description: ${description}\n`);
      expect(await catalog.savedRuleFile()).toContain(`\n${text}\n`);
      await catalog.perform(catalog.first, "Refresh rules and skills", "catalog.list");
      for (const pane of [catalog.first, catalog.second]) {
        const rule = button(pane, `Edit rule ${catalog.ruleId}`).closest(".rule-option")!;
        expect(rule.textContent).toBe(text);
        expect(rule.getAttribute("title")).toBe(description);
        expect(pane.querySelector(`[aria-label="Rule text for ${catalog.ruleId}"]`)).toBeNull();
      }
    });

    it("retains a queued rule draft after save failure and uses pulled metadata on the next save", async () => {
      const catalog = await twoPaneCatalog();
      const description = "Description to preserve after save failure.";
      const text = "Keep this draft after the failed save.";
      await catalog.publishRuleDescription(description);
      await editRule(catalog.second, catalog.ruleId, text);
      const pulling = delay === "request" ? catalog.holdNextRequest("git.pull") : catalog.holdNextResponse("git.pull");
      await click(catalog.first, "Pull");
      await pulling.ready;
      catalog.failNextRequest("rules.save", "Rule save failed.");
      await catalog.queue(catalog.second, `Save rule ${catalog.ruleId}`);
      await act(async () => pulling.release());
      await catalog.finishRequests();

      expect(catalog.second.textContent).toContain("Rule save failed.");
      expect(catalog.second.querySelector(`[aria-label="Rule text for ${catalog.ruleId}"]`)?.textContent).toBe(text);
      expect(await catalog.savedRuleFile()).toContain(`description: ${description}\n`);
      expect(await catalog.savedRuleFile()).not.toContain(text);
      await catalog.perform(catalog.second, `Save rule ${catalog.ruleId}`, "rules.save");
      expect(await catalog.savedRuleFile()).toContain(`description: ${description}\n`);
      expect(await catalog.savedRuleFile()).toContain(`\n${text}\n`);
    });

    it("restores a rule deleted by the pending pull with its captured metadata", async () => {
      const catalog = await twoPaneCatalog();
      const originalRule = (await catalog.savedStore()).rules.find(rule => rule.id === catalog.ruleId)!;
      const text = "Restore this queued rule text.";
      await catalog.publishRuleDeletion();
      await editRule(catalog.second, catalog.ruleId, text);
      const pulling = delay === "request" ? catalog.holdNextRequest("git.pull") : catalog.holdNextResponse("git.pull");
      await click(catalog.first, "Pull");
      await pulling.ready;
      await catalog.queue(catalog.second, `Save rule ${catalog.ruleId}`);
      await act(async () => pulling.release());
      await catalog.finishRequests();

      expect((await catalog.savedStore()).rules).toContainEqual(expect.objectContaining({ id: catalog.ruleId, description: originalRule.description, text }));
      expect(await catalog.savedRuleFile()).toContain(`\n${text}\n`);
      expect(button(catalog.second, `Edit rule ${catalog.ruleId}`).disabled).toBe(false);
    });
  });

  it("uses the text description after pull removes a separate description before the queued save", async () => {
    const catalog = await twoPaneCatalog();
    await catalog.publishRuleDescription("");
    await editRule(catalog.second, catalog.ruleId, "Text saved without the removed description.");
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;
    await catalog.queue(catalog.second, `Save rule ${catalog.ruleId}`);
    await act(async () => pulling.release());
    await catalog.finishRequests();

    expect(await catalog.savedRuleFile()).toContain("description: Text saved without the removed description.\n");
    expect((await catalog.savedStore()).rules.find(rule => rule.id === catalog.ruleId)?.description).toBe("Text saved without the removed description.");
  });

  it.each(["before", "during"])("preserves a pulled description when saving rule text drafted %s pull", async timing => {
    const catalog = await twoPaneCatalog();
    const description = "Description updated on origin.";
    const text = "Keep this local rule text draft.";
    const incomingHead = await catalog.publishRuleDescription(description);
    if (timing === "before") await editRule(catalog.second, catalog.ruleId, text);

    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;
    expect(await catalog.head()).toBe(incomingHead);
    if (timing === "during") await editRule(catalog.second, catalog.ruleId, text);
    await act(async () => pulling.release());
    await catalog.finishRequests();

    const editor = catalog.second.querySelector(`[aria-label="Rule text for ${catalog.ruleId}"]`)!;
    expect(editor.textContent).toBe(text);
    expect(editor.closest(".rule-option")?.getAttribute("title")).toBe(description);
    await catalog.perform(catalog.second, `Save rule ${catalog.ruleId}`, "rules.save");

    expect(await catalog.savedRuleFile()).toContain(`description: ${description}\n`);
    expect(await catalog.savedRuleFile()).toContain(`\n${text}\n`);
    expect((await catalog.savedStore()).rules).toContainEqual(expect.objectContaining({ id: catalog.ruleId, description, text }));
    await catalog.perform(catalog.first, "Refresh rules and skills", "catalog.list");
    for (const pane of [catalog.first, catalog.second]) {
      const rule = button(pane, `Edit rule ${catalog.ruleId}`).closest(".rule-option")!;
      expect(rule.textContent).toBe(text);
      expect(rule.getAttribute("title")).toBe(description);
      expect(pane.querySelector(`[aria-label="Rule text for ${catalog.ruleId}"]`)).toBeNull();
    }
  });

  it("keeps a newer saved template after an older completed pull response arrives", async () => {
    const catalog = await twoPaneCatalog();
    const previousHead = await catalog.head();
    const incomingHead = await catalog.publishTemplate(catalog.originalName);
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;
    expect(await catalog.head()).toBe(incomingHead);
    expect(incomingHead).not.toBe(previousHead);

    await editName(catalog.second, "Saved in another pane");
    await catalog.queue(catalog.second, "Save template");
    await act(async () => pulling.release());
    await catalog.finishRequests();
    expectSavedTemplate(catalog.first, "Saved in another pane");
    expectSavedTemplate(catalog.second, "Saved in another pane");

    await catalog.perform(catalog.first, "Refresh rules and skills", "catalog.list");
    expectSavedTemplate(catalog.first, "Saved in another pane");
    expectSavedTemplate(catalog.second, "Saved in another pane");
    for (const pane of [catalog.first, catalog.second]) {
      expect(pane.textContent).toContain("Keep the incoming rule.");
    }
    await editColor(catalog.first, "yellow");
    await catalog.perform(catalog.first, "Save template", "templates.save");
    expect(await catalog.savedTemplate()).toMatchObject({ name: "Saved in another pane", color: "yellow" });
    expect((await catalog.savedStore()).rules).toContainEqual(expect.objectContaining({ id: "incoming-rule", text: "Keep the incoming rule." }));
  });

  it("keeps a newer saved template after an older catalog refresh response arrives", async () => {
    const catalog = await twoPaneCatalog();
    const refreshing = catalog.holdNextResponse("catalog.list");
    await click(catalog.first, "Refresh rules and skills");
    await refreshing.ready;

    await editName(catalog.second, "Saved after refresh started");
    await catalog.queue(catalog.second, "Save template");
    await act(async () => refreshing.release());
    await catalog.finishRequests();

    expectSavedTemplate(catalog.first, "Saved after refresh started");
    expectSavedTemplate(catalog.second, "Saved after refresh started");
  });

  it("keeps a newer template mutation after an older rule save response arrives", async () => {
    const catalog = await twoPaneCatalog();
    await editRule(catalog.first, catalog.ruleId, "Updated rule text");
    const saving = catalog.holdNextResponse("rules.save");
    await click(catalog.first, `Save rule ${catalog.ruleId}`);
    await saving.ready;

    await editName(catalog.second, "Saved after the rule");
    await catalog.queue(catalog.second, "Save template");
    await act(async () => saving.release());
    await catalog.finishRequests();

    for (const pane of [catalog.first, catalog.second]) {
      expectSavedTemplate(pane, "Saved after the rule");
      expect(pane.textContent).toContain("Updated rule text");
    }
  });

  it("keeps newer template changes after another template's older save response arrives", async () => {
    const catalog = await twoPaneCatalog();
    await click(catalog.first, "Alternate template");
    await editName(catalog.first, "Saved alternate");
    const saving = catalog.holdNextResponse("templates.save");
    await click(catalog.first, "Save template");
    await saving.ready;

    await editName(catalog.second, "Saved default");
    await catalog.queue(catalog.second, "Save template");
    await act(async () => saving.release());
    await catalog.finishRequests();

    expectSavedTemplate(catalog.first, "Saved alternate");
    expectSavedTemplate(catalog.second, "Saved default");
    for (const pane of [catalog.first, catalog.second]) {
      expect(pane.querySelector(".rules-skills-sidebar")?.textContent).toContain("Saved alternate");
      expect(pane.querySelector(".rules-skills-sidebar")?.textContent).toContain("Saved default");
    }
  });

  it("keeps a newer catalog refresh after an older rule deletion response arrives", async () => {
    const catalog = await twoPaneCatalog();
    const deleting = catalog.holdNextResponse("rules.delete");
    await click(catalog.first, `Delete rule ${catalog.ruleId}`);
    await deleting.ready;

    await catalog.renameOnDisk("Externally renamed template");
    await catalog.queue(catalog.second, "Refresh rules and skills");
    await act(async () => deleting.release());
    await catalog.finishRequests();

    for (const pane of [catalog.first, catalog.second]) {
      expectSavedTemplate(pane, "Externally renamed template");
      expect(pane.querySelector(`[aria-label="Edit rule ${catalog.ruleId}"]`)).toBeNull();
    }
  });

  it("does not restore a deleted template when an older pull response arrives", async () => {
    const catalog = await twoPaneCatalog();
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;
    await click(catalog.second, "Alternate template");
    await catalog.queue(catalog.second, "Delete template");
    await act(async () => pulling.release());
    await catalog.finishRequests();

    for (const pane of [catalog.first, catalog.second]) {
      expect(pane.querySelector(".rules-skills-sidebar")?.textContent).not.toContain("Alternate template");
    }
  });

  it("keeps the newly selected default after an older pull response arrives", async () => {
    const catalog = await twoPaneCatalog();
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;
    await click(catalog.second, "Alternate template");
    await catalog.queue(catalog.second, "Set default");
    await act(async () => pulling.release());
    await catalog.finishRequests();

    expect(button(catalog.second, "Set default").disabled).toBe(true);
    await click(catalog.first, "Alternate template");
    expect(button(catalog.first, "Set default").disabled).toBe(true);
  });

  it("retains a successful pull when the queued save fails without discarding the dirty draft", async () => {
    const catalog = await twoPaneCatalog();
    await catalog.publishTemplate("Name from origin");
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;

    await editName(catalog.second, "Unsaved local name");
    catalog.failNextRequest("templates.save", "Template save failed.");
    await catalog.queue(catalog.second, "Save template");
    await act(async () => pulling.release());
    await catalog.finishRequests();

    expect(catalog.second.textContent).toContain("Template save failed.");
    expectSavedTemplate(catalog.first, "Name from origin");
    expect(nameInput(catalog.second).value).toBe("Unsaved local name");
    expect(catalog.second.querySelector(".rules-skills-save-state")?.textContent).toBe("Unsaved");
    expect(await catalog.savedTemplate()).toMatchObject({ name: "Name from origin" });
  });

  it("keeps the saved catalog and dirty draft when an explicit catalog refresh fails", async () => {
    const catalog = await twoPaneCatalog();
    await editName(catalog.second, "Unsaved local name");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    catalog.failNextRequest("catalog.list", "Catalog refresh failed.");
    await catalog.perform(catalog.second, "Refresh rules and skills", "catalog.list");

    expectSavedTemplate(catalog.first, catalog.originalName);
    expect(nameInput(catalog.second).value).toBe("Unsaved local name");
    expect(catalog.second.querySelector(".rules-skills-save-state")?.textContent).toBe("Unsaved");
    expect(catalog.second.textContent).toContain("Catalog refresh failed.");
  });

});

describe("catalog request delivery across App panes", () => {
  it("refreshes after a delayed template save and preserves its name in later edits", async () => {
    const catalog = await twoPaneCatalog();
    await editName(catalog.first, "Saved despite delayed delivery");
    const saving = catalog.holdNextRequest("templates.save");
    await click(catalog.first, "Save template");
    await saving.ready;
    await catalog.queue(catalog.second, "Refresh rules and skills");
    expect(await catalog.savedTemplate()).toMatchObject({ name: catalog.originalName });

    await act(async () => saving.release());
    await catalog.finishRequests();
    for (const pane of [catalog.first, catalog.second]) {
      expectSavedTemplate(pane, "Saved despite delayed delivery");
    }
    await editColor(catalog.second, "yellow");
    await catalog.perform(catalog.second, "Save template", "templates.save");
    expect(await catalog.savedTemplate()).toMatchObject({ name: "Saved despite delayed delivery", color: "yellow" });
    await catalog.perform(catalog.first, "Refresh rules and skills", "catalog.list");
    expectSavedTemplate(catalog.first, "Saved despite delayed delivery");
  });

  it("refreshes after a delayed rule save and retains its text in later edits", async () => {
    const catalog = await twoPaneCatalog();
    await editRule(catalog.first, catalog.ruleId, "Saved rule after delayed delivery");
    const saving = catalog.holdNextRequest("rules.save");
    await click(catalog.first, `Save rule ${catalog.ruleId}`);
    await saving.ready;
    await catalog.queue(catalog.second, "Refresh rules and skills");

    await act(async () => saving.release());
    await catalog.finishRequests();
    for (const pane of [catalog.first, catalog.second]) {
      expect(pane.textContent).toContain("Saved rule after delayed delivery");
      expect(button(pane, `Edit rule ${catalog.ruleId}`).disabled).toBe(false);
    }
    await editName(catalog.second, "Template after rule save");
    await catalog.perform(catalog.second, "Save template", "templates.save");
    expect((await catalog.savedStore()).rules).toContainEqual(expect.objectContaining({ id: catalog.ruleId, text: "Saved rule after delayed delivery" }));
    await click(catalog.second, `Edit rule ${catalog.ruleId}`);
    expect(catalog.second.querySelector(`[aria-label="Rule text for ${catalog.ruleId}"]`)?.textContent).toBe("Saved rule after delayed delivery");
    await click(catalog.second, `Save rule ${catalog.ruleId}`);
    await catalog.finishRequests();
    expect((await catalog.savedStore()).rules).toContainEqual(expect.objectContaining({ id: catalog.ruleId, text: "Saved rule after delayed delivery" }));
  });

  it("saves after a delayed refresh without replacing the successful save", async () => {
    const catalog = await twoPaneCatalog();
    const refreshing = catalog.holdNextRequest("catalog.list");
    await click(catalog.first, "Refresh rules and skills");
    await refreshing.ready;
    await editName(catalog.second, "Saved after delayed refresh");
    await catalog.queue(catalog.second, "Save template");

    await act(async () => refreshing.release());
    await catalog.finishRequests();
    for (const pane of [catalog.first, catalog.second]) expectSavedTemplate(pane, "Saved after delayed refresh");
    await editColor(catalog.first, "yellow");
    await catalog.perform(catalog.first, "Save template", "templates.save");
    expect(await catalog.savedTemplate()).toMatchObject({ name: "Saved after delayed refresh", color: "yellow" });
  });

  it("continues queued refreshes after a delayed save fails and preserves its draft", async () => {
    const catalog = await twoPaneCatalog();
    await editName(catalog.first, "Unsaved name");
    catalog.failNextRequest("templates.save", "Template save failed.");
    const saving = catalog.holdNextRequest("templates.save");
    await click(catalog.first, "Save template");
    await saving.ready;
    await catalog.queue(catalog.second, "Refresh rules and skills");
    await act(async () => saving.release());
    await catalog.finishRequests();

    expect(catalog.first.textContent).toContain("Template save failed.");
    expect(nameInput(catalog.first).value).toBe("Unsaved name");
    expect(catalog.first.querySelector(".rules-skills-save-state")?.textContent).toBe("Unsaved");
    expectSavedTemplate(catalog.second, catalog.originalName);
    expect(button(catalog.second, "Refresh rules and skills").disabled).toBe(false);
    await catalog.perform(catalog.first, "Save template", "templates.save");
    for (const pane of [catalog.first, catalog.second]) expectSavedTemplate(pane, "Unsaved name");
    expect(await catalog.savedTemplate()).toMatchObject({ name: "Unsaved name" });
  });
});

async function twoPaneCatalog() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-pane-ordering-"));
  directories.push(directory);
  const catalog = new RulesSkillsCatalogService(path.join(directory, "data"));
  const initial = await catalog.list();
  const templateId = initial.templates[0].id;
  const ruleId = initial.rules[0].id;
  await catalog.saveTemplate({ id: "z-alternate", name: "Alternate template", color: "green", ruleIds: [], skillIds: [] });
  const checkout = catalog.catalogRoot();
  const origin = path.join(directory, "origin.git");
  await git(checkout, "init", "--initial-branch=main");
  await commit(checkout, "Seed catalog");
  await git(directory, "init", "--bare", "--initial-branch=main", origin);
  await git(checkout, "remote", "add", "origin", origin);
  await git(checkout, "push", "origin", "main");

  const plugin = new RulesSkillsPlugin(catalog);
  const hooks = new HookRegistry();
  plugin.hooks.forEach(hook => hooks.register(hook));
  const requests: { operation: string; input: Record<string, unknown>; response: Promise<Response> }[] = [];
  const heldRequests = new Map<string, { ready: () => void; released: Promise<void> }>();
  const heldResponses = new Map<string, { ready: () => void; released: Promise<void> }>();
  const pending = new Set<Promise<Response>>();
  const releases: (() => void)[] = [];
  cleanups.push(async () => {
    releases.forEach(release => release());
    while (pending.size) await Promise.all([...pending]);
  });
  const failures = new Map<string, string>();
  const tabs: WorkspaceTab[] = ["first", "second"].map(id => ({ id, pluginId: RULES_SKILLS_PLUGIN_ID, title: `Rules ${id}`, cwd: checkout, status: "idle", indicator: { color: "green", label: "Ready", updatedAt: "2026-09-09" }, createdAt: "2026-09-09", updatedAt: "2026-09-09" }));
  const workspace: WorkspaceStateResponse = {
    tabs, activeTabId: tabs[0].id, activeWindowId: "window", templates: [],
    windows: [{ id: "window", name: "Catalog", defaultCwd: checkout, createdAt: "2026-09-09", updatedAt: "2026-09-09", layout: {
      activePaneId: "first-pane",
      root: { type: "split", id: "split", direction: "row", sizes: [50, 50], children: [
        { type: "pane", pane: { id: "first-pane", tabIds: [tabs[0].id], activeTabId: tabs[0].id } },
        { type: "pane", pane: { id: "second-pane", tabIds: [tabs[1].id], activeTabId: tabs[1].id } }
      ] }
    } }]
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/hooks/")) {
      const id = url.slice("/api/hooks/".length);
      const operation = id.slice("rules-skills.".length);
      const { input } = JSON.parse(String(init?.body)) as { input: Record<string, unknown> };
      const held = heldResponses.get(operation);
      heldResponses.delete(operation);
      const failure = failures.get(operation);
      failures.delete(operation);
      const delivery = heldRequests.get(operation);
      heldRequests.delete(operation);
      const result = (async () => {
        if (delivery) {
          delivery.ready();
          await delivery.released;
        }
        if (failure) throw new Error(failure);
        return hooks.call(id, input, { caller: { kind: "ui" } });
      })();
      const response = result.then(async result => {
        held?.ready();
        if (held) await held.released;
        return reply({ result });
      }).catch(error => reply({ message: error instanceof Error ? error.message : String(error) }, 409));
      requests.push({ operation, input, response });
      pending.add(response);
      void response.finally(() => pending.delete(response));
      return response;
    }
    const responses: Record<string, unknown> = {
      "/api/plugins": { plugins: [plugin.descriptor()] },
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
  while (pending.size) await act(async () => { await Promise.all([...pending]); });
  const panels = container.querySelectorAll(".rules-skills-panel");
  expect(panels).toHaveLength(2);
  const [first, second] = [...panels];
  expect(originInput(first).value).toBe(origin);
  expect(originInput(second).value).toBe(origin);
  expect(button(second, "Push commits").disabled).toBe(false);

  async function finishRequest(operation: string) {
    const request = [...requests].reverse().find(request => request.operation === operation);
    expect(request).toBeDefined();
    await act(async () => { await request!.response; });
  }

  return {
    first, second, ruleId, originalName: initial.templates[0].name,
    async finishRequests() {
      while (pending.size) await act(async () => { await Promise.all([...pending]); });
    },
    async queue(panel: Element, label: string) {
      const previousRequests = requests.length;
      await click(panel, label);
      expect(button(panel, label).disabled).toBe(true);
      expect(requests).toHaveLength(previousRequests);
    },
    head: () => git(checkout, "rev-parse", "HEAD"),
    savedStore: () => catalog.list(),
    savedRuleFile: () => fs.readFile(path.join(checkout, "rules", `${ruleId}.md`), "utf8"),
    failNextRequest: (operation: string, message: string) => failures.set(operation, message),
    async renameOnDisk(name: string) {
      const saved = (await catalog.list()).templates.find(template => template.id === templateId)!;
      await catalog.saveTemplate({ ...saved, name });
    },
    async publishTemplate(name: string) {
      const publisher = path.join(directory, "publisher");
      await git(directory, "clone", origin, publisher);
      await fs.writeFile(path.join(publisher, "templates", `${templateId}.json`), JSON.stringify({ ...initial.templates[0], name }));
      await fs.writeFile(path.join(publisher, "rules", "incoming-rule.md"), "Keep the incoming rule.\n");
      await commit(publisher, "Update catalog on origin");
      await git(publisher, "push", "origin", "main");
      return git(publisher, "rev-parse", "HEAD");
    },
    async publishRuleDescription(description: string) {
      const publisher = path.join(directory, "publisher");
      await git(directory, "clone", origin, publisher);
      await fs.writeFile(path.join(publisher, "rules", `${ruleId}.md`), `---\nid: ${ruleId}\ndescription: ${description}\n---\n${initial.rules[0].text}\n`);
      await commit(publisher, "Update rule description on origin");
      await git(publisher, "push", "origin", "main");
      return git(publisher, "rev-parse", "HEAD");
    },
    async publishRuleDeletion() {
      const publisher = path.join(directory, "publisher");
      await git(directory, "clone", origin, publisher);
      await fs.rm(path.join(publisher, "rules", `${ruleId}.md`));
      for (const template of initial.templates) {
        await fs.writeFile(path.join(publisher, "templates", `${template.id}.json`), JSON.stringify({ ...template, ruleIds: template.ruleIds.filter(id => id !== ruleId) }));
      }
      await commit(publisher, "Delete rule on origin");
      await git(publisher, "push", "origin", "main");
    },
    savedTemplate: async () => JSON.parse(await fs.readFile(path.join(checkout, "templates", `${templateId}.json`), "utf8")),
    async perform(panel: Element, label: string, operation: string) {
      const previousRequests = requests.length;
      await click(panel, label);
      expect(requests.length).toBeGreaterThan(previousRequests);
      await finishRequest(operation);
    },
    holdNextRequest(operation: string) {
      const ready = deferred();
      const released = deferred();
      releases.push(released.resolve);
      heldRequests.set(operation, { ready: ready.resolve, released: released.promise });
      return { ready: ready.promise, release: released.resolve };
    },
    holdNextResponse(operation: string) {
      const ready = deferred();
      const released = deferred();
      releases.push(released.resolve);
      heldResponses.set(operation, { ready: ready.resolve, released: released.promise });
      return { ready: ready.promise, release: released.resolve };
    }
  };
}

function originInput(panel: Element) { return panel.querySelector<HTMLInputElement>(".rules-skills-git-origin input")!; }
function button(panel: Element, label: string) {
  const found = [...panel.querySelectorAll("button")].find(element => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(panel: Element, label: string) { await act(async () => button(panel, label).click()); }
function nameInput(panel: Element) { return panel.querySelector<HTMLInputElement>(".rules-skills-template-fields input")!; }
function expectSavedTemplate(panel: Element, name: string) {
  expect(nameInput(panel).value).toBe(name);
  expect(panel.querySelector(".rules-skills-save-state")?.textContent).toBe("Saved");
}
async function editName(panel: Element, name: string) {
  await act(async () => {
    const input = nameInput(panel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function editColor(panel: Element, color: string) {
  await act(async () => {
    const select = panel.querySelector<HTMLSelectElement>(".rules-skills-template-fields select")!;
    select.value = color;
    select.dispatchEvent(new Event("change", { bubbles: true }));
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
async function commit(checkout: string, message: string) {
  await git(checkout, "add", "--all");
  await git(checkout, "-c", "user.name=CloudX Test", "-c", "user.email=cloudx@example.test", "commit", "-m", message);
}
async function git(checkout: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", checkout, ...args], { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}
