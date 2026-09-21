import { describe, expect, it } from "vitest";
import {
  isAutomationGraphDocument,
  isUsableTabLayoutState,
} from "@cloudx/shared";
import {
  developmentLayout,
  knowledgeLayout,
  notificationWorkflow,
  terminalTranscripts,
} from "./readme-demo-fixtures.mjs";

const tabs = Object.fromEntries(
  [
    "codex",
    "terminal",
    "files",
    "web",
    "documentation",
    "rules",
    "automation",
  ].map((id) => [id, { id }]),
);

describe("desktop documentation demos", () => {
  it("keeps implementation, review, and preview visible in a valid workspace", () => {
    const layout = developmentLayout(tabs);
    expect(isUsableTabLayoutState(layout)).toBe(true);
    expect(visibleTabs(layout.root)).toEqual(["codex", "files", "web"]);
  });

  it("keeps source evidence and automation visible in a valid workspace", () => {
    const layout = knowledgeLayout(tabs);
    expect(isUsableTabLayoutState(layout)).toBe(true);
    expect(visibleTabs(layout.root)).toEqual(["documentation", "automation"]);
  });

  it("saves the example workflow disabled and uses a local notification action", () => {
    const group = notificationWorkflow("worktree.created");
    expect(group.enabled).toBe(false);
    expect(isAutomationGraphDocument(group.graph)).toBe(true);
    expect(group.graph.nodes.map((node) => node.typeId)).toEqual([
      "trigger:worktree.created",
      "hook:notifications.send",
    ]);
  });

  it("labels terminal transcripts as synthetic instead of real validation results", () => {
    for (const lines of Object.values(terminalTranscripts))
      expect(lines.join("\n")).toContain("Synthetic");
  });
});

function visibleTabs(node) {
  return node.type === "pane"
    ? [node.pane.activeTabId]
    : node.children.flatMap(visibleTabs);
}
