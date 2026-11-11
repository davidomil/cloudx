// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HardwareReservation,
  HardwareStateView,
  PluginDescriptor,
  WorkspaceStateResponse,
  WorkspaceTab,
  WorkspaceWindow,
} from "@cloudx/shared";
import { App } from "./App.js";

vi.mock("./TerminalPanel.js", () => ({
  TerminalPanel: ({ tab }: { tab: WorkspaceTab }) =>
    createElement("div", { "data-owner-terminal": tab.id }, tab.title),
}));

const roots: Root[] = [];
const at = "2026-11-11T00:00:00.000Z";
const hardware: WorkspaceTab = {
  id: "hardware",
  pluginId: "hardware",
  title: "Hardware",
  cwd: "/unused",
  status: "idle",
  indicator: { color: "green", label: "Ready", updatedAt: at },
  createdAt: at,
  updatedAt: at,
};
const owner: WorkspaceTab = {
  ...hardware,
  id: "original-owner",
  pluginId: "codex-terminal",
  title: "Camera bring-up",
  status: "running",
};
const claim: HardwareReservation = {
  reservationId: "reservation",
  generation: 4,
  revision: 2,
  hardwareId: "camera",
  owner: {
    kind: "agent",
    tabId: owner.id,
    providerId: "codex",
    executionId: "reserved-execution",
  },
  state: "active",
  resourceKeys: [],
  purpose: "Inspect camera",
  acquiredItemRevision: 1,
  acquiredNotesRevision: 1,
  acquiredAt: at,
  updatedAt: at,
  lastOwnerObservation: "unknown",
  activeOperationIds: [],
};
const hardwareState: HardwareStateView = {
  revision: 1,
  items: [],
  tags: [],
  groups: [],
  types: [],
  statusDefinitions: [],
  reservations: [claim],
  checkHolds: [],
  receipts: [],
  history: [],
  currentOwner: { kind: "user", userId: "local" },
  readiness: { state: "ready" },
  agentReadiness: [
    {
      tabId: owner.id,
      providerId: "codex",
      executionId: "current-execution",
      state: "ready",
    },
  ],
};
const plugins: PluginDescriptor[] = [
  {
    id: "hardware",
    acronym: "HW",
    displayName: "Hardware",
    description: "Hardware",
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    actions: [],
    configFields: [],
    uiContributions: [
      {
        id: "hardware.panel",
        owner: { kind: "plugin", pluginId: "hardware" },
        slot: "plugin.panel",
        renderer: "hardware.panel",
        title: "Hardware",
        targetPluginId: "hardware",
      },
    ],
  },
  {
    id: "codex-terminal",
    acronym: "CDX",
    displayName: "Codex",
    description: "Codex",
    panelKind: "terminal",
    creatable: false,
    requiresDirectory: true,
    actions: [],
    configFields: [],
  },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class extends EventTarget {
      close() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function windowWith(
  id: string,
  name: string,
  tabIds: string[],
  activeTabId: string,
): WorkspaceWindow {
  return {
    id,
    name,
    defaultCwd: "/unused",
    createdAt: at,
    updatedAt: at,
    layout: {
      activePaneId: `${id}-pane`,
      root: { type: "pane", pane: { id: `${id}-pane`, tabIds, activeTabId } },
    },
  };
}

async function fixture(
  location: "visible" | "hidden" | "other" | "unplaced" | "missing",
  removeOwnerOnSwitch = false,
  moveOwnerOnSwitch = false,
) {
  const current = windowWith(
    "current",
    "Main",
    [hardware.id, ...(location === "visible" ? [owner.id] : [])],
    hardware.id,
  );
  if (location === "hidden")
    current.layout.root = {
      type: "split",
      id: "split",
      direction: "row",
      sizes: [50, 50],
      children: [
        current.layout.root,
        {
          type: "pane",
          pane: { id: "owner-pane", tabIds: [owner.id], activeTabId: owner.id },
        },
      ],
    };
  let workspace: WorkspaceStateResponse = {
    tabs: [hardware, ...(location === "missing" ? [] : [owner])],
    windows: [
      current,
      ...(location === "other"
        ? [windowWith("lab", "Camera lab", [owner.id], owner.id)]
        : []),
    ],
    activeWindowId: current.id,
    activeTabId: hardware.id,
    templates: [],
  };
  const calls: {
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ url, method, body });
      if (url === "/api/hardware/state") return reply(hardwareState);
      const select = /^\/api\/windows\/([^/]+)\/active$/u.exec(url);
      if (select) {
        workspace = {
          ...workspace,
          activeWindowId: select[1],
          ...(removeOwnerOnSwitch ? { tabs: [hardware] } : {}),
          ...(moveOwnerOnSwitch
            ? {
                windows: workspace.windows.map((window) =>
                  window.id === select[1]
                    ? {
                        ...window,
                        layout: {
                          activePaneId: "moved-owner-pane",
                          root: {
                            type: "pane",
                            pane: {
                              id: "moved-owner-pane",
                              tabIds: [owner.id],
                              activeTabId: owner.id,
                            },
                          },
                        },
                      }
                    : window,
                ),
              }
            : {}),
        };
        return reply(workspace);
      }
      const layout = /^\/api\/windows\/([^/]+)$/u.exec(url);
      if (layout && method === "PATCH") {
        workspace = {
          ...workspace,
          windows: workspace.windows.map((window) =>
            window.id === layout[1]
              ? { ...window, layout: body!.layout as WorkspaceWindow["layout"] }
              : window,
          ),
        };
        return reply(workspace);
      }
      const activate = /^\/api\/tabs\/([^/]+)\/active$/u.exec(url);
      if (activate) {
        if (!workspace.tabs.some((tab) => tab.id === activate[1]))
          return reply({ message: "The original owner disappeared." }, 404);
        workspace = { ...workspace, activeTabId: activate[1] };
        return reply({ activeTabId: activate[1] });
      }
      const replies: Record<string, unknown> = {
        "/api/plugins": { plugins },
        "/api/workspace": workspace,
        "/api/config": {
          globalFields: [],
          plugins: [],
          values: {
            global: {
              microphoneEnabled: false,
              voiceCommandsEnabled: false,
              aiControlEnabled: false,
            },
            plugins: {},
          },
        },
        "/api/automation/catalog": { nodes: [] },
        "/api/automation/groups": { groups: [] },
        "/api/notifications": { notifications: [] },
        "/api/health": { ok: true },
      };
      if (!(url in replies))
        throw new Error(`Unexpected request: ${method} ${url}`);
      return reply(replies[url]);
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(App));
    await import("./hardware/HardwarePanel.js");
  });
  await vi.waitFor(() =>
    expect(container.querySelector(".hardware-panel")).not.toBeNull(),
  );
  await click(container, "Reservations");
  await vi.waitFor(() =>
    expect(container.querySelector(".hardware-panel tbody tr")).not.toBeNull(),
  );
  const open = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".hardware-panel button",
      ),
    ].find((button) =>
      /^Open owner(?: tab)?$/u.test(button.textContent?.trim() ?? ""),
    )!;
  return { container, calls, open, workspace: () => workspace };
}

async function click(container: Element, text: string) {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.trim() === text)!;
  expect(button, text).toBeDefined();
  await act(async () => button.click());
}

function expectNoNewExecution(
  calls: Awaited<ReturnType<typeof fixture>>["calls"],
) {
  expect(
    calls.filter(
      (call) =>
        (call.url === "/api/tabs" && call.method === "POST") ||
        /\/(?:recover|actions)$/u.test(call.url),
    ),
  ).toEqual([]);
}

describe("Hardware owner navigation in App", () => {
  it.each(["visible", "hidden", "other", "unplaced"] as const)(
    "reveals the retained exact owner when it is %s without creating an execution",
    async (location) => {
      const f = await fixture(location);
      if (location === "hidden") {
        const maximize = f.container.querySelector<HTMLButtonElement>(
          '[data-pane-id="current-pane"] [aria-label="Maximize pane"]',
        )!;
        await act(async () => maximize.click());
        expect(
          f.container
            .querySelector('[data-pane-id="owner-pane"]')!
            .closest(".maximized-hidden-branch"),
        ).not.toBeNull();
      }
      await act(async () => f.open().click());
      await vi.waitFor(() =>
        expect(
          f.container
            .querySelector('[data-owner-terminal="original-owner"]')
            ?.closest(".workspace-pane")
            ?.classList.contains("active"),
        ).toBe(true),
      );
      expect(
        f.container
          .querySelector('[data-owner-terminal="original-owner"]')!
          .closest(".maximized-hidden-branch"),
      ).toBeNull();
      expect(f.calls).toContainEqual(
        expect.objectContaining({
          url: "/api/tabs/original-owner/active",
          method: "POST",
        }),
      );
      if (location === "other")
        expect(f.workspace().activeWindowId).toBe("lab");
      if (location === "unplaced") {
        const placed = f.calls.find(
          (call) =>
            call.url === "/api/windows/current" && call.method === "PATCH",
        );
        expect(JSON.stringify(placed?.body)).toContain(owner.id);
      }
      expectNoNewExecution(f.calls);
    },
  );

  it("keeps a missing original owner unavailable", async () => {
    const f = await fixture("missing");
    expect(f.open().disabled).toBe(true);
    expectNoNewExecution(f.calls);
  });

  it("distinguishes the reservation execution from the current tab without blocking navigation", async () => {
    const f = await fixture("visible");
    await click(f.container.querySelector(".hardware-panel")!, "Details");
    const details = f.container.querySelector('[aria-label="Hold details"]')!;
    expect(details.textContent).toContain("Reservation execution");
    expect(details.textContent).toContain("reserved-execution");
    expect(details.textContent).toContain("Current tab execution");
    expect(details.textContent).toContain("current-execution");
    expect(f.open().disabled).toBe(false);
  });

  it("resolves the exact owner's current pane after a workspace response changes its placement", async () => {
    const f = await fixture("other", false, true);
    await act(async () => f.open().click());
    await vi.waitFor(() =>
      expect(
        f.container
          .querySelector('[data-owner-terminal="original-owner"]')
          ?.closest(".workspace-pane")
          ?.getAttribute("data-pane-id"),
      ).toBe("moved-owner-pane"),
    );
    expect(
      f.container
        .querySelector('[data-pane-id="moved-owner-pane"]')
        ?.classList.contains("active"),
    ).toBe(true);
    expectNoNewExecution(f.calls);
  });

  it("does not activate or replace an owner that disappears while switching workspaces", async () => {
    const f = await fixture("other", true);
    await act(async () => f.open().click());
    await vi.waitFor(() =>
      expect(f.container.querySelector(".error-banner")?.textContent).toContain(
        "original Hardware owner tab",
      ),
    );
    expect(
      f.calls.some((call) => call.url === "/api/tabs/original-owner/active"),
    ).toBe(false);
    expectNoNewExecution(f.calls);
  });
});
