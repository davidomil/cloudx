// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateStatus } from "@cloudx/shared";

import { CloudxUpdatePanel, useCloudxUpdate } from "./CloudxUpdatePanel.js";

let root: Root | undefined;
const reload = vi.fn();
const available: CloudxUpdateStatus = { available: true };
const run = (state: "running" | "succeeded" | "failed" = "running", id = "update-1"): CloudxUpdateStatus => ({
  available: true,
  run: { id, state, message: state === "running" ? "Installing updates." : state === "failed" ? "Installer failed: repository has local changes." : "CloudX is up to date.", startedAt: "2026-09-15T04:00:00.000Z" }
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  sessionStorage.clear();
  reload.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function reply(status: CloudxUpdateStatus, code = 200) { return new Response(JSON.stringify(status), { status: code }); }

async function mount(beforeStart: () => Promise<void> = async () => undefined) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const [open, setOpen] = useState(true);
    const update = useCloudxUpdate(open, beforeStart, reload);
    return createElement("div", {},
      createElement("button", { onClick: () => setOpen(value => !value) }, "Toggle settings"),
      open ? createElement(CloudxUpdatePanel, { update }) : null
    );
  }
  await act(async () => root!.render(createElement(Harness)));
  return container;
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) { await act(async () => button(label).click()); }
async function poll() { await act(async () => vi.advanceTimersByTimeAsync(2_000)); }

describe("CloudX updates", () => {
  it("shows update scope, restart behavior, and an unavailable reason without starting anything", async () => {
    const fetch = vi.fn(async () => reply({ available: false, unavailableReason: "Use the installed CloudX system service." }));
    vi.stubGlobal("fetch", fetch);
    const container = await mount();
    expect(container.textContent).toContain("Codex, and installed dependencies");
    expect(container.textContent).toContain("persistent Codex and terminal tabs reconnect");
    expect(container.textContent).toContain("Running automation and voice work may stop");
    expect(container.textContent).toContain("Use the installed CloudX system service.");
    expect(button("Update CloudX and dependencies").disabled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("saves pending workspace writes before starting once and keeps monitoring with Settings closed", async () => {
    let finishSaving!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finishSaving = resolve; }));
    let current = available;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") current = run();
      return reply(current, init?.method === "POST" ? 202 : 200);
    });
    vi.stubGlobal("fetch", fetch);
    await mount(save);
    await click("Update CloudX and dependencies");
    await click("Starting update…");
    expect(save).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => finishSaving());
    await click("Updating CloudX…");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]).toMatchObject({ body: "{}", headers: { "content-type": "application/json" } });
    await click("Toggle settings");
    current = run("succeeded");
    await poll();
    expect(reload).toHaveBeenCalledOnce();
    await click("Toggle settings");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not start when saving the workspace fails", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply(available));
    vi.stubGlobal("fetch", fetch);
    const container = await mount(async () => { throw new Error("Workspace could not be saved."); });
    await click("Update CloudX and dependencies");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Workspace could not be saved.");
    expect(fetch.mock.calls.every(call => (call[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("polls read-only through a restart disconnect and reloads once after success", async () => {
    let current = available;
    let disconnected = false;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (disconnected) throw new TypeError("Failed to fetch");
      if (init?.method === "POST") current = run();
      return reply(current);
    });
    vi.stubGlobal("fetch", fetch);
    const container = await mount();
    await click("Update CloudX and dependencies");
    disconnected = true;
    await poll();
    expect(container.textContent).toContain("Waiting for CloudX to return");
    disconnected = false;
    current = run("succeeded");
    await poll();
    expect(reload).toHaveBeenCalledOnce();
    await click("Check update status");
    expect(reload).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers a lost start response by reading status without repeating the command", async () => {
    let current = available;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { current = run("succeeded"); throw new TypeError("Connection closed"); }
      return reply(current);
    });
    vi.stubGlobal("fetch", fetch);
    await mount();
    await click("Update CloudX and dependencies");
    expect(reload).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("recovers a previously observed active run after the component remounts", async () => {
    let current = run();
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    await mount();
    await act(async () => root!.unmount());
    root = undefined;
    current = run("succeeded");
    await mount();
    expect(reload).toHaveBeenCalledOnce();
    await act(async () => root!.unmount());
    root = undefined;
    await mount();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload for a historical successful update", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(run("succeeded"))));
    await mount();
    expect(reload).not.toHaveBeenCalled();
    expect(button("Update CloudX and dependencies").disabled).toBe(false);
  });

  it("shows installer failure and never reloads", async () => {
    let current = run();
    vi.stubGlobal("fetch", vi.fn(async () => reply(current)));
    const container = await mount();
    current = run("failed");
    await poll();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("repository has local changes");
    expect(reload).not.toHaveBeenCalled();
    expect(button("Update CloudX and dependencies").disabled).toBe(false);
  });

  it("retains rejected start errors until the user checks status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "Update request is forbidden." }), { status: 403 }) : reply(available)));
    const container = await mount();
    await click("Update CloudX and dependencies");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Update request is forbidden.");
    expect(button("Update CloudX and dependencies").disabled).toBe(true);
    await click("Check update status");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Update CloudX and dependencies").disabled).toBe(false);
  });

  it("reads an unavailable response when preflight rejects a start", async () => {
    let current = available;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") current = { available: false, unavailableReason: "Noninteractive sudo is required." };
      return reply(current, init?.method === "POST" ? 409 : 200);
    }));
    const container = await mount();
    await click("Update CloudX and dependencies");
    expect(container.textContent).toContain("Noninteractive sudo is required.");
    expect(button("Update CloudX and dependencies").disabled).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads an old success attached to an unavailable start response", async () => {
    let current = run("succeeded", "past-update");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") current = { ...current, available: false, unavailableReason: "Repository now has local changes." };
      return reply(current, init?.method === "POST" ? 409 : 200);
    }));
    const container = await mount();
    await click("Update CloudX and dependencies");
    expect(container.textContent).toContain("Repository now has local changes.");
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("cloudx.update.pendingRun")).toBeNull();
  });

  it("reconciles an ambiguous server error against the accepted run without a second start", async () => {
    let current = available;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        current = run("succeeded");
        return new Response(JSON.stringify({ error: "Launch status timed out." }), { status: 503 });
      }
      return reply(current);
    });
    vi.stubGlobal("fetch", fetch);
    await mount();
    await click("Update CloudX and dependencies");
    expect(reload).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("stops monitoring after a bounded wait and resumes only status reads on request", async () => {
    const fetch = vi.fn(async () => reply(run()));
    vi.stubGlobal("fetch", fetch);
    const container = await mount();
    await act(async () => vi.advanceTimersByTimeAsync(65 * 60_000));
    expect(container.textContent).toContain("Update monitoring timed out after 65 minutes");
    const count = fetch.mock.calls.length;
    await poll();
    expect(fetch).toHaveBeenCalledTimes(count);
    await click("Check update status");
    expect(fetch).toHaveBeenCalledTimes(count + 1);
  });

  it("aborts pending status requests and clears polling timers on unmount", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal?.aborted).toBe(true);
    await poll();
    expect(fetch).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive status request and reports that availability is unknown", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("Status request timed out.")));
    }));
    vi.stubGlobal("fetch", fetch);
    const container = await mount();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Status request timed out");
    expect(button("Update CloudX and dependencies").disabled).toBe(true);
    expect(button("Check update status").disabled).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed status responses before enabling a host update", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: "yes" }))));
    const container = await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid CloudX update status");
    expect(button("Update CloudX and dependencies").disabled).toBe(true);
  });
});
