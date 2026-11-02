// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccountsState, ClaudeLaunchMode, PluginDescriptor } from "@cloudx/shared";

import { CreateTabDialog } from "./App.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const plugin: PluginDescriptor = {
  id: "codex-terminal", acronym: "AGT", displayName: "Agent", description: "Agent", panelKind: "terminal",
  creatable: true, requiresDirectory: true, actions: [], configFields: []
};

async function fixture(savedMode: ClaudeLaunchMode | null, failRead = false, providerId: "claude" | "codex" | "both" = "claude") {
  const state: AgentAccountsState = {
    providers: (providerId === "both" ? ["codex", "claude"] as const : [providerId]).map(providerId => ({ providerId, installed: true, label: providerId })),
    accounts: (providerId === "both" ? ["codex", "claude"] as const : [providerId]).map(providerId => ({ id: "selected", providerId, label: "Selected", kind: "subscription", isDefault: true, createdAt: "2026-11-02" }))
  };
  const onCreate = vi.fn(async () => undefined);
  const callHook = vi.fn(async (id: string) => {
    if (id === "agent-accounts.read") return { state };
    if (id === "claude-settings.read") {
      if (failRead) throw new Error("unavailable");
      return { settings: { launchMode: savedMode } };
    }
    throw new Error(`Unexpected hook ${id}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(CreateTabDialog, { plugins: [plugin], callHook: callHook as never, templates: [], defaultCwd: "/workspace", onCancel: vi.fn(), onCreate })));
  return { container, callHook, onCreate };
}

async function select(container: Element, label: string, value: string) {
  const input = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function create(container: Element) {
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Create")!.click());
}

describe("Claude interactive launch mode", () => {
  it("inherits a saved managed mode without pretending it is an explicit launch choice", async () => {
    const { container, onCreate, callHook } = await fixture("cloudx-managed");
    const control = container.querySelector<HTMLSelectElement>('[aria-label="Claude launch mode"]')!;
    expect(control.value).toBe("");
    expect(control.options[0]!.textContent).toBe("Inherit saved · CloudX-managed");
    expect(container.textContent).toContain("Shared project settings, project CLAUDE.md and project rules are omitted");
    expect(container.textContent).toContain("CLAUDE.local.md");
    const disclosure = container.querySelector(`#${control.getAttribute("aria-describedby")}`)!;
    expect(disclosure.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await create(container);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ initialInput: { agent: { providerId: "claude", accountId: "selected" } } }));
    expect(callHook.mock.calls.map(([id]) => id)).toEqual(["agent-accounts.read", "claude-settings.read"]);
  });

  it("passes an explicit opt-in alongside the selected account and resume request", async () => {
    const { container, onCreate } = await fixture(null);
    expect(container.textContent).toContain("Inherit · Native project (fresh CloudX default)");
    await select(container, "Claude launch mode", "cloudx-managed");
    const sessions = container.querySelector<HTMLSelectElement>('[aria-label="Session"]')!;
    expect([...sessions.options].map(option => option.value)).toEqual(["new", "session"]);
    expect(container.textContent).toContain("Resume picker and Resume last cannot verify the conversation policy before launch");
    await select(container, "Session", "session");
    const sessionId = container.querySelector<HTMLInputElement>('input[placeholder="UUID"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(sessionId, "b16b3294-9703-4c3c-a35c-de2c86d7e717");
      sessionId.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Resume preserves the original recorded launch policy");
    await create(container);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ initialInput: {
      agent: { providerId: "claude", accountId: "selected" }, claudeLaunchMode: "cloudx-managed",
      resume: { mode: "session", sessionId: "b16b3294-9703-4c3c-a35c-de2c86d7e717" }
    } }));
  });

  it("drops an ambiguous Codex resume choice when switching the dialog to Claude", async () => {
    const { container, onCreate } = await fixture(null, false, "both");
    const plugin = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      plugin.value = "codex-terminal#codex";
      plugin.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await select(container, "Session", "last");
    await act(async () => {
      plugin.value = "codex-terminal#claude";
      plugin.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Session"]')!.value).toBe("new");
    await create(container);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ initialInput: { agent: { providerId: "claude", accountId: "selected" } } }));
  });

  it("leaves inheritance to the server after a read failure and supports an explicit native choice", async () => {
    const { container, onCreate } = await fixture("cloudx-managed", true);
    expect(container.textContent).toContain("saved mode could not be read");
    await select(container, "Claude launch mode", "native-project");
    await create(container);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ initialInput: { agent: { providerId: "claude", accountId: "selected" }, claudeLaunchMode: "native-project" } }));
  });

  it("keeps Claude mode controls and settings reads out of Codex launches", async () => {
    const { container, onCreate, callHook } = await fixture("cloudx-managed", false, "codex");
    expect(container.querySelector('[aria-label="Claude launch mode"]')).toBeNull();
    await create(container);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ initialInput: { agent: { providerId: "codex", accountId: "selected" } } }));
    expect(callHook.mock.calls.map(([id]) => id)).toEqual(["agent-accounts.read"]);
  });
});
