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
import type { JiraCommentSummary, JiraIssueSummary } from "./JiraIssue.js";

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
        assigneeEmailAddress: "david@example.com",
        assigneeMatchedEmailAddress: "david@example.com",
        previousAssigneeAccountId: "old"
      }),
      expect.objectContaining({
        issueKey: "ENG-2",
        assigneeAccountId: "me",
        assigneeEmailAddress: "david@example.com",
        assigneeMatchedEmailAddress: "david@example.com"
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
});

function jiraTriggers(recordEvent?: TriggerRegistryOptions["recordEvent"]): TriggerRegistry {
  const triggers = new TriggerRegistry(recordEvent ? { recordEvent } : {});
  for (const trigger of new JiraPlugin(unavailableService, () => undefined).triggers) {
    triggers.register(trigger);
  }
  return triggers;
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

function unavailableService(): never {
  throw new Error("service unavailable");
}
