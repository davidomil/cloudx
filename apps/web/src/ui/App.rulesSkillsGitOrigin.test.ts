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
  await act(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
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
    await catalog.queue(catalog.second, "Push commits");
    await catalog.expectNeitherRemoteUpdated();

    await act(async () => saving.release());
    await catalog.finishRequests();
    expect(catalog.pushDestinations()).toEqual([catalog.origin]);
    expect(catalog.second.querySelector('[role="alert"]')?.textContent).toContain("Origin changed since it was displayed.");
    await catalog.expectNeitherRemoteUpdated();
    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Refresh Git status", "status");
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
    await catalog.expectPublishedOnlyToReplacement();
  });

  it.each(["request", "response"] as const)("keeps an origin save after a delayed Git status %s", async delay => {
    const catalog = await twoPaneCatalog();
    const refreshing = catalog.holdNext("status", delay);
    await click(catalog.second, "Refresh Git status");
    await refreshing.ready;
    await editOrigin(catalog.first, catalog.replacement);
    await catalog.queue(catalog.first, "Save origin");
    await act(async () => refreshing.release());
    await catalog.finishRequests();

    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
    expect(catalog.pushDestinations()).toEqual([catalog.replacement]);
    await catalog.expectPublishedOnlyToReplacement();
  });

  it.each(["request", "response"] as const)("rejects a queued pull from the old displayed origin after a delayed origin save %s", async delay => {
    const catalog = await twoPaneCatalog();
    const incomingHead = await catalog.publishReplacementRule();
    const head = await git(catalog.checkout, "rev-parse", "HEAD");
    const oldRemoteHead = await git(catalog.origin, "rev-parse", "refs/heads/main");
    const store = await catalog.readStore();
    const saving = catalog.holdNext("setOrigin", delay);
    await editOrigin(catalog.first, catalog.replacement);
    await click(catalog.first, "Save origin");
    await saving.ready;

    expect(originInput(catalog.second).value).toBe(catalog.origin);
    expect(button(catalog.second, "Pull").disabled).toBe(false);
    await catalog.queue(catalog.second, "Pull");
    await act(async () => saving.release());
    await catalog.finishRequests();

    expect(await git(catalog.checkout, "rev-parse", "HEAD")).toBe(head);
    expect(catalog.second.querySelector('[role="alert"]')?.textContent).toContain("Origin changed since it was displayed.");
    expect(catalog.pullDestinations()).toEqual([catalog.origin]);
    expect(await git(catalog.checkout, "status", "--porcelain=v1")).toBe("");
    await expect(fs.stat(path.join(catalog.checkout, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await catalog.readStore()).toEqual(store);
    for (const pane of [catalog.first, catalog.second]) {
      expect(originInput(pane).value).toBe(catalog.replacement);
      expect(pane.textContent).not.toContain("Rule from the replacement remote.");
      expect(button(pane, "Pull").disabled).toBe(false);
    }

    await catalog.perform(catalog.second, "Pull", "pull");

    expect(catalog.pullDestinations()).toEqual([catalog.origin, catalog.replacement]);
    expect(catalog.second.querySelector('[role="alert"]')).toBeNull();
    expect(catalog.second.textContent).toContain("Pulled from origin.");
    expect(await git(catalog.checkout, "rev-parse", "HEAD")).toBe(incomingHead);
    expect(await git(catalog.checkout, "status", "--porcelain=v1")).toBe("");
    for (const pane of [catalog.first, catalog.second]) expect(pane.textContent).toContain("Rule from the replacement remote.");
    expect(await git(catalog.origin, "rev-parse", "refs/heads/main")).toBe(oldRemoteHead);
    expect(await git(catalog.replacement, "rev-parse", "refs/heads/main")).toBe(incomingHead);
  });

  it.each(["request", "response"] as const)("refreshes both panes after a delayed origin save %s and syncs only the displayed replacement", async delay => {
    const catalog = await twoPaneCatalog();
    const incomingHead = await catalog.publishReplacementRule();
    const saving = catalog.holdNext("setOrigin", delay);
    await editOrigin(catalog.first, catalog.replacement);
    await click(catalog.first, "Save origin");
    await saving.ready;

    await click(catalog.second, "Refresh Git status");
    await catalog.finishOtherRequests("setOrigin");
    await act(async () => saving.release());
    await catalog.finishRequests();

    for (const pane of [catalog.first, catalog.second]) {
      expect(originInput(pane).value).toBe(catalog.replacement);
      expect(button(pane, "Pull").disabled).toBe(false);
      expect(button(pane, "Push commits").disabled).toBe(false);
    }
    expect(catalog.first.textContent).toContain("Origin saved.");
    expect(catalog.second.textContent).toContain("Git status refreshed.");
    expect(await git(catalog.checkout, "remote", "get-url", "origin")).toBe(catalog.replacement);

    await catalog.perform(catalog.second, "Pull", "pull");
    expect(await git(catalog.checkout, "rev-parse", "HEAD")).toBe(incomingHead);
    for (const pane of [catalog.first, catalog.second]) {
      expect(originInput(pane).value).toBe(catalog.replacement);
      expect(pane.textContent).toContain("Rule from the replacement remote.");
    }
    await fs.writeFile(path.join(catalog.checkout, "rules", "outgoing.md"), "New commit for the replacement.\n");
    await commit(catalog.checkout, "Add outgoing rule after pull");
    await catalog.perform(catalog.second, "Push commits", "push");
    expect(catalog.pushDestinations()).toEqual([catalog.replacement]);
    expect(catalog.second.textContent).toContain("Commits pushed to origin.");
    await catalog.expectPublishedOnlyToReplacement();
  });

  it("keeps a saved origin after an older pull response and refreshes the catalog", async () => {
    const catalog = await twoPaneCatalog();
    const pulling = catalog.holdNextResponse("pull");
    await click(catalog.second, "Pull");
    await pulling.ready;
    await editOrigin(catalog.first, catalog.replacement);
    await catalog.queue(catalog.first, "Save origin");
    await act(async () => pulling.release());
    await catalog.finishRequests();

    for (const pane of [catalog.first, catalog.second]) {
      expect(originInput(pane).value).toBe(catalog.replacement);
      expect(pane.textContent).toContain("Publish only to the displayed destination.");
    }
    await catalog.perform(catalog.second, "Push commits", "push");
    await catalog.expectPublishedOnlyToReplacement();
  });

  it("refreshes after a delayed origin save fails and allows the draft to be saved again", async () => {
    const catalog = await twoPaneCatalog();
    catalog.failNextRequest("setOrigin", "Origin save failed.");
    const saving = catalog.holdNext("setOrigin", "request");
    await editOrigin(catalog.first, catalog.replacement);
    await click(catalog.first, "Save origin");
    await saving.ready;
    await catalog.queue(catalog.second, "Refresh Git status");
    await act(async () => saving.release());
    await catalog.finishRequests();

    expect(catalog.first.querySelector('[role="alert"]')?.textContent).toContain("Origin save failed.");
    expect(originInput(catalog.first).value).toBe(catalog.replacement);
    expect(originInput(catalog.second).value).toBe(catalog.origin);
    expect(button(catalog.first, "Save origin").disabled).toBe(false);
    await catalog.expectNeitherRemoteUpdated();
    await catalog.perform(catalog.first, "Save origin", "setOrigin");
    for (const pane of [catalog.first, catalog.second]) expect(originInput(pane).value).toBe(catalog.replacement);
    await catalog.perform(catalog.second, "Push commits", "push");
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

  const plugin = new RulesSkillsPlugin(catalog);
  const hooks = new HookRegistry();
  plugin.hooks.forEach(hook => hooks.register(hook));
  const requests: { operation: string; input: Record<string, unknown>; response: Promise<Response> }[] = [];
  const heldResponses = new Map<string, { ready: () => void; released: Promise<void> }>();
  const heldRequests = new Map<string, { ready: () => void; released: Promise<void> }>();
  const failures = new Map<string, string>();
  const pending = new Set<Promise<Response>>();
  const releases: (() => void)[] = [];
  cleanups.push(async () => {
    releases.forEach(release => release());
    while (pending.size) await Promise.all([...pending]);
  });
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
      const delivery = heldRequests.get(operation);
      heldRequests.delete(operation);
      const failure = failures.get(operation);
      failures.delete(operation);
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

  function holdNext(operation: string, delay: "request" | "response") {
    const ready = deferred();
    const released = deferred();
    releases.push(released.resolve);
    const held = delay === "request" ? heldRequests : heldResponses;
    held.set(operation, { ready: ready.resolve, released: released.promise });
    return { ready: ready.promise, release: released.resolve };
  }

  return {
    first, second, checkout, origin, replacement,
    readStore: () => catalog.list(),
    async finishOtherRequests(operation: string) {
      await act(async () => { await Promise.all(requests.filter(request => request.operation !== operation).map(request => request.response)); });
    },
    async finishRequests() {
      while (pending.size) await act(async () => { await Promise.all([...pending]); });
    },
    async queue(panel: Element, label: string) {
      const previousRequests = requests.length;
      await click(panel, label);
      expect(button(panel, label).disabled).toBe(true);
      expect(requests).toHaveLength(previousRequests);
    },
    failNextRequest: (operation: string, message: string) => failures.set(operation, message),
    async publishReplacementRule() {
      await git(checkout, "push", replacement, "main");
      const publisher = path.join(directory, "publisher");
      await git(directory, "clone", replacement, publisher);
      await fs.writeFile(path.join(publisher, "rules", "incoming.md"), "Rule from the replacement remote.\n");
      await commit(publisher, "Add replacement rule");
      await git(publisher, "push", "origin", "main");
      return git(publisher, "rev-parse", "HEAD");
    },
    pullDestinations: () => requests.filter(request => request.operation === "pull").map(request => request.input.expectedOriginUrl),
    pushDestinations: () => requests.filter(request => request.operation === "push").map(request => request.input.expectedOriginUrl),
    async perform(panel: Element, label: string, operation: string) {
      const previousRequests = requests.length;
      await click(panel, label);
      expect(requests.length).toBeGreaterThan(previousRequests);
      await finishRequest(operation);
    },
    holdNextResponse: (operation: string) => holdNext(operation, "response"),
    holdNext,
    async expectNeitherRemoteUpdated() {
      expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(oldHead);
      expect(await git(replacement, "for-each-ref", "--format=%(refname)")).toBe("");
    },
    async expectPublishedOnlyToReplacement() {
      expect(await git(replacement, "rev-parse", "refs/heads/main")).toBe(await git(checkout, "rev-parse", "HEAD"));
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
