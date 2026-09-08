// @vitest-environment jsdom

import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_RENDERER_PLUGIN_WEBVIEW, type PluginDescriptor, type UiContributionDescriptor } from "@cloudx/shared";

import { TabPanel, tabPanelSupportsFileTransfers } from "./TabPanel.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("tabPanelSupportsFileTransfers", () => {
  it.each([
    ["file-browser", true],
    ["web-viewer", true],
    ["terminal", false],
    ["automation", false],
    ["worktree-manager", false],
    ["placeholder", false]
  ] as const)("retains %s panels only when they own transfers", (panelKind, expected) => {
    expect(tabPanelSupportsFileTransfers(plugin(panelKind), undefined)).toBe(expected);
  });

  it("retains contributed webviews even when the plugin is missing or uses another panel kind", () => {
    const webview = contribution(UI_RENDERER_PLUGIN_WEBVIEW);

    expect(tabPanelSupportsFileTransfers(plugin("placeholder"), webview)).toBe(true);
    expect(tabPanelSupportsFileTransfers(undefined, webview)).toBe(true);
  });

  it("does not retain missing plugins or unrelated contributions", () => {
    expect(tabPanelSupportsFileTransfers(undefined, undefined)).toBe(false);
    expect(tabPanelSupportsFileTransfers(plugin("placeholder"), contribution("documentation.panel"))).toBe(false);
  });
});

describe("TabPanel", () => {
  it("starts on first selection and keeps transfer state, nodes and effects until the tab closes", async () => {
    const started = vi.fn();
    const stopped = vi.fn();
    const transfer = createElement(TransferProgress, { name: "upload", started, stopped });
    const panel = (selected: boolean) => createElement(TabPanel, { selected, retain: true, children: transfer });

    await render(panel(false));
    expect(container.childElementCount).toBe(0);
    expect(started).not.toHaveBeenCalled();

    await render(panel(true));
    const progress = container.querySelector("output")!;
    const wrapper = progress.parentElement!;
    expect(started).toHaveBeenCalledExactlyOnceWith("upload");
    expect(wrapper.hidden).toBe(false);

    await reportProgress("upload", 25);
    await render(panel(false));
    expect(container.querySelector("output")).toBe(progress);
    expect(wrapper.hidden).toBe(true);
    expect(wrapper.style.display).toBe("none");
    expect(stopped).not.toHaveBeenCalled();

    await reportProgress("upload", 75);
    expect(progress.textContent).toBe("75");
    await render(panel(true));
    expect(container.querySelector("output")).toBe(progress);
    expect(progress.textContent).toBe("75");
    expect(wrapper.hidden).toBe(false);
    expect(wrapper.style.display).toBe("contents");
    expect(started).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();

    await render(panel(false));
    await render(null);
    expect(stopped).toHaveBeenCalledExactlyOnceWith("upload");
    expect(container.childElementCount).toBe(0);
  });

  it("keeps sibling transfers independent when selecting or closing a tab", async () => {
    const started = vi.fn();
    const stopped = vi.fn();
    const panels = (selected: string, names = ["upload", "download"]) => names.map((name) => createElement(TabPanel, {
      key: name,
      selected: name === selected,
      retain: true,
      children: createElement(TransferProgress, { name, started, stopped })
    }));

    await render(panels("upload"));
    const upload = container.querySelector('[aria-label="upload"]')!;
    expect(container.querySelector('[aria-label="download"]')).toBeNull();
    await reportProgress("upload", 20);

    await render(panels("download"));
    const download = container.querySelector('[aria-label="download"]')!;
    await reportProgress("download", 60);
    await reportProgress("upload", 40);
    await render(panels("upload"));

    expect(container.querySelector('[aria-label="upload"]')).toBe(upload);
    expect(container.querySelector('[aria-label="download"]')).toBe(download);
    expect(upload.textContent).toBe("40");
    expect(download.textContent).toBe("60");
    expect(started.mock.calls).toEqual([["upload"], ["download"]]);
    expect(stopped).not.toHaveBeenCalled();

    await render(panels("download", ["download"]));
    expect(stopped).toHaveBeenCalledExactlyOnceWith("upload");
    expect(container.querySelector('[aria-label="download"]')).toBe(download);
    await reportProgress("download", 100);
    expect(download.textContent).toBe("100");
  });

  it("unmounts panels without transfers when deselected", async () => {
    const started = vi.fn();
    const stopped = vi.fn();
    const panel = (selected: boolean) => createElement(TabPanel, {
      selected,
      retain: false,
      children: createElement(TransferProgress, { name: "ordinary-panel", started, stopped })
    });

    await render(panel(true));
    const firstNode = container.querySelector("output");
    await reportProgress("ordinary-panel", 50);
    await render(panel(false));
    expect(container.childElementCount).toBe(0);
    expect(stopped).toHaveBeenCalledExactlyOnceWith("ordinary-panel");

    await render(panel(true));
    expect(container.querySelector("output")).not.toBe(firstNode);
    expect(container.querySelector("output")?.textContent).toBe("0");
    expect(started).toHaveBeenCalledTimes(2);
  });
});

function TransferProgress({ name, started, stopped }: { name: string; started: (name: string) => void; stopped: (name: string) => void }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const eventName = `transfer-progress:${name}`;
    const update = (event: Event) => setProgress((event as CustomEvent<number>).detail);
    started(name);
    window.addEventListener(eventName, update);
    return () => {
      window.removeEventListener(eventName, update);
      stopped(name);
    };
  }, [name, started, stopped]);
  return createElement("output", { "aria-label": name }, progress);
}

async function render(children: ReactNode) {
  await act(async () => root.render(children));
}

async function reportProgress(name: string, progress: number) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(`transfer-progress:${name}`, { detail: progress }));
  });
}

function plugin(panelKind: PluginDescriptor["panelKind"]): PluginDescriptor {
  return {
    id: panelKind,
    acronym: "TEST",
    displayName: panelKind,
    description: panelKind,
    panelKind,
    creatable: false,
    requiresDirectory: false,
    actions: [],
    configFields: []
  };
}

function contribution(renderer: string): UiContributionDescriptor {
  return {
    id: renderer,
    owner: { kind: "plugin", pluginId: "test" },
    slot: "plugin.panel",
    renderer,
    title: renderer
  };
}
