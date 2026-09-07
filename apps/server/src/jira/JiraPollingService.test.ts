import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { JiraPlugin } from "../plugins/JiraPlugin.js";
import { TriggerRegistry, type TriggerRegistryOptions } from "../triggers/TriggerRegistry.js";
import { JiraRateLimitError } from "./JiraClient.js";
import type { JiraIntegrationService } from "./JiraIntegrationService.js";
import { JiraPollingService } from "./JiraPollingService.js";
import { jiraIssueEventPayload, type JiraCommentSummary, type JiraIssueSummary } from "./JiraIssue.js";

describe("JiraPollingService", () => {
  it("bootstraps state, emits changed issue triggers once, and suppresses duplicates", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-"));
    const events: string[] = [];
    const triggers = jiraTriggers((event) => {
      events.push(event.triggerId);
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: true }),
      pollingAccount: vi.fn().mockResolvedValue({ accountId: "me", configuredEmail: "me@example.com" }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000"), issue("ENG-3", "Open", "old", "2026-06-08T10:01:00.000+0000")])
        .mockResolvedValueOnce([issue("ENG-1", "Done", "new", "2026-06-08T10:05:00.000+0000"), issue("ENG-2", "Open", "new", "2026-06-08T10:06:00.000+0000"), issue("ENG-3", "Open", "old", "2026-06-08T10:07:00.000+0000")])
        .mockResolvedValueOnce([issue("ENG-1", "Done", "new", "2026-06-08T10:05:00.000+0000"), issue("ENG-2", "Open", "new", "2026-06-08T10:06:00.000+0000"), issue("ENG-3", "Open", "old", "2026-06-08T10:07:00.000+0000")]),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await expect(polling.runOnce()).resolves.toMatchObject({ initialized: false, scanned: 2, emitted: [] });
    await expect(polling.runOnce()).resolves.toMatchObject({
      initialized: true,
      scanned: 3,
      emitted: ["jira.issueTransitioned", "jira.issueNewlyAssigned", "jira.issueCreated", "jira.issueUpdated"]
    });
    await expect(polling.runOnce()).resolves.toMatchObject({ initialized: true, emitted: [] });
    expect(events).toEqual(["jira.issueTransitioned", "jira.issueNewlyAssigned", "jira.issueCreated", "jira.issueUpdated"]);
  });

  it("emits a targeted assigned-to-me trigger for new and newly assigned issues", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-assigned-to-me-"));
    const payloads: Record<string, unknown>[] = [];
    const triggers = jiraTriggers((event) => {
      payloads.push({ triggerId: event.triggerId, ...event.payload });
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: true }),
      pollingAccount: vi.fn().mockResolvedValue({ accountId: "me", emailAddress: "david@example.com", configuredEmail: "david@example.com" }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000", "old@example.com"), issue("ENG-3", "Open", "old", "2026-06-08T10:01:00.000+0000", "old@example.com")])
        .mockResolvedValueOnce([issue("ENG-1", "Open", "me", "2026-06-08T10:05:00.000+0000", "david@example.com"), issue("ENG-2", "Open", "me", "2026-06-08T10:06:00.000+0000", "david@example.com"), issue("ENG-3", "Open", "old", "2026-06-08T10:07:00.000+0000", "old@example.com")]),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await polling.runOnce();
    await expect(polling.runOnce()).resolves.toMatchObject({
      emitted: ["jira.issueUpdated", "jira.issueNewlyAssigned", "jira.issueAssignedToMe", "jira.issueCreated", "jira.issueAssignedToMe", "jira.issueUpdated"]
    });

    expect(payloads.filter((payload) => payload.triggerId === "jira.issueAssignedToMe")).toEqual([
      expect.objectContaining({
        issueKey: "ENG-1",
        assigneeAccountId: "me",
        assigneeMatchedAccountId: "me",
        previousAssigneeAccountId: "old"
      }),
      expect.objectContaining({
        issueKey: "ENG-2",
        assigneeAccountId: "me",
        assigneeMatchedAccountId: "me"
      })
    ]);
  });

  it("detects new comments with scalar trigger payload fields", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-comments-"));
    const payloads: Record<string, unknown>[] = [];
    const triggers = jiraTriggers((event) => {
      if (event.triggerId === "jira.commentCreated") {
        payloads.push(event.payload);
      }
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: true, assignmentsEnabled: false }),
      pollingIssues: vi.fn().mockResolvedValue([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000")]),
      pollingComments: vi.fn()
        .mockResolvedValueOnce([comment("1", "First")])
        .mockResolvedValueOnce([comment("1", "First"), comment("2", "Second")])
        .mockResolvedValueOnce([comment("1", "First"), comment("2", "Second")])
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await polling.runOnce();
    await expect(polling.runOnce()).resolves.toMatchObject({ emitted: ["jira.commentCreated"], emittedEventCount: 1 });
    await expect(polling.runOnce()).resolves.toMatchObject({ emitted: [] });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      eventType: "jira.commentCreated",
      issueKey: "ENG-1",
      commentId: "2",
      commentUrl: "https://example.atlassian.net/browse/ENG-1?focusedCommentId=2"
    });
    expect(JSON.stringify(payloads[0])).not.toContain("Second");
    expect(payloads[0]).not.toHaveProperty("comment");
    expect(payloads[0]).not.toHaveProperty("commentBody");
  });

  it("persists minimal Jira trigger payloads without raw Jira records or email addresses", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-minimal-payload-"));
    const payloads: Record<string, unknown>[] = [];
    const triggers = jiraTriggers((event) => {
      payloads.push(event.payload);
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: true, assignmentsEnabled: true }),
      pollingAccount: vi.fn().mockResolvedValue({ accountId: "me", emailAddress: "david@example.com", configuredEmail: "david@example.com" }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000", "old@example.com")])
        .mockResolvedValueOnce([issue("ENG-1", "Open", "me", "2026-06-08T10:05:00.000+0000", "david@example.com")]),
      pollingComments: vi.fn()
        .mockResolvedValueOnce([comment("1", "First private comment")])
        .mockResolvedValueOnce([comment("1", "First private comment"), comment("2", "Second private comment")])
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await polling.runOnce();
    await polling.runOnce();

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("david@example.com");
    expect(serialized).not.toContain("old@example.com");
    expect(serialized).not.toContain("private comment");
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty("issue");
      expect(payload).not.toHaveProperty("comment");
      expect(payload).not.toHaveProperty("commentBody");
      expect(payload).not.toHaveProperty("assigneeEmailAddress");
    }
  });

  it("keeps prior issue snapshots outside the current polling result window", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-window-"));
    const events: string[] = [];
    const triggers = jiraTriggers((event) => {
      events.push(`${event.triggerId}:${String(event.payload.issueKey)}`);
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000")])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:05:00.000+0000")]),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await polling.runOnce();
    await expect(polling.runOnce()).resolves.toMatchObject({ emitted: [] });
    await expect(polling.runOnce()).resolves.toMatchObject({ emitted: ["jira.issueUpdated"] });
    expect(events).toEqual(["jira.issueUpdated:ENG-1"]);
  });

  it("does not emit partial triggers when a later Jira comment fetch is rate-limited", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-partial-rate-limit-"));
    const events: string[] = [];
    const triggers = jiraTriggers((event) => {
      events.push(`${event.triggerId}:${String(event.payload.issueKey)}`);
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: true, assignmentsEnabled: false }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000"), issue("ENG-2", "Open", "old", "2026-06-08T10:00:00.000+0000")])
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:05:00.000+0000"), issue("ENG-2", "Open", "old", "2026-06-08T10:00:00.000+0000")])
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:05:00.000+0000"), issue("ENG-2", "Open", "old", "2026-06-08T10:00:00.000+0000")]),
      pollingComments: vi.fn()
        .mockResolvedValueOnce([comment("1", "First")])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([comment("1", "First"), comment("2", "Second")])
        .mockRejectedValueOnce(new JiraRateLimitError("Jira rate limit exceeded.", 0, "cost"))
        .mockResolvedValueOnce([comment("1", "First"), comment("2", "Second")])
        .mockResolvedValueOnce([])
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await polling.runOnce();
    await expect(polling.runOnce()).resolves.toMatchObject({ skipped: true, reason: "rate_limited" });
    expect(events).toEqual([]);

    await expect(polling.runOnce()).resolves.toMatchObject({
      emitted: ["jira.issueUpdated", "jira.commentCreated"]
    });
    expect(events).toEqual(["jira.issueUpdated:ENG-1", "jira.commentCreated:ENG-1"]);
  });

  it("skips disabled, interval-blocked, and rate-limited polling runs", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-skip-"));
    const triggers = jiraTriggers();
    const integration = {
      configured: () => true,
      pollingConfig: vi.fn()
        .mockReturnValueOnce({ enabled: false, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: true })
        .mockReturnValue({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: true }),
      pollingAccount: vi.fn().mockResolvedValue({ accountId: "me", configuredEmail: "me@example.com" }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000")])
        .mockRejectedValueOnce(new JiraRateLimitError("Jira rate limit exceeded.", 60, "cost")),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => triggers);

    await expect(polling.runIfEnabled()).resolves.toMatchObject({ skipped: true, reason: "disabled" });
    await expect(polling.runOnce()).resolves.toMatchObject({ initialized: false });
    await expect(polling.runIfEnabled()).resolves.toMatchObject({ skipped: true, reason: "interval" });
    await expect(polling.runOnce()).resolves.toMatchObject({ skipped: true, reason: "rate_limited", nextAllowedPollAt: expect.any(String) });
    await expect(polling.runIfEnabled()).resolves.toMatchObject({ skipped: true, reason: "rate_limited", nextAllowedPollAt: expect.any(String) });
  });

  it("resumes a crash-window outbox with stable idempotency keys and a committed checkpoint", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-outbox-"));
    const pluginData = new PluginDataStore(dataDir);
    const delivered: Array<{ triggerId: string; eventId: string }> = [];
    const triggers = jiraTriggers((event) => {
      delivered.push({ triggerId: event.triggerId, eventId: String(event.payload.eventId) });
    });
    const currentIssues = [
      issue("ENG-1", "Done", "old", "2026-06-08T10:05:00.000+0000"),
      issue("ENG-2", "Open", "old", "2026-06-08T10:06:00.000+0000")
    ];
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([
          issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000"),
          issue("ENG-2", "Open", "old", "2026-06-08T10:00:00.000+0000")
        ])
        .mockResolvedValue(currentIssues),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, pluginData, () => triggers);
    await polling.runOnce();

    const originalWrite = pluginData.write.bind(pluginData);
    let dispatchStarted = false;
    let failedCheckpoint = false;
    const write = vi.spyOn(pluginData, "write").mockImplementation(async (pluginId, value) => {
      const outbox = isRecord(value) && Array.isArray(value.outbox) ? value.outbox : [];
      dispatchStarted ||= outbox.some((entry) => isRecord(entry) && entry.status === "dispatching");
      if (!failedCheckpoint && dispatchStarted && outbox.length === 1) {
        failedCheckpoint = true;
        throw new Error("simulated crash before outbox acknowledgement");
      }
      await originalWrite(pluginId, value);
    });

    await expect(polling.runOnce()).rejects.toThrow("simulated crash before outbox acknowledgement");
    write.mockRestore();
    const resumed = new JiraPollingService(integration, pluginData, () => triggers);
    await expect(resumed.runOnce()).resolves.toMatchObject({
      emitted: ["jira.issueTransitioned", "jira.issueUpdated"]
    });

    expect(delivered.map((event) => event.triggerId)).toEqual([
      "jira.issueTransitioned",
      "jira.issueTransitioned",
      "jira.issueUpdated"
    ]);
    expect(delivered[0]!.eventId).toBe(delivered[1]!.eventId);
    const stored = await pluginData.read("jira");
    expect(stored).toMatchObject({
      issues: {
        "ENG-1": { status: "Done" },
        "ENG-2": { status: "Open", updated: "2026-06-08T10:06:00.000+0000" }
      },
      outbox: []
    });
  });

  it("persists controlled outbox failures and does not retry them", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-outbox-failed-"));
    const pluginData = new PluginDataStore(dataDir);
    let emitAttempts = 0;
    const triggers = jiraTriggers(() => {
      emitAttempts += 1;
      throw new Error("automation claim store unavailable");
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn()
        .mockResolvedValueOnce([issue("ENG-1", "Open", "old", "2026-06-08T10:00:00.000+0000")])
        .mockResolvedValue([issue("ENG-1", "Done", "old", "2026-06-08T10:05:00.000+0000")]),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, pluginData, () => triggers);
    await polling.runOnce();

    await expect(polling.runOnce()).rejects.toThrow("automation claim store unavailable");
    await expect(polling.runOnce()).rejects.toThrow(/Jira polling outbox event .* is failed and requires explicit operator resolution/);

    expect(emitAttempts).toBe(1);
    expect(integration.pollingIssues).toHaveBeenCalledTimes(2);
    expect(await pluginData.read("jira")).toMatchObject({
      outbox: [expect.objectContaining({ status: "failed", lastError: "automation claim store unavailable" })]
    });
  });

  it.each([
    ["missing idempotency key", { payload: { eventId: "event-1" } }],
    ["blank idempotency key", { idempotencyKey: "", payload: { eventId: "event-1" } }],
    ["whitespace idempotency key", { idempotencyKey: "   ", payload: { eventId: "event-1" } }],
    ["missing payload event id", { idempotencyKey: "event-1", payload: {} }],
    ["blank payload event id", { idempotencyKey: "event-1", payload: { eventId: " " } }],
    ["mismatched identity", { idempotencyKey: "event-1", payload: { eventId: "event-2" } }]
  ])("rejects persisted outbox state with %s before polling or mutation", async (_name, identity) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-invalid-outbox-"));
    const pluginData = new PluginDataStore(dataDir);
    await pluginData.write("jira", {
      initialized: true,
      issues: { "ENG-1": { status: "Open" } },
      outbox: [{
        triggerId: "jira.issueUpdated",
        status: "failed",
        preparedAt: new Date(0).toISOString(),
        ...identity
      }]
    });
    const write = vi.spyOn(pluginData, "write");
    const triggers = jiraTriggers();
    const emit = vi.spyOn(triggers, "emit");
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn(),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, pluginData, () => triggers);

    await expect(polling.runOnce()).rejects.toThrow("Jira polling outbox state is invalid");

    expect(emit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(integration.pollingIssues).not.toHaveBeenCalled();
  });

  it("inspects, retries, and discards failed outbox items only through explicit operator actions", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-operator-"));
    const pluginData = new PluginDataStore(dataDir);
    const first = failedOutboxEvent("event-1", "jira.issueUpdated", "first failure ".repeat(100));
    const second = failedOutboxEvent("event-2", "jira.issueTransitioned", "second failure");
    await pluginData.write("jira", {
      initialized: true,
      issues: { "ENG-1": { status: "Done", updated: "checkpoint" } },
      outbox: [first, second]
    });
    const delivered: string[] = [];
    const triggers = jiraTriggers((event) => {
      delivered.push(event.id);
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn().mockResolvedValue([]),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, pluginData, () => triggers);

    const inspected = await polling.inspectOutbox();
    expect(inspected).toEqual([
      expect.objectContaining({ idempotencyKey: "event-1", triggerId: "jira.issueUpdated", status: "failed" }),
      expect.objectContaining({ idempotencyKey: "event-2", triggerId: "jira.issueTransitioned", status: "failed" })
    ]);
    expect(inspected[0]).not.toHaveProperty("payload");
    expect(inspected[0]!.lastError!.length).toBeLessThanOrEqual(512);

    await expect(polling.retryFailedOutbox("event-1")).resolves.toMatchObject({ idempotencyKey: "event-1", status: "prepared" });
    expect(delivered).toEqual([]);
    await expect(polling.retryFailedOutbox("event-2")).resolves.toMatchObject({ idempotencyKey: "event-2", status: "prepared" });
    await expect(polling.discardFailedOutbox("event-2")).rejects.toThrow("is not failed");
    await expect(polling.retryFailedOutbox("missing")).rejects.toThrow("Unknown Jira polling outbox event");

    await pluginData.write("jira", {
      initialized: true,
      issues: { "ENG-1": { status: "Done", updated: "checkpoint" } },
      outbox: [first, second]
    });
    await expect(polling.discardFailedOutbox("event-2")).resolves.toMatchObject({ idempotencyKey: "event-2", status: "failed" });
    const afterDiscard = await pluginData.read("jira");
    expect(afterDiscard).toMatchObject({
      issues: { "ENG-1": { status: "Done", updated: "checkpoint" } },
      outbox: [expect.objectContaining({ idempotencyKey: "event-1" })]
    });
    await polling.retryFailedOutbox("event-1");
    await expect(polling.runOnce()).resolves.toMatchObject({ emitted: ["jira.issueUpdated"] });
    expect(delivered).toEqual(["plugin:jira:jira.issueUpdated:event-1"]);

    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    await expect(polling.inspectOutbox(controller.signal)).rejects.toThrow("operator cancelled");
    await expect(polling.retryFailedOutbox("event-1", controller.signal)).rejects.toThrow("operator cancelled");
    await expect(polling.discardFailedOutbox("event-1", controller.signal)).rejects.toThrow("operator cancelled");
  });

  it("serializes concurrent retry and discard against the latest durable Jira state", async () => {
    const first = failedOutboxEvent("event-1", "jira.issueUpdated", "first failure");
    const second = failedOutboxEvent("event-2", "jira.issueTransitioned", "second failure");
    let durable: Record<string, unknown> = {
      initialized: true,
      issues: { "ENG-1": { status: "Done", updated: "checkpoint" } },
      lastSuccessfulPollAt: "2026-08-16T00:00:00.000Z",
      outbox: [first, second],
    };
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writeCount = 0;
    const pluginData = {
      read: vi.fn(async () => structuredClone(durable)),
      write: vi.fn(async (_pluginId: string, value: Record<string, unknown>) => {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
        durable = structuredClone(value);
      }),
    } as unknown as PluginDataStore;
    const polling = new JiraPollingService({} as JiraIntegrationService, pluginData, () => jiraTriggers());

    const retry = polling.retryFailedOutbox("event-1");
    const discard = polling.discardFailedOutbox("event-2");
    await firstWriteStarted.promise;
    await Promise.resolve();
    const secondWriteStartedBeforeFirstSettled = writeCount > 1;
    releaseFirstWrite.resolve();
    await Promise.all([retry, discard]);

    expect(secondWriteStartedBeforeFirstSettled).toBe(false);
    expect(durable).toMatchObject({
      issues: { "ENG-1": { status: "Done", updated: "checkpoint" } },
      lastSuccessfulPollAt: "2026-08-16T00:00:00.000Z",
      outbox: [expect.objectContaining({ idempotencyKey: "event-1", status: "prepared" })],
    });
  });

  it("serializes a failed poll dispatch before a concurrent operator retry", async () => {
    const target = { ...failedOutboxEvent("event-1", "jira.issueUpdated", "target failure"), status: "prepared" };
    const unrelated = { ...failedOutboxEvent("event-2", "jira.issueTransitioned", "unrelated failure"), status: "prepared" };
    Reflect.deleteProperty(target, "lastError");
    Reflect.deleteProperty(unrelated, "lastError");
    const issues = {
      "ENG-1": {
        updated: "2026-08-16T00:00:00.000Z",
        status: "Done",
        assigneeAccountId: "me",
        commentIds: ["comment-1"],
        lastSeenAt: "2026-08-16T00:01:00.000Z",
      },
    };
    const lastSuccessfulPollAt = "2026-08-16T00:02:00.000Z";
    let durable: Record<string, unknown> = {
      initialized: true,
      issues,
      lastSuccessfulPollAt,
      outbox: [target, unrelated],
    };
    const pluginData = {
      read: vi.fn(async () => structuredClone(durable)),
      write: vi.fn(async (_pluginId: string, value: Record<string, unknown>) => {
        durable = structuredClone(value);
      }),
    } as unknown as PluginDataStore;
    const dispatchStarted = deferred<void>();
    const releaseDispatch = deferred<void>();
    const triggers = jiraTriggers(async () => {
      dispatchStarted.resolve();
      await releaseDispatch.promise;
      throw new Error("controlled outbox delivery failure");
    });
    const integration = { pollingIssues: vi.fn() } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, pluginData, () => triggers);

    const pollFailure = expect(polling.runOnce()).rejects.toThrow("controlled outbox delivery failure");
    await dispatchStarted.promise;
    expect(durable).toMatchObject({
      outbox: [expect.objectContaining({ idempotencyKey: "event-1", status: "dispatching" }), expect.objectContaining({ idempotencyKey: "event-2", status: "prepared" })],
    });

    let retrySettled = false;
    const retryOutcome = polling.retryFailedOutbox("event-1").then(
      (value) => {
        retrySettled = true;
        return { state: "resolved", value } as const;
      },
      (error: unknown) => {
        retrySettled = true;
        return { state: "rejected", error } as const;
      },
    );
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    expect(pluginData.read).toHaveBeenCalledTimes(1);

    releaseDispatch.resolve();
    await pollFailure;
    await expect(retryOutcome).resolves.toMatchObject({
      state: "resolved",
      value: { idempotencyKey: "event-1", status: "prepared" },
    });

    expect(durable).toMatchObject({ initialized: true, issues, lastSuccessfulPollAt });
    expect(durable.outbox).toEqual([
      {
        idempotencyKey: target.idempotencyKey,
        triggerId: target.triggerId,
        payload: target.payload,
        status: "prepared",
        preparedAt: target.preparedAt,
      },
      { ...unrelated, dispatchStartedAt: undefined, lastError: undefined },
    ]);
    expect(pluginData.read).toHaveBeenCalledTimes(2);
    expect(integration.pollingIssues).not.toHaveBeenCalled();
  });

  it("closes Jira mutation admission and awaits an already admitted operator write", async () => {
    const first = failedOutboxEvent("event-1", "jira.issueUpdated", "first failure");
    let durable: Record<string, unknown> = { initialized: true, outbox: [first] };
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const pluginData = {
      read: vi.fn(async () => structuredClone(durable)),
      write: vi.fn(async (_pluginId: string, value: Record<string, unknown>) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        durable = structuredClone(value);
      }),
    } as unknown as PluginDataStore;
    const polling = new JiraPollingService({} as JiraIntegrationService, pluginData, () => jiraTriggers());
    const mutation = polling.retryFailedOutbox("event-1");
    await writeStarted.promise;

    let disposed = false;
    const disposal = polling.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseWrite.resolve();
    await Promise.all([mutation, disposal]);
    await expect(polling.retryFailedOutbox("event-1")).rejects.toThrow(/disposed/i);
    await expect(polling.discardFailedOutbox("event-1")).rejects.toThrow(/disposed/i);
  });

  it("aborts an in-flight poll from the automation execution signal", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-automation-abort-"));
    let receivedSignal: AbortSignal | undefined;
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn((signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => jiraTriggers());
    const controller = new AbortController();
    const run = polling.runOnce(controller.signal);
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    controller.abort(new Error("automation cancelled"));

    await expect(run).rejects.toThrow("automation cancelled");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts and awaits an in-flight poll during disposal", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-polling-dispose-"));
    let receivedSignal: AbortSignal | undefined;
    let releaseAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const integration = {
      configured: () => true,
      pollingConfig: () => ({ enabled: true, intervalSeconds: 300, jql: "", maxIssues: 10, commentsEnabled: false, assignmentsEnabled: false }),
      pollingIssues: vi.fn(async (signal?: AbortSignal) => {
        receivedSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            releaseAbort();
            reject(signal.reason);
          }, { once: true });
        });
        return [];
      }),
      pollingComments: vi.fn()
    } as unknown as JiraIntegrationService;
    const polling = new JiraPollingService(integration, new PluginDataStore(dataDir), () => jiraTriggers());
    const run = polling.runOnce();
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    const disposal = polling.dispose();

    await aborted;
    expect(receivedSignal?.aborted).toBe(true);
    await expect(disposal).resolves.toBeUndefined();
    await expect(run).resolves.toMatchObject({ skipped: true, reason: "disposed" });
    await expect(polling.runOnce()).resolves.toMatchObject({ skipped: true, reason: "disposed" });
  });
});

function jiraTriggers(recordEvent?: TriggerRegistryOptions["recordEvent"]): TriggerRegistry {
  const triggers = new TriggerRegistry(recordEvent ? { recordEvent } : {});
  for (const trigger of new JiraPlugin(unavailableService, () => undefined).triggers) {
    triggers.register(trigger);
  }
  return triggers;
}

function failedOutboxEvent(eventId: string, triggerId: string, lastError: string) {
  return {
    idempotencyKey: eventId,
    triggerId,
    payload: {
      ...jiraIssueEventPayload(triggerId, issue("ENG-1", "Done", "me", "2026-06-08T10:05:00.000+0000"), new Date(0).toISOString()),
      eventId
    },
    status: "failed",
    preparedAt: new Date(0).toISOString(),
    lastError
  };
}

function issue(key: string, status: string, assigneeAccountId: string, updated: string, assigneeEmailAddress?: string): JiraIssueSummary {
  return {
    id: key,
    key,
    siteUrl: "https://example.atlassian.net",
    url: `https://example.atlassian.net/browse/${key}`,
    summary: key,
    issueType: "Task",
    isEpic: false,
    status,
    priorityRank: 3,
    assignee: { accountId: assigneeAccountId, displayName: assigneeAccountId, emailAddress: assigneeEmailAddress },
    labels: [],
    updated,
    raw: {}
  };
}

function comment(id: string, bodyText: string): JiraCommentSummary {
  return {
    id,
    bodyText,
    author: { accountId: "commenter", displayName: "Commenter" },
    url: `https://example.atlassian.net/browse/ENG-1?focusedCommentId=${id}`,
    raw: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve as (value?: T) => void;
  });
  return { promise, resolve };
}

function unavailableService(): never {
  throw new Error("service unavailable");
}
