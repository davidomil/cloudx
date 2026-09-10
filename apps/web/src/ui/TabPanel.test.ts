// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TabPanel } from "./TabPanel.js";

let root: Root;
let container: HTMLDivElement;
const mounted = vi.fn();
const disposed = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("tab panel lifetime", () => {
  it("loads a retained panel only after its first activation", async () => {
    await showPanel(false, true);
    expect(container.querySelector("iframe")).toBeNull();
    expect(mounted).not.toHaveBeenCalled();

    await showPanel(true, true);
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("keeps the same embedded document and subscriptions across tab switches", async () => {
    await showPanel(true, true);
    const frame = container.querySelector("iframe")!;
    const contentDocument = frame.contentDocument;

    await showPanel(false, true);
    expect(frame.isConnected).toBe(true);
    expect(frame.closest<HTMLDivElement>(".pane-tab-panel")?.hidden).toBe(true);
    expect(disposed).not.toHaveBeenCalled();

    await showPanel(true, true);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.contentDocument).toBe(contentDocument);
    expect(frame.closest<HTMLDivElement>(".pane-tab-panel")?.hidden).toBe(false);
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("disposes ordinary panels when switching away", async () => {
    await showPanel(true, false);
    const frame = container.querySelector("iframe")!;
    await showPanel(false, false);
    expect(frame.isConnected).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);

    await showPanel(true, false);
    expect(container.querySelector("iframe")).not.toBe(frame);
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("disposes a hidden retained panel when its tab is closed", async () => {
    await showPanel(true, true);
    const frame = container.querySelector("iframe")!;
    await showPanel(false, true);
    await act(async () => root.render(null));
    expect(frame.isConnected).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(1);

    await showPanel(false, true);
    expect(container.querySelector("iframe")).toBeNull();
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("releases a hidden panel when it no longer requires retention", async () => {
    await showPanel(true, true);
    await showPanel(false, true);
    await showPanel(false, false);
    expect(container.querySelector("iframe")).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});

function EmbeddedPanel() {
  useEffect(() => {
    mounted();
    return () => { disposed(); };
  }, []);
  return createElement("iframe", { title: "Transfer dashboard" });
}

async function showPanel(active: boolean, keepMounted: boolean) {
  await act(async () => root.render(createElement(TabPanel, {
    active,
    keepMounted,
    children: createElement(EmbeddedPanel)
  })));
}
