// @vitest-environment jsdom

import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { PluginPanelDock, pluginPanelDockOffset } from "./PluginPanelDock.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

describe("PluginPanelDock", () => {
  it("derives stacked control offsets from the dock button size variable", () => {
    expect(pluginPanelDockOffset(0)).toBe("0px");
    expect(pluginPanelDockOffset(1)).toBe("calc(var(--plugin-panel-dock-button-size))");
    expect(pluginPanelDockOffset(2)).toBe("calc(var(--plugin-panel-dock-button-size) + var(--plugin-panel-dock-button-size))");
  });

  it("opens a docked panel and dismisses it on outside pointer input", async () => {
    const { container, root } = await render(createElement(PluginPanelDock, {
      items: [{
        id: "issues",
        label: "Issues",
        icon: createElement("span", null, "I"),
        children: createElement("div", { className: "issue-list" }, "Open issues")
      }]
    }));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Issues"]')!;
    const item = container.querySelector(".plugin-panel-dock-item")!;
    const panel = container.querySelector(".plugin-panel-dock-panel")!;

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(item.classList.contains("open")).toBe(false);
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.textContent).toBe("Open issues");

    await act(async () => {
      button.click();
    });

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(item.classList.contains("open")).toBe(true);

    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(item.classList.contains("open")).toBe(false);

    await act(async () => root.unmount());
  });

  it("switches between docked panels without leaving stale panels open", async () => {
    const { container, root } = await render(createElement(PluginPanelDock, {
      items: [
        {
          id: "issues",
          label: "Issues",
          icon: createElement("span", null, "I"),
          children: createElement("div", null, "Open issues")
        },
        {
          id: "details",
          label: "Details",
          icon: createElement("span", null, "D"),
          children: createElement("div", null, "Selected issue")
        }
      ]
    }));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".plugin-panel-dock-button"));
    const items = Array.from(container.querySelectorAll(".plugin-panel-dock-item"));

    await act(async () => {
      buttons[0].click();
    });
    expect(buttons[0].getAttribute("aria-expanded")).toBe("true");
    expect(buttons[1].getAttribute("aria-expanded")).toBe("false");
    expect(items[0].classList.contains("open")).toBe(true);

    await act(async () => {
      buttons[1].click();
    });
    expect(buttons[0].getAttribute("aria-expanded")).toBe("false");
    expect(buttons[1].getAttribute("aria-expanded")).toBe("true");
    expect(items[0].classList.contains("open")).toBe(false);
    expect(items[1].classList.contains("open")).toBe(true);

    await act(async () => root.unmount());
  });

  it("uses persistent dock controls to hide and show file-browser panels outside compact mode", async () => {
    const visibilityChanges: boolean[] = [];
    const { container, root } = await render(createElement(PluginPanelDock, {
      controls: "always",
      items: [{
        id: "tree",
        label: "File tree",
        icon: createElement("span", null, "T"),
        visible: true,
        showLabel: "Show tree view",
        hideLabel: "Hide tree view",
        onVisibleChange: (visible) => visibilityChanges.push(visible),
        children: createElement("div", null, "Files")
      }]
    }));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Hide tree view"]')!;

    await act(async () => {
      button.click();
    });

    expect(visibilityChanges).toEqual([false]);

    await act(async () => {
      root.render(createElement(PluginPanelDock, {
        controls: "always",
        items: [{
          id: "tree",
          label: "File tree",
          icon: createElement("span", null, "T"),
          visible: false,
          showLabel: "Show tree view",
          hideLabel: "Hide tree view",
          onVisibleChange: (visible) => visibilityChanges.push(visible),
          children: createElement("div", null, "Files")
        }]
      }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show tree view"]')!.click();
    });

    expect(visibilityChanges).toEqual([false, true]);

    await act(async () => root.unmount());
  });

  it("opens compact drawers without changing remembered panel visibility", async () => {
    const restoreResizeObserver = installResizeObserver();
    const visibilityChanges: boolean[] = [];
    const openChanges: boolean[] = [];
    const { container, root } = await render(createElement(PluginPanelDock, {
      controls: "compact-or-hidden",
      items: [{
        id: "tree",
        label: "File tree",
        icon: createElement("span", null, "T"),
        visible: false,
        showLabel: "Show tree view",
        hideLabel: "Hide tree view",
        onVisibleChange: (visible) => visibilityChanges.push(visible),
        onOpenChange: (open) => openChanges.push(open),
        children: createElement("div", null, "Files")
      }]
    }), { parentWidth: 420 });
    const item = container.querySelector(".plugin-panel-dock-item")!;
    const button = container.querySelector<HTMLButtonElement>('[aria-label="File tree"]')!;

    expect(item.classList.contains("hidden")).toBe(true);
    expect(container.querySelector(".plugin-panel-dock-panel")?.textContent).toBe("Files");
    expect(container.querySelector('[aria-label="Hide tree view"]')).toBeNull();

    await act(async () => {
      button.click();
    });

    expect(visibilityChanges).toEqual([]);
    expect(openChanges).toEqual([true]);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(item.classList.contains("open")).toBe(true);

    await act(async () => root.unmount());
    restoreResizeObserver();
  });
});

async function render(element: ReactElement, options: { parentWidth?: number } = {}): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  if (options.parentWidth !== undefined) {
    container.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: options.parentWidth ?? 0,
      height: 400,
      top: 0,
      right: options.parentWidth ?? 0,
      bottom: 400,
      left: 0,
      toJSON: () => ({})
    }) as DOMRect;
  }
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, root };
}

function installResizeObserver(): () => void {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = previous;
  };
}
