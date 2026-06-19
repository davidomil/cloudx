// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceStateResponse } from "@cloudx/shared";

import { WindowSwitcher } from "./App.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WindowSwitcher", () => {
  it("uses the same create-directory checkbox treatment as the new tab dialog", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onCreate = vi.fn(async () => undefined);
    const activeWindow = workspaceWindow();

    try {
      await act(async () => {
        root.render(createElement(WindowSwitcher, {
          windows: [activeWindow],
          tabs: [],
          activeWindow,
          open: true,
          onOpenChange: vi.fn(),
          onSelect: vi.fn(async () => undefined),
          onCreate,
          onUpdate: vi.fn(async () => undefined),
          onDelete: vi.fn(async () => undefined),
          onContextSearch: vi.fn(async () => ({ matches: [] }))
        }));
      });

      await act(async () => {
        createWindowButtons(container)[0]?.click();
      });

      const checkbox = container.querySelector<HTMLInputElement>("label.checkbox-row input[type='checkbox']");
      expect(checkbox).not.toBeNull();
      expect(checkbox?.closest("label")?.textContent?.trim()).toBe("Create directory if needed");
      expect(container.querySelector("label.settings-toggle")).toBeNull();

      await act(async () => {
        checkbox?.click();
      });
      await act(async () => {
        setInputValue(requiredInput(container, "Window name"), "New window");
      });
      await act(async () => {
        createWindowButtons(container).at(-1)?.click();
      });

      expect(onCreate).toHaveBeenCalledWith("New window", "~", undefined, true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function workspaceWindow(): WorkspaceStateResponse["windows"][number] {
  return {
    id: "window-1",
    name: "Main",
    defaultCwd: "~",
    layout: {
      root: { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
      activePaneId: "pane-1"
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function createWindowButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[aria-label='Create window']")];
}

function requiredInput(container: HTMLElement, placeholder: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder='${placeholder}']`);
  if (!input) {
    throw new Error(`${placeholder} input was not rendered.`);
  }
  return input;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
