import path from "node:path";
import { parseClaudeResolvedLaunchPolicy, resolveClaudeLaunchMode, type ClaudeLaunchMode, type ClaudeResolvedLaunchPolicy } from "@cloudx/shared";
import { JsonStateFile } from "../../jsonStateFile.js";
import { defaultManagedFiles, managedSettingsFiles, readPolicy } from "./ClaudeHookPolicy.js";
import { worktreeLocalSettings } from "./ClaudeSettingsSources.js";
const files = await import(new URL("../../../helpers/claude-conversation-policy.mjs", import.meta.url).href);

interface ConversationPolicy {
  version: 1;
  sessionId: string;
  accountId: string;
  cwd: string;
  policy: ClaudeResolvedLaunchPolicy;
}

export async function assertClaudeConversationNavigationCompatibility(input: {
  providerHome: string; cwd?: string; env?: NodeJS.ProcessEnv; mode: ClaudeLaunchMode;
}, managedFiles = defaultManagedFiles()): Promise<void> {
  const key = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";
  const check = (env: unknown, source: string) => {
    if (env && typeof env === "object" && key in env && (env as Record<string, unknown>)[key] !== undefined && (env as Record<string, unknown>)[key] !== "")
      throw new Error(`Claude ${key} in ${source} enables automatic continuation whose conversation-policy gate is unverified. Ask its owner to remove that setting before this launch. No session has started and CloudX has not changed policy.`);
  };
  check(input.env, "launch environment");
  const files = new Set([path.join(input.providerHome, "settings.json"), ...await managedSettingsFiles(managedFiles)]);
  if (input.mode === "native-project" && input.cwd) for (let directory = path.resolve(input.cwd); ; directory = path.dirname(directory)) {
    for (const name of ["settings.json", "settings.local.json"]) files.add(path.join(directory, ".claude", name));
    const canonical = await worktreeLocalSettings(directory); if (canonical) files.add(canonical);
    if (path.dirname(directory) === directory) break;
  }
  for (const file of files) check((await readPolicy(file)).env, file);
}

// A native conversation keeps its mode and account when a new process resumes it.
// Selected source snapshots refresh only at that next launch.
export class ClaudeConversationPolicies {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) {}

  async read(sessionId: string): Promise<ConversationPolicy | undefined> {
    const value = files.readConversationPolicy(this.directory, sessionId) as ConversationPolicy | undefined;
    if (value === undefined) return;
    if (!value || value.version !== 1 || value.sessionId !== sessionId || typeof value.accountId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value.accountId) || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd))
      throw new Error("Invalid recorded Claude conversation policy.");
    return { ...value, policy: parseClaudeResolvedLaunchPolicy(value.policy) };
  }

  async resolve(input: { sessionId?: string; requestedMode?: unknown; savedMode?: ClaudeLaunchMode | null; accountId: string; cwd: string }) {
    const selection = resolveClaudeLaunchMode(input.requestedMode, input.savedMode);
    if (!input.sessionId) return { ...selection, historical: false };
    const recorded = await this.read(input.sessionId);
    if (!recorded) {
      if (selection.mode === "cloudx-managed")
        throw new Error("This historical Claude conversation has no verified launch policy. Choose Native project explicitly to resume unverified history, or start a new CloudX-managed conversation.");
      return { ...selection, historical: true };
    }
    this.assertOwner(recorded, input.accountId, input.cwd);
    if (input.requestedMode !== undefined && selection.mode !== recorded.policy.mode) this.differentMode();
    return { mode: recorded.policy.mode, source: "conversation" as const, historical: false };
  }

  bind(sessionId: string, input: { accountId: string; cwd: string; policy: ClaudeResolvedLaunchPolicy; historical?: boolean }): Promise<void> {
    const task = this.queue.then(async () => {
      if (input.historical) return;
      const policy = parseClaudeResolvedLaunchPolicy(input.policy);
      const recorded = await this.read(sessionId);
      if (recorded) {
        this.assertOwner(recorded, input.accountId, input.cwd);
        if (recorded.policy.mode !== policy.mode) this.differentMode();
        return;
      }
      files.bindConversationPolicy(this.directory, sessionId, { ...input, policy });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async prepareExecution(configDir: string, input: { tabId: string; executionId: string; accountId: string; cwd: string; policy: ClaudeResolvedLaunchPolicy; sessionId?: string; historical?: boolean }): Promise<void> {
    await new JsonStateFile(configDir, ".cloudx-conversation-policy.json", "Claude execution conversation policy", 0o600).write({
      version: 1, ...input, policy: parseClaudeResolvedLaunchPolicy(input.policy), policyDirectory: this.directory,
    });
  }

  private get directory(): string { return path.join(this.dataDir, "claude-conversation-policies"); }

  private assertOwner(recorded: ConversationPolicy, accountId: string, cwd: string): void {
    if (recorded.accountId !== accountId) throw new Error("This Claude conversation was launched with a different account. Resume with its recorded account, or start a new conversation; CloudX has not changed either account.");
    if (path.resolve(recorded.cwd) !== path.resolve(cwd)) throw new Error("This Claude conversation belongs to a different workspace. Resume in its recorded workspace, or start a new conversation.");
  }

  private differentMode(): never {
    throw new Error("This Claude conversation has a different launch mode. Its recorded mode is preserved; start a new conversation to change the source policy.");
  }

}
