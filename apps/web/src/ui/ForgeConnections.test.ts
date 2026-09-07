// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeConnections as ConnectionState, ForgeRepository } from "@cloudx/shared";

import { ForgeConnections } from "./ForgeConnections.js";

const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/example" };
const gitlab: ForgeRepository = { provider: "gitlab", apiUrl: "https://gitlab.com/api/v4", projectPath: "group/example" };
const roots: Root[] = [];
const state = (repo = repository): ConnectionState => ({ repository: repo, roles: [{ role: "worker", state: "disconnected" }, { role: "reviewer", state: "disconnected" }] });

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(props: Partial<Parameters<typeof ForgeConnections>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  async function render(next = props) {
    await act(async () => root.render(createElement(ForgeConnections, { repository, savedRepository: repository, ...next })));
  }
  await render();
  return { container, render, root };
}

function button(container: Element, label: string) {
  const result = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

async function click(container: Element, label: string) {
  await act(async () => button(container, label).click());
}

async function fill(container: Element, text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function popup() {
  const opened = { document: document.implementation.createHTMLDocument(), location: { href: "" }, opener: window, close: vi.fn(), closed: false };
  const open = vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);
  return { opened, open };
}

describe("Forge connections", () => {
  it("shows separate verified identities without manual GitHub credentials", async () => {
    const connected = state();
    connected.roles = [{ role: "worker", state: "connected", name: "cloudx-worker[bot]" }, { role: "reviewer", state: "failed", message: "Install the reviewer app on this repository." }];
    vi.stubGlobal("fetch", vi.fn(async () => reply(connected)));
    const { container } = await mount();
    expect(container.textContent).toContain("cloudx-worker[bot]");
    expect(container.textContent).toContain("Install the reviewer app");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(button(container, "Connect issue worker").disabled).toBe(true);
    expect(container.textContent).not.toContain("Reconnect reviewer");
    expect(container.querySelector('[aria-label="reviewer connection"] button')).toBeNull();
  });

  it("requires the displayed repository to be saved before connecting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(state())));
    const { container } = await mount({ repository: { ...repository, projectPath: "cloudx/other" } });
    expect(container.textContent).toContain("Save repository settings first");
    expect(button(container, "Connect issue worker").disabled).toBe(true);
    expect(button(container, "Connect reviewer").disabled).toBe(true);
  });

  it("opens GitHub before awaiting the request and posts manifest fields into that window", async () => {
    const { opened, open } = popup();
    let finish!: (response: Response) => void;
    const fetch = vi.fn((url: string) => url.endsWith("/github/start") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(reply(state())));
    vi.stubGlobal("fetch", fetch);
    const forms: Array<{ action: string; target: string; method: string; fields: FormData }> = [];
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { forms.push({ action: this.action, target: this.target, method: this.method, fields: new FormData(this) }); });
    const { container } = await mount();
    await click(container, "Connect issue worker");
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections/github/start", expect.objectContaining({ method: "POST", body: JSON.stringify({ repository, role: "worker" }) }));
    await act(async () => finish(reply({ method: "POST", url: "https://github.com/settings/apps/new", fields: { manifest: '{"name":"CloudX"}', state: "opaque" } })));
    expect(forms).toHaveLength(1);
    expect(forms[0].method).toBe("post");
    expect(forms[0].target).toBe("_self");
    expect(forms[0].fields.get("manifest")).toBe('{"name":"CloudX"}');
    expect(opened.opener).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("reports a blocked consent window without creating an app", async () => {
    const fetch = vi.fn(async () => reply(state()));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = await mount();
    await click(container, "Connect reviewer");
    expect(container.textContent).toContain("Allow popups");
    expect(fetch.mock.calls).toHaveLength(1);
  });

  it("continues an installation with the same role and follows its GET action", async () => {
    const pending = state();
    pending.roles[1] = { role: "reviewer", state: "installing", name: "CloudX Reviewer" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => reply(url.endsWith("/github/start") ? { method: "GET", url: "https://github.com/apps/cloudx-reviewer/installations/new" } : pending)));
    const { opened } = popup();
    const { container } = await mount();
    await click(container, "Continue reviewer installation");
    expect(opened.location.href).toBe("https://github.com/apps/cloudx-reviewer/installations/new");
    expect(container.textContent).toContain("Complete setup in the GitHub window");
  });

  it("polls server completion without treating popup closure as success", async () => {
    vi.useFakeTimers();
    let current = state();
    current.roles[0].state = "registering";
    const fetch = vi.fn(async () => reply(current));
    vi.stubGlobal("fetch", fetch);
    const { container } = await mount();
    current = state();
    current.roles[0] = { role: "worker", state: "connected", name: "Verified worker" };
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.textContent).toContain("Verified worker");
    expect(button(container, "Connect issue worker").disabled).toBe(true);
  });

  it("refreshes saved connection status when focus returns", async () => {
    let current = state();
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    const { container } = await mount();
    current = state();
    current.roles[1] = { role: "reviewer", state: "connected", name: "Reviewer connected elsewhere" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("Reviewer connected elsewhere");
  });

  it("uses one temporary GitLab token for both bots and clears the input immediately", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((url: string) => url.endsWith("/gitlab") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(reply(state(gitlab))));
    vi.stubGlobal("fetch", fetch);
    const { container } = await mount({ repository: gitlab, savedRepository: gitlab });
    expect(container.textContent).toContain("GitLab 18.11 or later and a personal access token with api scope from a project Maintainer or Owner");
    await fill(container, "one-time-setup-token");
    await click(container, "Create GitLab bot connections");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(button(container, "Create GitLab bot connections").disabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections/gitlab", expect.objectContaining({ body: JSON.stringify({ repository: gitlab, setupToken: "one-time-setup-token" }) }));
    const connected = state(gitlab);
    connected.roles = [{ role: "worker", state: "connected", name: "Worker bot" }, { role: "reviewer", state: "connected", name: "Reviewer bot" }];
    await act(async () => finish(reply(connected)));
    expect(container.textContent).toContain("Worker bot");
    expect(container.textContent).toContain("Reviewer bot");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("retains a successful GitLab role after the other role fails and leaves the setup token empty", async () => {
    const partial = state(gitlab);
    partial.roles = [{ role: "worker", state: "connected", name: "Existing worker" }, { role: "reviewer", state: "failed", message: "Reviewer creation denied." }];
    let current = state(gitlab);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/gitlab")) { current = partial; return reply({ message: "Reviewer creation denied." }, 403); }
      return reply(current);
    }));
    const { container } = await mount({ repository: gitlab, savedRepository: gitlab });
    await fill(container, "temporary-token");
    await click(container, "Create GitLab bot connections");
    expect(container.textContent).toContain("Existing worker");
    expect(container.textContent).toContain("Reviewer creation denied");
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("CloudX will not repeat an uncertain setup operation");
    expect(container.textContent).not.toContain("Create GitLab bot connections");
  });

  it("rejects malformed status responses with an actionable refresh control", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ roles: [{ role: "worker", state: "connected" }] })));
    const { container } = await mount();
    expect(container.textContent).toContain("Invalid Forge connection response");
    expect(button(container, "Refresh connections")).toBeDefined();
    expect(button(container, "Connect issue worker").disabled).toBe(true);
  });

  it("keeps request errors visible after refreshing public status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/github/start") ? reply({ message: "Registration permissions are missing." }, 403) : reply(state())));
    const { opened } = popup();
    const { container } = await mount();
    await click(container, "Connect issue worker");
    expect(container.textContent).toContain("Registration permissions are missing");
    expect(opened.close).toHaveBeenCalled();
  });

  it("does not open duplicate windows or registration requests during startup", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((url: string) => url.endsWith("/github/start") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(reply(state())));
    vi.stubGlobal("fetch", fetch);
    const { open } = popup();
    const { container } = await mount();
    await act(async () => { button(container, "Connect issue worker").click(); button(container, "Connect issue worker").click(); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/github/start"))).toHaveLength(1);
    await act(async () => finish(reply({ method: "GET", url: "https://github.com/apps/example/installations/new" })));
  });

  it("waits for a slow status response before scheduling its next poll", async () => {
    vi.useFakeTimers();
    const pending = state();
    pending.roles[0].state = "registering";
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(reply(pending)).mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(reply(state())));
  });

  it("ignores an earlier read that completes after GitLab provisioning", async () => {
    let finishRead!: (response: Response) => void;
    const connected = state(gitlab);
    connected.roles = [{ role: "worker", state: "connected", name: "New worker" }, { role: "reviewer", state: "connected", name: "New reviewer" }];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/gitlab")) return Promise.resolve(reply(connected));
      return ++reads === 1 ? Promise.resolve(reply(state(gitlab))) : new Promise<Response>(resolve => { finishRead = resolve; });
    }));
    const { container } = await mount({ repository: gitlab, savedRepository: gitlab });
    await click(container, "Refresh connections");
    await fill(container, "temporary-token");
    await click(container, "Create GitLab bot connections");
    await act(async () => finishRead(reply(state(gitlab))));
    expect(container.textContent).toContain("New worker");
    expect(container.querySelector("input")).toBeNull();
  });

  it("discards consent prepared for a repository that changed meanwhile", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/github/start") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(reply(state()))));
    const { opened } = popup();
    const { container, render } = await mount();
    await click(container, "Connect issue worker");
    await render({ repository: { ...repository, projectPath: "cloudx/other" } });
    await act(async () => finish(reply({ method: "GET", url: "https://github.com/apps/old/installations/new" })));
    expect(opened.location.href).toBe("");
    expect(opened.close).toHaveBeenCalled();
    expect(container.textContent).toContain("Save repository settings first");
  });

  it("closes an unused consent window and ignores results after unmount", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/github/start") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(reply(state()))));
    const { opened } = popup();
    const { container, root } = await mount();
    await click(container, "Connect issue worker");
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => finish(reply({ method: "GET", url: "https://github.com/apps/example/installations/new" })));
    expect(opened.close).toHaveBeenCalled();
    expect(opened.location.href).toBe("");
  });

  it("clears an unsubmitted setup token when the destination changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(state(gitlab))));
    const { container, render } = await mount({ repository: gitlab, savedRepository: gitlab });
    await fill(container, "do-not-reuse-token");
    await render({ repository: { ...gitlab, projectPath: "group/other" }, savedRepository: gitlab });
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("");
  });

  it("renews expired GitLab tokens for the existing roles and shows token dates", async () => {
    const expired = state(gitlab);
    expired.roles = [{ role: "worker", state: "expired", name: "Existing worker", expiresAt: "2026-08-01T00:00:00Z" }, { role: "reviewer", state: "connected", name: "Active reviewer", expiresAt: "2027-08-01T00:00:00Z" }];
    const renewed = structuredClone(expired);
    renewed.roles[0] = { ...renewed.roles[0], state: "connected", expiresAt: "2027-08-01T00:00:00Z" };
    const fetch = vi.fn(async (url: string) => reply(url.endsWith("/gitlab") ? renewed : expired));
    vi.stubGlobal("fetch", fetch);
    const { container } = await mount({ repository: gitlab, savedRepository: gitlab });
    expect(container.textContent).toContain("Token expired");
    expect(container.textContent).not.toContain("Complete setup before");
    expect(container.textContent).toContain("Active reviewer");
    await fill(container, "one-time-renewal-token");
    await click(container, "Renew expired GitLab tokens");
    expect(container.textContent).toContain("Existing worker");
    expect(container.textContent).toContain("Active reviewer");
    expect(container.querySelector("input")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/forge/connections/gitlab", expect.objectContaining({ body: JSON.stringify({ repository: gitlab, setupToken: "one-time-renewal-token" }) }));
  });

  it("explains an expired GitHub setup window while preserving explicit continuation", async () => {
    const pending = state();
    pending.roles[0] = { role: "worker", state: "registering", expiresAt: "2000-01-01T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn(async () => reply(pending)));
    const { container } = await mount();
    expect(container.textContent).toContain("Setup expired. Continue to reopen it.");
    expect(button(container, "Continue issue worker registration").disabled).toBe(false);
  });
});
