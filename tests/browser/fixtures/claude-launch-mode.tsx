import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsUpdate,
  PluginDescriptor,
} from "@cloudx/shared";
import { CreateTabDialog } from "../../../apps/web/src/ui/App.js";
import { ClaudeSettingsPanel } from "../../../apps/web/src/ui/ClaudeSettingsPanel.js";
import "../../../apps/web/src/styles.css";

let settings: ClaudeGlobalSettings = {
  revision: "a".repeat(64),
  settingsPath: "/fixture/.claude/settings.json",
  model: null,
  effortLevel: null,
  alwaysThinkingEnabled: null,
  fastMode: null,
  outputStyle: null,
  language: null,
  autoUpdatesChannel: null,
  permissionMode: "plan",
  autoTrustWorkspace: false,
  bypassAccepted: true,
  bypassDisabled: false,
  launchMode: null,
  skills: [
    { name: "notes", origin: "personal", allowed: true, available: true },
  ],
};
const plugin: PluginDescriptor = {
  id: "codex-terminal",
  acronym: "AGT",
  displayName: "Agent",
  description: "Agent",
  panelKind: "terminal",
  creatable: true,
  requiresDirectory: true,
  actions: [],
  configFields: [],
};

async function callHook(id: string, input?: Record<string, unknown>) {
  if (id === "agent-accounts.read")
    return {
      state: {
        providers: [
          { providerId: "claude", installed: true, label: "Claude Code" },
        ],
        accounts: [
          {
            id: "selected",
            providerId: "claude",
            label: "Selected",
            kind: "subscription",
            isDefault: true,
            createdAt: "2026-11-02",
          },
        ],
      },
    };
  if (id === "claude-settings.read")
    return {
      settings,
      cli: { installed: true, version: "2.1.316", command: "/fixture/claude" },
      bypassWarning: "Fixture only.",
    };
  if (id === "claude-settings.update") {
    const update = input as unknown as ClaudeGlobalSettingsUpdate;
    if (update.launchMode !== undefined)
      settings = {
        ...settings,
        launchMode: update.launchMode,
        revision: "b".repeat(64),
      };
    return { settings };
  }
  throw new Error(`Unexpected fixture hook ${id}`);
}

function Fixture() {
  const [creating, setCreating] = useState(false);
  const [submitted, setSubmitted] = useState("");
  return (
    <main style={{ padding: 16, maxWidth: 1000, margin: "auto" }}>
      <button onClick={() => setCreating(true)}>Open new Claude tab</button>
      <output aria-label="Submitted launch">{submitted}</output>
      <ClaudeSettingsPanel callHook={callHook as never} />
      {creating ? (
        <CreateTabDialog
          plugins={[plugin]}
          templates={[]}
          callHook={callHook as never}
          defaultCwd="/fixture/workspace"
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            setSubmitted(JSON.stringify(input.initialInput));
            setCreating(false);
          }}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
