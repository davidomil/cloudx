import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HardwareSummary, OperationReceipt } from "@cloudx/shared";
import { Observation, ReceiptView } from "./HardwareControls.js";
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
          source: "printf true",
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
          errorCode: "INVALID_STATUS_JSON",
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
    ).toContain("Error: INVALID_STATUS_JSON");
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
