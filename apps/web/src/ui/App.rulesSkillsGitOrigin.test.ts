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
  saveRule(rule: Record<string, unknown>): Promise<RulesSkillsStore>;
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

describe("catalog Git destination across App panes", () => {
  it("shows another pane's saved origin and pushes only to that displayed replacement", async () => {
    const catalog = await twoPaneCatalog();

    await editOrigin(catalog.first, catalog.replacement);
    await catalog.perform(catalog.first, "Save origin", "setOrigin");

    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    expect(button(catalog.second, "Push commits").disabled).toBe(false);
    await catalog.perform(catalog.second, "Push commits", "push");

    expect(catalog.pushDestinations()).toEqual([catalog.replacement]);
    expect(catalog.second.textContent).toContain("Commits pushed to origin.");
    await catalog.expectPublishedOnlyToReplacement();
  });

  it("keeps an edited origin draft visible and disables its push after another pane saves origin", async () => {
    const catalog = await twoPaneCatalog();
    const draft = `${catalog.origin}-edited`;
    await editOrigin(catalog.second, draft);
    await editOrigin(catalog.first, catalog.replacement);

    await catalog.perform(catalog.first, "Save origin", "setOrigin");

    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(draft);
    expect(button(catalog.second, "Push commits").disabled).toBe(true);
    expect(catalog.second.textContent).toContain("Save the origin change before syncing.");
    await click(catalog.second, "Push commits");
    expect(catalog.pushDestinations()).toEqual([]);
    await catalog.expectNeitherRemoteUpdated();
  });

  it("rejects a push after an external origin change until the pane refreshes its displayed destination", async () => {
    const catalog = await twoPaneCatalog();
    await git(catalog.checkout, "remote", "set-url", "origin", catalog.replacement);

    expect(originInput(catalog.second).value).toBe(catalog.origin);
    await catalog.perform(catalog.second, "Push commits", "push");

    expect(catalog.pushDestinations()).toEqual([catalog.origin]);
    expect(catalog.second.querySelector('[role="alert"]')?.textContent).toContain("Origin changed since it was displayed.");
    await catalog.expectNeitherRemoteUpdated();

    await catalog.perform(catalog.second, "Refresh Git status", "status");
    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
    expect(catalog.pushDestinations()).toEqual([catalog.origin, catalog.replacement]);
    await catalog.expectPublishedOnlyToReplacement();
  });

  it("rejects the old displayed destination while another pane's origin save response is pending", async () => {
    const catalog = await twoPaneCatalog();
    const saving = catalog.holdNextResponse("setOrigin");
    await editOrigin(catalog.first, catalog.replacement);
    await click(catalog.first, "Save origin");
    await saving.ready;

    expect(originInput(catalog.second).value).toBe(catalog.origin);
    expect(button(catalog.second, "Push commits").disabled).toBe(false);
    await catalog.perform(catalog.second, "Push commits", "push");

    expect(catalog.pushDestinations()).toEqual([catalog.origin]);
    expect(catalog.second.querySelector('[role="alert"]')?.textContent).toContain("Origin changed since it was displayed.");
    await catalog.expectNeitherRemoteUpdated();

    await act(async () => saving.release());
    await catalog.finishRequest("setOrigin");
    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Refresh Git status", "status");
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
    await catalog.expectPublishedOnlyToReplacement();
  });

  it("does not let a late Git status response overwrite another pane's newer origin save", async () => {
    const catalog = await twoPaneCatalog();
    const refreshing = catalog.holdNextResponse("status");
    await click(catalog.second, "Refresh Git status");
    await refreshing.ready;
    await editOrigin(catalog.first, catalog.replacement);
    await catalog.perform(catalog.first, "Save origin", "setOrigin");

    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await act(async () => refreshing.release());
    await catalog.finishRequest("status");

    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
    expect(catalog.pushDestinations()).toEqual([catalog.replacement]);
    await catalog.expectPublishedOnlyToReplacement();
  });
});

async function twoPaneCatalog() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-pane-origin-"));
  directories.push(directory);
  const catalog = new RulesSkillsCatalogService(path.join(directory, "data"));
  await catalog.list();
  const checkout = catalog.catalogRoot();
  const origin = path.join(directory, "old origin.git");
  const replacement = path.join(directory, "replacement origin.git");
  await git(checkout, "init", "--initial-branch=main");
  await commit(checkout, "Seed catalog");
  await git(directory, "init", "--bare", "--initial-branch=main", origin);
  await git(directory, "init", "--bare", "--initial-branch=main", replacement);
  await git(checkout, "remote", "add", "origin", origin);
  await git(checkout, "push", "origin", "main");
  const oldHead = await git(origin, "rev-parse", "refs/heads/main");
  await catalog.saveRule({ id: "local-rule", text: "Publish only to the displayed destination." });
  await commit(checkout, "Add local rule");
  const localHead = await git(checkout, "rev-parse", "HEAD");

  const plugin = new RulesSkillsPlugin(catalog);
  const hooks = new HookRegistry();
  plugin.hooks.forEach(hook => hooks.register(hook));
  const requests: { operation: string; input: Record<string, unknown>; response: Promise<Response> }[] = [];
  const heldResponses = new Map<string, { ready: () => void; released: Promise<void> }>();
  const pending = new Set<Promise<Response>>();
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
      const operation = id.slice("rules-skills.git.".length);
      const { input } = JSON.parse(String(init?.body)) as { input: Record<string, unknown> };
      const held = heldResponses.get(operation);
      heldResponses.delete(operation);
      const response = hooks.call(id, input, { caller: { kind: "ui" } }).then(async result => {
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
    first, second, checkout, origin, replacement, finishRequest,
    pushDestinations: () => requests.filter(request => request.operation === "push").map(request => request.input.expectedOriginUrl),
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
    },
    async expectNeitherRemoteUpdated() {
      expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);
      expect(await git(replacement, "for-each-ref", "--format=%(refname)")).toBe("");
    },
    async expectPublishedOnlyToReplacement() {
      expect(await git(replacement, "rev-parse", "refs/heads/main")).toBe(localHead);
      expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);
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
async function editOrigin(panel: Element, origin: string) {
  await act(async () => {
    const input = originInput(panel);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, origin);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
