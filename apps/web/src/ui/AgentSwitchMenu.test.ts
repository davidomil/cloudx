// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccountsState, WorkspaceTab } from "@cloudx/shared";

import { AgentSwitchMenu } from "./AgentSwitchMenu.js";
import { AgentAccountsPanel } from "./AgentAccountsPanel.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const tab: WorkspaceTab = {
  id: "tab-1", pluginId: "codex-terminal", title: "Agent", cwd: "/work", status: "running",
  indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
};

const state: AgentAccountsState = {
  providers: [
    { providerId: "codex", label: "Codex", installed: true, version: "codex-cli 0.1" },
    { providerId: "claude", label: "Claude", installed: false, command: "claude" }
  ],
  accounts: [
    { id: "codex-home", providerId: "codex", label: "Home", kind: "subscription", isDefault: true, createdAt: "2026-10-05T00:00:00.000Z", loggedIn: true, authMethod: "Logged in using ChatGPT" },
    { id: "claude-work", providerId: "claude", label: "Work", kind: "api-key", isDefault: true, createdAt: "2026-10-05T00:00:00.000Z" }
  ]
};

async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

describe("AgentSwitchMenu", () => {
  it("lists accounts of installed providers and switches through the server", async () => {
    const switched = { ...tab, status: "starting" as const };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(switched), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSwitched = vi.fn();
    const onClose = vi.fn();
    const container = await render(createElement(AgentSwitchMenu, {
      tab, x: 10, y: 10, callHook: vi.fn(async () => ({ state })) as never, onSwitched, onOpenAccounts: vi.fn(), onClose
    }));

    const items = [...container.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
    expect(items).toEqual(["Codex · Home (default)", "Manage accounts…"]);
    expect(container.textContent).toContain("Switch after the current turn finishes");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());

    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1/switch-agent", expect.objectContaining({ method: "POST", body: JSON.stringify({ providerId: "codex", accountId: "codex-home" }) }));
    expect(onSwitched).toHaveBeenCalledWith(switched);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's reason when a switch is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "The current run is still active." }), { status: 409, headers: { "content-type": "application/json" } })));
    const onClose = vi.fn();
    const container = await render(createElement(AgentSwitchMenu, {
      tab, x: 10, y: 10, callHook: vi.fn(async () => ({ state })) as never, onSwitched: vi.fn(), onOpenAccounts: vi.fn(), onClose
    }));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("still active");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("AgentAccountsPanel", () => {
  it("shows provider status and opens a login tab after adding a subscription account", async () => {
    const callHook = vi.fn(async (hookId: string) => {
      if (hookId === "agent-accounts.read") return { state };
      if (hookId === "agent-accounts.create") return { account: { ...state.accounts[1], id: "claude-new", kind: "subscription" } };
      if (hookId === "agent-accounts.login") return { tab: { pluginId: "agent-accounts", title: "Login: Team", initialInput: { accountId: "claude-new" } } };
      return {};
    });
    const onOpenLogin = vi.fn();
    const container = await render(createElement(AgentAccountsPanel, { callHook: callHook as never, onOpenLogin }));

    expect(container.textContent).toContain("not installed (claude)");
    expect(container.textContent).toContain("Signed in (Logged in using ChatGPT)");
    const label = container.querySelector<HTMLInputElement>('input[placeholder^="Work"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(label, "Team");
      label.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());

    expect(callHook).toHaveBeenCalledWith("agent-accounts.create", { providerId: "claude", label: "Team", kind: "subscription" });
    expect(onOpenLogin).toHaveBeenCalledWith({ pluginId: "agent-accounts", title: "Login: Team", initialInput: { accountId: "claude-new" } });
  });

  it("asks for confirmation before removing an account", async () => {
    const callHook = vi.fn(async () => ({ state }));
    const container = await render(createElement(AgentAccountsPanel, { callHook: callHook as never }));
    const remove = () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Remove"))!;
    await act(async () => remove().click());
    expect(callHook).not.toHaveBeenCalledWith("agent-accounts.delete", expect.anything());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Confirm remove"))!.click());
    expect(callHook).toHaveBeenCalledWith("agent-accounts.delete", { accountId: "codex-home" });
  });
});
