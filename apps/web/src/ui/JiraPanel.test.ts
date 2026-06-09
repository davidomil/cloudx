// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { JiraPanel } from "./JiraPanel.js";
import { JIRA_ISSUE_MANUAL_TRIGGER_ID } from "./automationTriggers.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

describe("JiraPanel", () => {
  it("loads grouped issues and displays selected issue comments and transitions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: string[] = [];
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push(`${hookId}:${input.issueIdOrKey ?? ""}`);
      if (hookId === "jira.dashboard.list") {
        return {
          jql: "assignee = currentUser()",
          sortBy: "priority_desc_updated_desc",
          groupBy: "epic",
          issues: [{ key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" }],
          groups: [
            {
              id: "ENG-1",
              title: "ENG-1 Platform Epic",
              issues: [{ key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" }]
            }
          ]
        } as unknown as T;
      }
      if (hookId === "jira.issue.get") {
        return {
          issue: {
            key: "ENG-7",
            url: "https://example.atlassian.net/browse/ENG-7",
            summary: "Fix deploy",
            description: "Deployment pipeline is failing.",
            priority: "High",
            status: "Open",
            assignee: { displayName: "David" },
            epicKey: "ENG-1",
            epicSummary: "Platform Epic",
            epicUrl: "https://example.atlassian.net/browse/ENG-1"
          }
        } as unknown as T;
      }
      if (hookId === "jira.issue.comments.list") {
        return { comments: [{ id: "1", bodyText: "I can reproduce this.", author: { displayName: "Ari" }, url: "https://example.atlassian.net/browse/ENG-7?focusedCommentId=1" }] } as unknown as T;
      }
      if (hookId === "jira.issue.transitions.list") {
        return { transitions: [{ id: "21", name: "In Progress" }] } as unknown as T;
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(JiraPanel, { callHook }));
    });
    await flush();

    expect(container.textContent).toContain("ENG-1 Platform Epic");
    expect(container.textContent).toContain("Fix deploy");
    expect(container.textContent).toContain("Deployment pipeline is failing.");
    expect(container.textContent).toContain("I can reproduce this.");
    expect(container.textContent).toContain("In Progress");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.atlassian.net/browse/ENG-7");
    expect(Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual(expect.arrayContaining([
      "https://example.atlassian.net/browse/ENG-1",
      "https://example.atlassian.net/browse/ENG-7?focusedCommentId=1"
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      "jira.dashboard.list:",
      "jira.issue.get:ENG-7",
      "jira.issue.comments.list:ENG-7",
      "jira.issue.transitions.list:ENG-7"
    ]));

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".jira-transition-pill")?.click();
    });
    await flush();

    await act(async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".jira-comment-form textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Starting now.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLFormElement>(".jira-comment-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(calls).toEqual(expect.arrayContaining([
      "jira.issue.transition:ENG-7",
      "jira.issue.comment.add:ENG-7"
    ]));

    await unmount(root);
  });

  it("shows the clicked issue immediately while detail hooks are pending", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pendingIssue = deferred<{ issue: Record<string, unknown> }>();
    const pendingComments = deferred<{ comments: Record<string, unknown>[] }>();
    const pendingTransitions = deferred<{ transitions: Record<string, unknown>[] }>();
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      if (hookId === "jira.dashboard.list") {
        return Promise.resolve({
          jql: "assignee = currentUser()",
          sortBy: "priority_desc_updated_desc",
          groupBy: "epic",
          issues: [
            { key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" },
            { key: "ENG-8", url: "https://example.atlassian.net/browse/ENG-8", summary: "Review retry handling", priority: "Medium", status: "Backlog" }
          ],
          groups: [
            {
              id: "ENG-1",
              title: "ENG-1 Platform Epic",
              issues: [
                { key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" },
                { key: "ENG-8", url: "https://example.atlassian.net/browse/ENG-8", summary: "Review retry handling", priority: "Medium", status: "Backlog" }
              ]
            }
          ]
        } as unknown as T);
      }
      if (input.issueIdOrKey === "ENG-8" && hookId === "jira.issue.get") {
        return pendingIssue.promise as unknown as Promise<T>;
      }
      if (input.issueIdOrKey === "ENG-8" && hookId === "jira.issue.comments.list") {
        return pendingComments.promise as unknown as Promise<T>;
      }
      if (input.issueIdOrKey === "ENG-8" && hookId === "jira.issue.transitions.list") {
        return pendingTransitions.promise as unknown as Promise<T>;
      }
      if (hookId === "jira.issue.get") {
        return Promise.resolve({
          issue: {
            key: "ENG-7",
            url: "https://example.atlassian.net/browse/ENG-7",
            summary: "Fix deploy",
            description: "First full description",
            priority: "High",
            status: "Open"
          }
        } as unknown as T);
      }
      if (hookId === "jira.issue.comments.list") {
        return Promise.resolve({ comments: [{ id: "1", bodyText: "I can reproduce this.", author: { displayName: "Ari" }, url: "https://example.atlassian.net/browse/ENG-7?focusedCommentId=1" }] } as unknown as T);
      }
      if (hookId === "jira.issue.transitions.list") {
        return Promise.resolve({ transitions: [{ id: "21", name: "In Progress" }] } as unknown as T);
      }
      return Promise.resolve({} as T);
    };

    await act(async () => {
      root.render(createElement(JiraPanel, { callHook }));
    });
    await flush();

    expect(container.textContent).toContain("First full description");
    expect(container.textContent).toContain("I can reproduce this.");

    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>(".jira-issue-main")[1]?.click();
    });
    await flush();

    const detailText = container.querySelector(".jira-detail")?.textContent ?? "";
    expect(detailText).toContain("ENG-8");
    expect(detailText).toContain("Review retry handling");
    expect(detailText).toContain("Loading latest Jira details...");
    expect(detailText).not.toContain("First full description");
    expect(detailText).not.toContain("I can reproduce this.");

    await act(async () => {
      pendingIssue.resolve({
        issue: {
          key: "ENG-8",
          url: "https://example.atlassian.net/browse/ENG-8",
          summary: "Review retry handling",
          description: "Second full description",
          priority: "Medium",
          status: "Backlog"
        }
      });
      pendingComments.resolve({ comments: [{ id: "2", bodyText: "Second issue comment.", author: { displayName: "Nia" }, url: "https://example.atlassian.net/browse/ENG-8?focusedCommentId=2" }] });
      pendingTransitions.resolve({ transitions: [{ id: "31", name: "Start Progress" }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Second full description");
    expect(container.textContent).toContain("Second issue comment.");
    expect(container.textContent).toContain("Start Progress");

    await unmount(root);
  });

  it("does not reload selected issue details when the dashboard refreshes the same ticket", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let dashboardCalls = 0;
    const detailCalls: string[] = [];
    const callHook: NonNullable<UiContributionRenderContext["callHook"]> = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      if (hookId === "jira.dashboard.list") {
        dashboardCalls += 1;
        return {
          jql: "assignee = currentUser()",
          sortBy: "priority_desc_updated_desc",
          groupBy: "epic",
          issues: [{ key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: `Fix deploy ${dashboardCalls}`, priority: "High", status: "Open" }],
          groups: [
            {
              id: "ENG-1",
              title: "ENG-1 Platform Epic",
              issues: [{ key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: `Fix deploy ${dashboardCalls}`, priority: "High", status: "Open" }]
            }
          ]
        } as unknown as T;
      }
      if (hookId === "jira.issue.get") {
        detailCalls.push(`${hookId}:${input.issueIdOrKey ?? ""}`);
        return { issue: { key: "ENG-7", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", description: "Full details", priority: "High", status: "Open" } } as unknown as T;
      }
      if (hookId === "jira.issue.comments.list") {
        detailCalls.push(`${hookId}:${input.issueIdOrKey ?? ""}`);
        return { comments: [] } as unknown as T;
      }
      if (hookId === "jira.issue.transitions.list") {
        detailCalls.push(`${hookId}:${input.issueIdOrKey ?? ""}`);
        return { transitions: [] } as unknown as T;
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(JiraPanel, { callHook }));
    });
    await flush();

    expect(dashboardCalls).toBe(1);
    expect(detailCalls).toEqual([
      "jira.issue.get:ENG-7",
      "jira.issue.comments.list:ENG-7",
      "jira.issue.transitions.list:ENG-7"
    ]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh Jira"]')?.click();
    });
    await flush();

    expect(dashboardCalls).toBe(2);
    expect(detailCalls).toEqual([
      "jira.issue.get:ENG-7",
      "jira.issue.comments.list:ENG-7",
      "jira.issue.transitions.list:ENG-7"
    ]);

    await unmount(root);
  });

  it("shows ticket play actions only for active Jira manual-run automations", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const emitted: Array<{ triggerId: string; payload?: Record<string, unknown> }> = [];
    const callHook = jiraCallHookFixture();

    await act(async () => {
      root.render(createElement(JiraPanel, {
        callHook,
        activeTriggerIds: new Set([JIRA_ISSUE_MANUAL_TRIGGER_ID]),
        emitTrigger: async (triggerId: string, payload?: Record<string, unknown>) => {
          emitted.push({ triggerId, payload });
        }
      }));
    });
    await flush();

    const playButton = container.querySelector<HTMLButtonElement>('[aria-label="Run Jira automation for ENG-7"]');
    expect(playButton).toBeTruthy();

    await act(async () => {
      playButton?.click();
    });
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      triggerId: JIRA_ISSUE_MANUAL_TRIGGER_ID,
      payload: {
        eventType: JIRA_ISSUE_MANUAL_TRIGGER_ID,
        issueKey: "ENG-7",
        issueUrl: "https://example.atlassian.net/browse/ENG-7",
        summary: "Fix deploy",
        transport: "ui"
      }
    });

    await act(async () => {
      root.render(createElement(JiraPanel, { callHook, activeTriggerIds: new Set<string>(), emitTrigger: async () => undefined }));
    });
    await flush();
    expect(container.querySelector('[aria-label="Run Jira automation for ENG-7"]')).toBeNull();

    await unmount(root);
  });
});

function jiraCallHookFixture(): NonNullable<UiContributionRenderContext["callHook"]> {
  return async <T extends Record<string, unknown>>(hookId: string) => {
    if (hookId === "jira.dashboard.list") {
      return {
        jql: "assignee = currentUser()",
        sortBy: "priority_desc_updated_desc",
        groupBy: "epic",
        issues: [{ id: "10007", key: "ENG-7", siteUrl: "https://example.atlassian.net", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" }],
        groups: [
          {
            id: "ENG-1",
            title: "ENG-1 Platform Epic",
            issues: [{ id: "10007", key: "ENG-7", siteUrl: "https://example.atlassian.net", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", priority: "High", status: "Open" }]
          }
        ]
      } as unknown as T;
    }
    if (hookId === "jira.issue.get") {
      return { issue: { id: "10007", key: "ENG-7", siteUrl: "https://example.atlassian.net", url: "https://example.atlassian.net/browse/ENG-7", summary: "Fix deploy", status: "Open" } } as unknown as T;
    }
    if (hookId === "jira.issue.comments.list") {
      return { comments: [] } as unknown as T;
    }
    if (hookId === "jira.issue.transitions.list") {
      return { transitions: [] } as unknown as T;
    }
    return {} as T;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
