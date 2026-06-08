// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { JiraPanel } from "./JiraPanel.js";
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
});

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
