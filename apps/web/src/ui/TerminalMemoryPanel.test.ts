// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalMemoryStatus } from "@cloudx/shared";

import { TerminalMemoryPanel } from "./TerminalMemoryPanel.js";
import { SettingsDialog } from "./SettingsDialog.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const status: TerminalMemoryStatus = {
  service: "cloudx-terminal.service", manageable: true,
  limits: { memoryHigh: String(24 * 1024 ** 3), memoryMax: String(32 * 1024 ** 3) },
  effective: { memoryHigh: String(16 * 1024 ** 3), memoryMax: String(20 * 1024 ** 3) },
  usageBytes: 19 * 1024 ** 3,
  pressure: { someAvg10: 96.22, fullAvg10: 95.73 }, events: { high: 2260, oom: 1, oomKill: 0 },
  fragmentPath: "/config/cloudx-terminal.service", dropInPaths: ["/run/user/1000/systemd/user.control/cloudx-terminal.service.d/50-MemoryHigh.conf"],
  controlGroup: "/user.slice/terminal", activeState: "active"
};

async function render(element: ReactElement = createElement(TerminalMemoryPanel)) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

function control(container: Element, label: string) {
  return container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
}
function button(container: Element, text: string) {
  return [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === text)!;
}
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("terminal memory settings", () => {
  it("shows the terminal workload scope, inherited constraints, pressure and operator overrides", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status)));
    const container = await render();
    expect(container.textContent).toContain("persistent terminal broker and all its child workloads");
    expect(container.textContent).toContain("web service and Node.js JavaScript heap settings are separate");
    expect(container.textContent).toContain("24 GiB");
    expect(container.textContent).toContain("16 GiB");
    expect(container.textContent).toContain("19.00 GiB");
    expect(container.textContent).toContain("effective limits differ");
    expect(container.textContent).toContain("kernel page-size rounding");
    expect(container.textContent).toContain("96.22%");
    expect(container.textContent).toContain("95.73%");
    expect(container.textContent).toContain("throttling (high) 2260");
    expect(container.textContent).toContain(status.dropInPaths[0]);
    expect(control(container, "MemoryHigh amount").value).toBe("24");
    expect(control(container, "MemoryHigh unit").value).toBe("GiB");
    expect(button(container, "Apply terminal memory").disabled).toBe(true);
  });

  it("validates finite ordering before applying and displays the returned effective limits", async () => {
    const readback = { ...status, limits: { memoryHigh: String(55 * 1024 ** 3), memoryMax: String(64 * 1024 ** 3) }, effective: { memoryHigh: String(40 * 1024 ** 3), memoryMax: String(48 * 1024 ** 3) } };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(Response.json(readback));
    vi.stubGlobal("fetch", fetch);
    const container = await render();
    await change(control(container, "MemoryHigh amount"), "55");
    expect(container.textContent).toContain("MemoryHigh must not exceed MemoryMax");
    expect(button(container, "Apply terminal memory").disabled).toBe(true);
    await change(control(container, "MemoryMax amount"), "64");
    await act(async () => button(container, "Apply terminal memory").click());
    expect(fetch).toHaveBeenLastCalledWith("/api/terminal-memory", expect.objectContaining({
      method: "PUT", body: JSON.stringify(readback.limits)
    }));
    expect(container.textContent).toContain("applied and persisted");
    expect(container.textContent).toContain("40 GiB");
    expect(container.textContent).toContain("48 GiB");
    expect(control(container, "MemoryHigh amount").value).toBe("55");
    expect(button(container, "Apply terminal memory").disabled).toBe(true);
  });

  it("offers unlimited without converting unavailable readings into unlimited", async () => {
    const unavailable = { ...status, manageable: false, reason: "Use a Linux user systemd installation.", limits: { memoryHigh: null, memoryMax: "infinity" }, effective: { memoryHigh: null, memoryMax: null }, usageBytes: null, pressure: null, events: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(unavailable)));
    const container = await render();
    expect(container.textContent).toContain("Memory controls are unavailable");
    expect(container.textContent).toContain("Use a Linux user systemd installation");
    expect(container.querySelector("table")?.textContent).toContain("Unknown");
    expect(container.querySelector("table")?.textContent).toContain("Unlimited");
    expect(control(container, "MemoryHigh amount").value).toBe("");
    expect(control(container, "MemoryMax unit").value).toBe("infinity");
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
  });

  it("shows arbitrary effective bytes in readable units and preserves exact bytes in a title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...status, effective: { memoryHigh: "0", memoryMax: "98530299904" } })));
    const container = await render();
    const readings = container.querySelector("table")!;
    expect(readings.textContent).toContain("0 B");
    expect(readings.textContent).toContain("91.76 GiB");
    expect(readings.querySelector('[title="98530299904 B"]')?.textContent).toBe("91.76 GiB");
  });

  it("applies an explicit unlimited choice and preserves actionable application failures", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(status)).mockResolvedValueOnce(Response.json({ message: "Cannot persist memory limits: check write permission on /config/systemd/user." }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const container = await render();
    await change(control(container, "MemoryHigh unit"), "infinity");
    await change(control(container, "MemoryMax unit"), "infinity");
    await act(async () => button(container, "Apply terminal memory").click());
    expect(fetch).toHaveBeenLastCalledWith("/api/terminal-memory", expect.objectContaining({ method: "PUT", body: JSON.stringify({ memoryHigh: "infinity", memoryMax: "infinity" }) }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("check write permission");
    expect(container.textContent).not.toContain("applied and persisted");
    expect(button(container, "Apply terminal memory").disabled).toBe(false);
  });

  it("refreshes after a read failure and cancels its request on unmount", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ message: "Cannot reach user systemd. Start the user manager." }, { status: 503 })).mockResolvedValueOnce(Response.json(status));
    vi.stubGlobal("fetch", fetch);
    const container = await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Start the user manager");
    await act(async () => button(container, "Refresh memory").click());
    expect(container.textContent).toContain("24 GiB");
    const signal = fetch.mock.calls[1]![1].signal as AbortSignal;
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
  });

  it("finds memory controls in Settings and keeps Apply separate from Settings Save", async () => {
    const fetch = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetch);
    const save = vi.fn(async () => {});
    const config = { globalFields: [], plugins: [], values: { global: {}, plugins: {} } };
    const container = await render(createElement(SettingsDialog, { config, onCancel: vi.fn(), onSave: save }));
    expect(fetch).not.toHaveBeenCalled();
    await change(control(container, "Search settings"), "MemoryHigh");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Terminal");
    expect(control(container, "MemoryHigh amount").value).toBe("24");
    await change(control(container, "MemoryHigh amount"), "25");
    await act(async () => button(container, "Save").click());
    expect(save).toHaveBeenCalledWith(config.values);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Settings Save button does not apply these controls");
  });
});
