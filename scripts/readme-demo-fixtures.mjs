export const terminalTranscripts = {
  "codex-terminal": [
    "\u001b[36mCloudX / Implementation review\u001b[0m",
    "Synthetic demo session — no agent request was sent.",
    "",
    "› Add a release readiness check to the local dashboard.",
    "",
    "• Read release-checks.ts and the delivery checklist.",
    "• Added an explicit approval requirement.",
    "• Kept the change inside the release gate.",
    "",
    "  Changed: release-checks.ts",
    "  Example: unapproved releases remain blocked.",
    "",
    "Next: inspect the diff and run the project checks.",
    "The preview beside this session uses synthetic data.",
    "",
    "› Review the release gate before committing.",
  ],
  "standard-terminal": [
    "\u001b[36mCloudX / Validation terminal\u001b[0m",
    "Synthetic transcript — commands below were not executed.",
    "",
    "$ npm run test -- release-checks",
    "",
    "  ✓ approved releases can proceed",
    "  ✓ missing approval blocks a release",
    "  ✓ failed checks block a release",
    "",
    "$ git status --short",
    " M release-checks.ts",
    "",
    "$ git diff --stat",
    " release-checks.ts | 2 +−",
    "",
    "Ready to review the actual fixture diff in Files.",
  ],
};

export const documentationResults = [
  {
    documentId: "demo-release-guide",
    chunkId: 1,
    title: "Release readiness handbook",
    sourceType: "markdown",
    state: "active",
    locator: "Release gate / Approval",
    snippet:
      "A release can proceed only when every required check passes and a reviewer has approved the change. Keep the validation result with the release record.",
    score: 0.96,
    origin: "source",
  },
  {
    documentId: "demo-review-guide",
    chunkId: 2,
    title: "Review checklist",
    sourceType: "markdown",
    state: "active",
    locator: "Verification / Boundaries",
    snippet:
      "Review the changed behavior, its failure path, and the scope of the patch. Record the command and observable result before handoff.",
    score: 0.91,
    origin: "source",
  },
];

export function workspacePane(id, tabs) {
  return {
    type: "pane",
    pane: { id, tabIds: tabs.map((tab) => tab.id), activeTabId: tabs[0].id },
  };
}

export function developmentLayout(tabs) {
  return {
    root: {
      type: "split",
      id: "development",
      direction: "row",
      sizes: [43, 57],
      children: [
        workspacePane("implementation", [tabs.codex, tabs.terminal]),
        {
          type: "split",
          id: "review-preview",
          direction: "column",
          sizes: [60, 40],
          children: [
            workspacePane("review", [tabs.files]),
            workspacePane("preview", [tabs.web]),
          ],
        },
      ],
    },
    activePaneId: "implementation",
  };
}

export function knowledgeLayout(tabs) {
  return {
    root: {
      type: "split",
      id: "knowledge",
      direction: "row",
      sizes: [49, 51],
      children: [
        workspacePane("sources", [tabs.documentation, tabs.rules]),
        workspacePane("workflow", [tabs.automation]),
      ],
    },
    activePaneId: "sources",
  };
}

export function notificationWorkflow(triggerId) {
  return {
    id: "review-handoff",
    name: "Review handoff (demo)",
    enabled: false,
    testCases: [],
    graph: {
      schemaVersion: 2,
      nodes: [
        {
          id: "finished",
          typeId: `trigger:${triggerId}`,
          position: { x: 0, y: 0 },
        },
        {
          id: "notify",
          typeId: "hook:notifications.send",
          position: { x: 350, y: 0 },
          config: {
            title: "Review handoff",
            body: "Inspect the diff and validation results.",
            level: "info",
          },
        },
      ],
      edges: [
        {
          id: "handoff",
          kind: "exec",
          sourceNodeId: "finished",
          sourcePortId: "exec",
          targetNodeId: "notify",
          targetPortId: "exec",
        },
      ],
    },
  };
}
