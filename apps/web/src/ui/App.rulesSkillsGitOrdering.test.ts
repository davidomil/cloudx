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
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("catalog response ordering across App panes", () => {
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
    await catalog.perform(catalog.second, "Save template", "templates.save");
    expectSavedTemplate(catalog.first, "Saved in another pane");
    expectSavedTemplate(catalog.second, "Saved in another pane");

    await act(async () => pulling.release());
    await catalog.finishRequest("git.pull");
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
    await catalog.perform(catalog.second, "Save template", "templates.save");
    await act(async () => refreshing.release());
    await catalog.finishRequest("catalog.list");

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
    await catalog.perform(catalog.second, "Save template", "templates.save");
    await act(async () => saving.release());
    await catalog.finishRequest("rules.save");

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
    await catalog.perform(catalog.second, "Save template", "templates.save");
    await act(async () => saving.release());
    await catalog.finishRequest("templates.save");

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
    await catalog.perform(catalog.second, "Refresh rules and skills", "catalog.list");
    await act(async () => deleting.release());
    await catalog.finishRequest("rules.delete");

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
    await catalog.perform(catalog.second, "Delete template", "templates.delete");
    await act(async () => pulling.release());
    await catalog.finishRequest("git.pull");

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
    await catalog.perform(catalog.second, "Set default", "templates.setDefault");
    await act(async () => pulling.release());
    await catalog.finishRequest("git.pull");

    expect(button(catalog.second, "Set default").disabled).toBe(true);
    await click(catalog.first, "Alternate template");
    expect(button(catalog.first, "Set default").disabled).toBe(true);
  });

  it("applies an earlier successful pull after a newer save fails without discarding the dirty draft", async () => {
    const catalog = await twoPaneCatalog();
    await catalog.publishTemplate("Name from origin");
    const pulling = catalog.holdNextResponse("git.pull");
    await click(catalog.first, "Pull");
    await pulling.ready;

    await editName(catalog.second, "Unsaved local name");
    catalog.failNextRequest("templates.save", "Template save failed.");
    await catalog.perform(catalog.second, "Save template", "templates.save");
    expect(catalog.second.textContent).toContain("Template save failed.");
    await act(async () => pulling.release());
    await catalog.finishRequest("git.pull");

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
  const heldResponses = new Map<string, { ready: () => void; released: Promise<void> }>();
  const pending = new Set<Promise<Response>>();
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
      const result = failure ? Promise.reject(new Error(failure)) : hooks.call(id, input, { caller: { kind: "ui" } });
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
    first, second, ruleId, originalName: initial.templates[0].name, finishRequest,
    head: () => git(checkout, "rev-parse", "HEAD"),
    savedStore: () => catalog.list(),
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
    savedTemplate: async () => JSON.parse(await fs.readFile(path.join(checkout, "templates", `${templateId}.json`), "utf8")),
    async perform(panel: Element, label: string, operation: string) {
      const previousRequests = requests.length;
      await click(panel, label);
      expect(requests.length).toBeGreaterThan(previousRequests);
      await finishRequest(operation);
    },
    holdNextResponse(operation: string) {
      const ready = deferred();
      const released = deferred();
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
