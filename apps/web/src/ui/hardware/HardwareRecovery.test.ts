// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareDiagnostics, HardwareStateView } from "@cloudx/shared";
import { getHardwareDiagnostics } from "../../hardwareApi.js";
import { HardwareRecovery } from "./HardwareRecovery.js";

vi.mock("../../hardwareApi.js", () => ({ getHardwareDiagnostics: vi.fn() }));

let root: Root | undefined;
const readiness: HardwareStateView["readiness"] = {
  state: "unavailable",
  reason: "Hardware could not confirm durable state.",
  recovery: {
    phase: "directory_sync",
    errno: "ENOSPC",
    durability: "unconfirmed",
    authorityReplaced: true,
    nextAction: "Free host storage, then reconcile storage.",
  },
};
const state: HardwareStateView = {
  revision: 8,
  items: [],
  tags: [],
  groups: [],
  types: [],
  statusDefinitions: [],
  reservations: [],
  checkHolds: [],
  receipts: [],
  history: [],
  currentOwner: { kind: "user", userId: "local" },
  readiness,
};
const evidence: HardwareDiagnostics = {
  readiness,
  lastConfirmedState: true,
  state: {
    schemaVersion: 1,
    revision: 8,
    nextGeneration: 10,
    reservations: [{ reservationId: "original", generation: 9 }],
    receipts: [{ requestId: "original-request" }],
    history: [],
  },
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getHardwareDiagnostics).mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(value = state, onReconcile = vi.fn(async () => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(HardwareRecovery, {
        state: value,
        connected: true,
        busy: false,
        onReconcile,
      }),
    ),
  );
  return container;
}
function button(container: Element, name: string) {
  const value = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  expect(value, name).toBeDefined();
  return value!;
}

describe("Hardware storage recovery", () => {
  it.each([
    {
      phase: "state_read",
      errno: "EIO",
      nextAction: "Preserve corrupt state and repair it on the host.",
    },
    {
      phase: "writer_assert",
      errno: undefined,
      nextAction: "Stop the duplicate writer before reconciliation.",
    },
  ])("keeps recovery available for $phase failures", async (recovery) => {
    const container = await mount({
      ...state,
      readiness: {
        ...readiness,
        recovery: { ...readiness.recovery!, ...recovery },
      },
    });
    expect(container.textContent).toContain(recovery.phase);
    expect(container.textContent).toContain(recovery.errno ?? "Not reported");
    expect(container.textContent).toContain(recovery.nextAction);
    expect(button(container, "Reconcile storage").disabled).toBe(false);
    expect(button(container, "Download evidence").disabled).toBe(false);
  });

  it("reports the failure boundary and keeps an explicit operator entry point available", async () => {
    const reconcile = vi.fn(async () => {});
    const container = await mount(state, reconcile);
    expect(container.textContent).toContain("directory_sync");
    expect(container.textContent).toContain("ENOSPC");
    expect(container.textContent).toContain("unconfirmed");
    expect(container.textContent).toContain(readiness.recovery!.nextAction);
    expect(container.textContent).toContain("Do not delete");
    expect(button(container, "Download evidence").disabled).toBe(false);
    expect(button(container, "Reconcile storage").disabled).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    await act(async () => button(container, "Reconcile storage").click());
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("shows the full evidence and exports exact reservation and request identities", async () => {
    vi.mocked(getHardwareDiagnostics).mockResolvedValue(evidence);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:hardware-evidence");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download;
    });
    const container = await mount();
    await act(async () => button(container, "Download evidence").click());
    expect(filename).toBe("cloudx-hardware-diagnostics.json");
    expect(JSON.parse(container.querySelector("pre")!.textContent!)).toEqual(
      evidence,
    );
    const content = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(createObjectURL.mock.calls[0]![0]);
    });
    expect(JSON.parse(content)).toEqual(evidence);
    await vi.waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        "blob:hardware-evidence",
      ),
    );
  });

  it("keeps an initial corrupt-state diagnosis distinct from an empty inventory", async () => {
    vi.mocked(getHardwareDiagnostics).mockResolvedValue({
      ...evidence,
      lastConfirmedState: false,
    });
    const container = await mount();
    await act(async () => button(container, "Inspect diagnostics").click());
    expect(container.textContent).toContain(
      "has not durably confirmed inventory",
    );
    expect(container.textContent).toContain(
      "does not authorize creation or release",
    );
  });

  it("shows diagnostic failures without hiding the host procedure or reconciliation", async () => {
    vi.mocked(getHardwareDiagnostics).mockRejectedValue(
      new Error("Writer evidence unavailable."),
    );
    const container = await mount();
    await act(async () => button(container, "Inspect diagnostics").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Writer evidence unavailable.",
    );
    expect(button(container, "Reconcile storage").disabled).toBe(false);
    expect(container.textContent).toContain("Host recovery procedure");
  });

  it("does not offer operator actions to an agent", async () => {
    const container = await mount({
      ...state,
      currentOwner: {
        kind: "agent",
        tabId: "tab",
        providerId: "codex",
        executionId: "execution",
      },
    });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain(
      "Open Hardware as a local operator",
    );
    expect(container.textContent).toContain("ENOSPC");
  });

  it("aborts an evidence read when the panel closes", async () => {
    vi.mocked(getHardwareDiagnostics).mockImplementation(
      () => new Promise(() => {}),
    );
    const container = await mount();
    await act(async () => button(container, "Inspect diagnostics").click());
    const signal = vi.mocked(getHardwareDiagnostics).mock.calls[0]![0];
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal?.aborted).toBe(true);
  });

  it("does not render a recovery warning when storage is ready", async () => {
    const container = await mount({ ...state, readiness: { state: "ready" } });
    expect(container.childElementCount).toBe(0);
  });
});
