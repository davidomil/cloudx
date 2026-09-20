// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabRecovery, WorkspaceTab } from "@cloudx/shared";

import { WorkspaceRecoveryPanel } from "./WorkspaceRecoveryPanel.js";

const tab: WorkspaceTab = {
  id: "saved-shell", pluginId: "standard-terminal", title: "Saved shell", cwd: "/work/project", status: "failed",
  indicator: { color: "red", label: "Failed", updatedAt: "2026-09-15T00:00:00Z" },
  createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z"
};
let root: Root;
let container: HTMLDivElement;
const recover = vi.fn();
const retire = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  recover.mockReset().mockResolvedValue(undefined);
  retire.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("workspace recovery choices", () => {
  it("opens a replacement only after the user sees that the previous shell ended", async () => {
    await show({ state: "missing", message: "The previous shell process ended." });
    expect(container.textContent).toContain("The previous shell process ended.");
    expect(container.textContent).toContain("/work/project");
    expect(recover).not.toHaveBeenCalled();
    await click("Open new shell");
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "new-shell" });
  });

  it("only checks the connection when the broker is unreachable", async () => {
    await show({ state: "unavailable", message: "The broker is unavailable." });
    expect(buttons()).toEqual(["Check connection"]);
    await click("Check connection");
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "reconnect" });
  });

  it("offers the recorded exact conversation and explicit selection", async () => {
    await show({ state: "missing", message: "The previous process ended.", conversationId: "recorded-session", canResume: true }, "codex-terminal");
    expect(container.textContent).toContain("recorded-session");
    expect(buttons()).toEqual(["Resume conversation", "Resume selected conversation"]);
    await click("Resume conversation");
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "resume-conversation" });
  });

  it.each(["The exact conversation ID was not recorded.", "The saved conversation transcript is unavailable."])("explains '%s' and requires explicit selection", async message => {
    await show({ state: "missing", message, canResume: false }, "codex-terminal");
    expect(container.textContent).toContain(message);
    expect(buttons()).toEqual(["Resume selected conversation"]);
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, " chosen-session ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Resume selected conversation");
    expect(recover).toHaveBeenCalledExactlyOnceWith({ action: "resume-conversation", sessionId: "chosen-session" });
    expect(container.textContent).not.toContain("Resume last");
  });

  it("suppresses repeated recovery while pending and displays failures in the same panel", async () => {
    let rejectRecovery!: (error: Error) => void;
    recover.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectRecovery = reject; }));
    await show({ state: "missing", message: "The previous shell process ended." });
    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Recovering panel…");
    await act(async () => rejectRecovery(new Error("Saved directory no longer exists.")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Saved directory no longer exists.");
    expect(button.disabled).toBe(false);
  });

  it("explicitly retires the obsolete settings panel without launching a terminal", async () => {
    await show({ state: "retired", message: "Settings moved to Settings → Codex." }, "codex-settings");
    expect(container.textContent).toContain("Your Codex preferences stay unchanged.");
    await click("Open Settings → Codex and remove tab");
    expect(retire).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });
});

async function show(recovery: TabRecovery, pluginId = tab.pluginId) {
  await act(async () => root.render(createElement(WorkspaceRecoveryPanel, {
    tab: { ...tab, pluginId }, recovery, onRecover: recover, onRetire: retire
  })));
}

function buttons() {
  return Array.from(container.querySelectorAll("button"), button => button.textContent);
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
