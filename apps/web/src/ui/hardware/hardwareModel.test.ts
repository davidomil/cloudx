import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HardwareItem,
  HardwareOwner,
  HardwareSummary,
  StatusDefinition,
} from "@cloudx/shared";
import { editableHardware } from "./HardwareEditor.js";
import {
  matchesHardware,
  newStatusBinding,
  ownerLabel,
  sameOwner,
  uartBytes,
  uartText,
} from "./hardwareModel.js";

const user: HardwareOwner = { kind: "user", userId: "local" };
const item: HardwareItem = {
  id: "target",
  revision: 4,
  notesRevision: 2,
  name: "ARM target",
  description: "Lab SSH",
  notes: "Do not reboot",
  enabled: true,
  physicalResourceId: "rack-1",
  typeId: "hardware.ssh",
  configVersion: 1,
  config: {},
  tagIds: ["arm", "linux"],
  statuses: [],
  hooks: {},
};
const summary: HardwareSummary = {
  item,
  observations: [
    {
      definitionId: "busy",
      bindingRevision: 1,
      state: "known",
      value: false,
      observedAt: "2026-11-03T00:00:00.000Z",
      expiresAt: "2026-11-03T00:01:00.000Z",
    },
  ],
  availability: "available",
  blockers: [],
  reservation: null,
};
const boolean: StatusDefinition = {
  id: "busy",
  revision: 1,
  label: "Busy",
  valueType: "boolean",
};
afterEach(() => vi.useRealTimers());

describe("Hardware view decisions", () => {
  it("names the exact retained owning tab", () => {
    const owner: HardwareOwner = {
      kind: "agent",
      tabId: "owner",
      providerId: "codex",
      executionId: "original",
    };
    expect(
      ownerLabel(owner, [
        { id: "other", title: "Different investigation" },
        { id: "owner", title: "Camera bring-up" },
      ]),
    ).toBe("Codex · Camera bring-up");
    expect(ownerLabel(owner, [])).toBe("Codex · owner");
  });

  it("compares exact execution and worker identities regardless of key insertion order", () => {
    const owner: HardwareOwner = {
      kind: "agent",
      tabId: "tab",
      executionId: "exec",
      providerId: "claude",
      ownerPluginId: "forge",
      logicalRunId: "run",
      workerId: "worker",
      attemptId: "one",
    };
    expect(sameOwner(owner, { ...owner, kind: "agent" })).toBe(true);
    expect(sameOwner(owner, { ...owner, executionId: "replacement" })).toBe(
      false,
    );
    expect(sameOwner(owner, { ...owner, attemptId: "two" })).toBe(false);
    expect(sameOwner(user, { userId: "local", kind: "user" })).toBe(true);
    expect(sameOwner(owner, user)).toBe(false);
    expect(ownerLabel(owner)).toContain("worker worker · attempt one");
    expect(ownerLabel(user)).toBe("You");
  });

  it("filters tags with all, any, and none plus text, enabled, type and ownership", () => {
    expect(
      matchesHardware(
        summary,
        {
          text: "REBOOT",
          typeIds: ["hardware.ssh"],
          tags: {
            all: ["arm", "linux"],
            any: ["missing", "arm"],
            none: ["unrelated"],
          },
          availability: "available",
          enabled: true,
        },
        user,
      ),
    ).toBe(true);
    for (const filter of [
      { text: "absent" },
      { typeIds: ["hardware.uart"] },
      { tags: { all: ["missing"] } },
      { tags: { any: ["missing"] } },
      { tags: { none: ["arm"] } },
      { availability: "held" as const },
      { enabled: false },
      { ownedByMe: true },
    ])
      expect(matchesHardware(summary, filter, user)).toBe(false);
  });

  it("matches a fresh false status exactly and excludes stale, unknown and error observations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T00:00:30.000Z"));
    const filter = {
      statuses: [{ definitionId: "busy", equals: false, requireFresh: true }],
    };
    expect(matchesHardware(summary, filter, user)).toBe(true);
    expect(
      matchesHardware(
        summary,
        {
          statuses: [
            { definitionId: "busy", equals: "false", requireFresh: true },
          ],
        },
        user,
      ),
    ).toBe(false);
    expect(
      matchesHardware({ ...summary, observations: [] }, filter, user),
    ).toBe(false);
    expect(
      matchesHardware(
        {
          ...summary,
          observations: [{ ...summary.observations[0]!, state: "error" }],
        },
        filter,
        user,
      ),
    ).toBe(false);
    vi.setSystemTime(new Date("2026-11-03T00:01:00.000Z"));
    expect(matchesHardware(summary, filter, user)).toBe(false);
  });

  it("keeps server-owned revisions out of editable drafts and clones nested configuration", () => {
    const draft = editableHardware(item);
    expect(draft).not.toHaveProperty("id");
    expect(draft).not.toHaveProperty("revision");
    expect(draft).not.toHaveProperty("notesRevision");
    draft.config.changed = true;
    expect(item.config).toEqual({});
    expect(newStatusBinding(boolean)).toMatchObject({
      source: "manual",
      value: false,
    });
    expect(
      newStatusBinding({
        ...boolean,
        valueType: "enum",
        enumValues: ["ready", "blocked"],
      }),
    ).toMatchObject({ value: "ready" });
  });

  it("encodes UTF-8 UART bytes with explicit endings and never adds bytes to base64 mode", () => {
    expect(uartText(uartBytes("µ boot", "text", "CRLF"))).toBe("µ boot\r\n");
    expect(uartText(uartBytes("x", "text", "none"))).toBe("x");
    expect(uartBytes("AAE=", "base64", "CRLF")).toBe("AAE=");
    expect(() => uartBytes("not-base64!", "base64", "none")).toThrow();
  });
});
