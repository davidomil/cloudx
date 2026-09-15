// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUDX_LOG_SOURCES, type CloudxLogsResponse } from "@cloudx/shared";

import { LogsPanel } from "./LogsPanel.js";

let root: Root | undefined;
const snapshot: CloudxLogsResponse = { source: "current", content: "server started\n<script>untrusted log</script>\n", capturedAt: "2026-09-15T10:20:30.000Z", truncated: false };

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(LogsPanel)));
  return container;
}

function button(container: Element, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(item => item.textContent === name);
  expect(found, name).toBeDefined();
  return found!;
}

async function selectSource(container: Element, source: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = source;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Logs panel", () => {
  it("shows the available sources and renders log content as plain text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    const container = await mount();

    expect([...container.querySelectorAll("option")].map(option => option.value)).toEqual(CLOUDX_LOG_SOURCES.map(source => source.id));
    expect(container.querySelector("pre")?.textContent).toBe(snapshot.content);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("time")?.dateTime).toBe(snapshot.capturedAt);
    expect(button(container, "Download logs").disabled).toBe(false);
  });

  it("shows loading and disables download until a snapshot arrives", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const container = await mount();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading logs…");
    expect(button(container, "Download logs").disabled).toBe(true);
    expect(button(container, "Refresh logs").disabled).toBe(true);
    expect(container.querySelector("select")?.disabled).toBe(false);

    await act(async () => finish(Response.json(snapshot)));
    expect(container.querySelector("pre")?.textContent).toBe(snapshot.content);
  });

  it("refreshes the selected source and explains empty and truncated snapshots", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ ...snapshot, source: "services", content: "" }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, source: "services", content: "newest service log\n", truncated: true }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount();
    await selectSource(container, "services");

    expect(container.textContent).toContain("No logs available for this source.");
    expect(container.querySelector("pre")).toBeNull();
    expect(button(container, "Download logs").disabled).toBe(true);
    await act(async () => button(container, "Refresh logs").click());

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/api/logs?source=current", "/api/logs?source=services", "/api/logs?source=services"]);
    expect(container.querySelector("pre")?.textContent).toBe("newest service log\n");
    expect(container.textContent).toContain("Some entries were omitted");
  });

  it("reports journal failures and allows an explicit refresh", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Service journal is unavailable." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Service journal is unavailable.");
    expect(button(container, "Download logs").disabled).toBe(true);
    expect(button(container, "Refresh logs").disabled).toBe(false);
    await act(async () => button(container, "Refresh logs").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(snapshot.content);
  });

  it("aborts old source requests and ignores their late results", async () => {
    let finishOld!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, source: "asr", content: "ASR ready\n" }));
    vi.stubGlobal("fetch", fetchMock);
    const container = await mount();
    await selectSource(container, "asr");

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finishOld(Response.json(snapshot)));
    expect(container.querySelector("pre")?.textContent).toBe("ASR ready\n");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("aborts in-flight requests when the panel closes", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => root!.unmount());
    root = undefined;

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("downloads exactly the displayed snapshot and releases its object URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot)));
    const createObjectURL = vi.fn((_blob: Blob) => "blob:cloudx-log-snapshot");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    let download: { name: string; href: string } | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download = { name: this.download, href: this.href };
    });
    const container = await mount();
    await act(async () => button(container, "Download logs").click());

    expect(download).toEqual({ name: "cloudx-current-2026-09-15T10-20-30-000Z.log", href: "blob:cloudx-log-snapshot" });
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/plain;charset=utf-8");
    const content = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(content).toBe(container.querySelector("pre")?.textContent);
    expect(document.querySelector("a[download]")).toBeNull();
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:cloudx-log-snapshot"));
  });
});
