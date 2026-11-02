// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { emptyAgentUsageTotals, type WorkspaceWindow } from "@cloudx/shared";

import { WindowSwitcher } from "./App.js";
import { defaultLayout } from "./layout.js";

it("shows retained window usage and its details when no agent tabs remain", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const window: WorkspaceWindow = { id: "window", name: "Finished work", defaultCwd: "/work", layout: defaultLayout(), createdAt: "", updatedAt: "" };
  const total = { totals: { ...emptyAgentUsageTotals(), input: 100, requests: 2 }, byModel: [], costUsd: 3, costBasis: "mixed", unpricedModels: [] };
  const callHook = vi.fn(async () => ({ usage: { tabs: {}, windows: { window: total }, forgeWorkers: {}, total } }));
  const complete = async () => undefined;
  try {
    await act(async () => root.render(createElement(WindowSwitcher, {
      windows: [window], tabs: [], activeWindow: window, open: true,
      onOpenChange: vi.fn(), onSelect: complete, onCreate: complete, onUpdate: complete, onDelete: complete,
      onContextSearch: async () => ({ matches: [] }), callHook: callHook as never
    })));
    expect(callHook).toHaveBeenCalledWith("agent-usage.read", { windowIds: ["window"] });
    expect(container.textContent).toContain("0 tabs · $3.00 API and API-equivalent · 100 tokens");
    await act(async () => container.querySelector<HTMLButtonElement>(".window-row-main")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Model requests2");
    expect(callHook).toHaveBeenLastCalledWith("agent-usage.read", { windowIds: ["window"] });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
