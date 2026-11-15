import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareSummary, OperationReceipt } from "@cloudx/shared";
import {
  Observation,
  ReceiptView,
  SshConnectionStatus,
} from "./HardwareControls.js";
import { HardwareReadiness } from "./HardwareReadiness.js";

const summary: HardwareSummary = {
  item: {
    id: "target",
    revision: 1,
    notesRevision: 1,
    name: "Target",
    description: "",
    notes: "",
    enabled: true,
    physicalResourceId: "rack",
    typeId: "hardware.ssh",
    configVersion: 1,
    config: {},
    tagIds: [],
    statuses: [
      {
        revision: 1,
        definitionId: "up",
        source: "command",
        script: {
          source: "false",
          cwd: "/lab",
          timeoutMs: 1000,
          maxOutputBytes: 100,
          credentialRefIds: [],
        },
        maxAgeMs: 60000,
        intervalMs: 30000,
      },
    ],
    hooks: {},
  },
  observations: [
    {
      definitionId: "up",
      bindingRevision: 1,
      state: "known",
      value: false,
      observedAt: "2026-11-03T00:00:00Z",
      expiresAt: "2026-11-03T00:01:00Z",
    },
  ],
  reservation: null,
  blockers: [],
  availability: "available",
};
afterEach(() => vi.useRealTimers());

describe("Hardware operation and observation views", () => {
  it("keeps SSH login state separate from reservation availability and rejects old item measurements", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T00:00:15Z"));
    const connectionCheck = {
      online: true,
      itemRevision: 1,
      checkedAt: "2026-11-15T00:00:00Z",
      expiresAt: "2026-11-15T00:01:00Z",
    };
    const render = (value: HardwareSummary) =>
      renderToStaticMarkup(
        createElement(SshConnectionStatus, { summary: value, detailed: true }),
      );
    expect(render({ ...summary, connectionCheck })).toContain(
      "SSH login: Online",
    );
    expect(render({ ...summary, connectionCheck })).toContain("60 seconds");
    expect(
      render({
        ...summary,
        item: { ...summary.item, revision: 2 },
        connectionCheck,
      }),
    ).toContain("Unknown");
    expect(
      render({
        ...summary,
        item: { ...summary.item, revision: 2 },
        connectionCheck,
      }),
    ).not.toContain("SSH login: Online");
    vi.setSystemTime(new Date("2026-11-15T00:02:00Z"));
    expect(render({ ...summary, connectionCheck })).toContain("stale");
    expect(
      render({
        ...summary,
        connectionCheck: {
          ...connectionCheck,
          online: false,
          error: {
            code: "SSH_AUTH_FAILED",
            message: "Password authentication was rejected.",
          },
        },
      }),
    ).toContain("SSH login: Failed");
    expect(
      render({
        ...summary,
        connectionCheck: {
          ...connectionCheck,
          online: false,
          error: {
            code: "SSH_AUTH_FAILED",
            message: "Password authentication was rejected.",
          },
        },
      }),
    ).toContain("Password authentication was rejected.");
    expect(
      render({
        ...summary,
        item: { ...summary.item, typeId: "hardware.uart" },
      }),
    ).toBe("");
  });

  it("shows SSH login check progress, held pause and explicit automatic opt-out", () => {
    const checkHold = {
      kind: "system_check" as const,
      runId: "probe",
      revision: 1,
      generation: 1,
      hardwareId: summary.item.id,
      resourceKeys: [],
      state: "checking" as const,
      bindingRevisions: [],
      connectionCheck: { itemRevision: 1 },
      startedAt: "2026-11-15T00:00:00Z",
    };
    const render = (value: HardwareSummary) =>
      renderToStaticMarkup(
        createElement(SshConnectionStatus, { summary: value, detailed: true }),
      );
    expect(render({ ...summary, checkHold })).toContain("Checking SSH login");
    expect(
      render({
        ...summary,
        checkHold: { ...checkHold, connectionCheck: undefined },
      }),
    ).toContain("paused while group is held");
    expect(
      render({
        ...summary,
        item: { ...summary.item, config: { onlineCheckIntervalMs: null } },
      }),
    ).toContain("Automatic checks disabled");
  });

  it("preserves a succeeded outcome when retained output has been pruned", () => {
    const receipt: OperationReceipt = {
      requestId: "original",
      runId: "run",
      state: "succeeded",
      startedAt: "2026-11-03T00:00:00Z",
      finishedAt: "2026-11-03T00:00:01Z",
      outputPruned: { at: "2026-11-03T00:01:00Z", reason: "budget" },
    };
    const html = renderToStaticMarkup(createElement(ReceiptView, { receipt }));
    expect(html).toContain("succeeded");
    expect(html).toContain(
      "Output pruned; the original operation will not run again.",
    );
    expect(html).toContain("budget");
    expect(html).not.toContain("Operation pending");
  });

  it("shows pending and unknown outcomes without inventing completed work", () => {
    const receipt: OperationReceipt = {
      requestId: "original",
      runId: "run",
      state: "running",
      startedAt: "2026-11-03T00:00:00Z",
    };
    expect(
      renderToStaticMarkup(createElement(ReceiptView, { receipt })),
    ).toContain("Operation pending");
    const html = renderToStaticMarkup(
      createElement(ReceiptView, {
        receipt: {
          ...receipt,
          state: "unknown",
          error: {
            code: "OUTCOME_UNKNOWN",
            message: "Remote result is missing.",
          },
        },
      }),
    );
    expect(html).toContain("Remote result is missing.");
    expect(html).not.toContain("succeeded");
  });

  it("shows exact false values, source, freshness, errors and next-check information", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T00:00:15Z"));
    const html = renderToStaticMarkup(
      createElement(Observation, {
        summary,
        definitionId: "up",
        detailed: true,
      }),
    );
    expect(html).toContain("false · fresh");
    expect(html).toContain("Source: command");
    expect(html).toContain("Observed:");
    expect(html).toContain("Next check:");
    vi.setSystemTime(new Date("2026-11-03T00:02:00Z"));
    expect(
      renderToStaticMarkup(
        createElement(Observation, { summary, definitionId: "up" }),
      ),
    ).toContain("false · stale");
    const failed = {
      ...summary,
      observations: [
        {
          ...summary.observations[0]!,
          state: "error" as const,
          value: undefined,
          errorCode: "SPAWN_FAILED",
        },
      ],
    };
    expect(
      renderToStaticMarkup(
        createElement(Observation, {
          summary: failed,
          definitionId: "up",
          detailed: true,
        }),
      ),
    ).toContain("Error: SPAWN_FAILED");
  });

  it("shows execution readiness only when a live execution needs attention", () => {
    expect(
      renderToStaticMarkup(
        createElement(HardwareReadiness, {
          executions: [],
          canOpenOwner: () => false,
        }),
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      createElement(HardwareReadiness, {
        executions: [
          {
            tabId: "old",
            providerId: "codex",
            state: "relaunch_required",
            reason: "Missing helper environment.",
          },
        ],
        canOpenOwner: () => false,
      }),
    );
    expect(html).toContain("Relaunch required");
    expect(html).toContain("Missing helper environment.");
    expect(html).toContain("disabled");
  });
});
