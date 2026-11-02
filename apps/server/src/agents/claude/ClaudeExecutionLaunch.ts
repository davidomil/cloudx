import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveClaudeLaunchMode, type ClaudeLaunchMode } from "@cloudx/shared";
import type { AgentAccountStore } from "../AgentAccountStore.js";
import { AgentLaunchRecords } from "../AgentLaunchRecords.js";
import { agentCommand, claudeAccountLaunch, readAgentProviderStatus } from "../agentCli.js";
import type { ResolvedPersonalityTemplate } from "../../rulesSkills/RulesSkillsCatalogService.js";
import { buildToolEnv } from "../../terminal/ShellLaunch.js";
import { claudeOverlayPath, claudeUserStatePath, materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";
import { ClaudeSettingsService } from "./ClaudeSettingsService.js";
import { verifyClaudeNativeAccount } from "./ClaudeNativeSettings.js";
import { pinClaudeExecutable } from "./ClaudeManagedExecutable.js";

// One-shot/automation launches share the same settings, source policy, account
// preflight and execution observations as interactive Claude tabs.
export async function prepareClaudeExecutionLaunch(accounts: AgentAccountStore, input: {
  cwd: string; claudeLaunchMode?: ClaudeLaunchMode; baseEnv?: NodeJS.ProcessEnv; signal?: AbortSignal;
  resolved?: ResolvedPersonalityTemplate;
}) {
  const baseEnv = input.baseEnv ?? process.env;
  const executionId = randomUUID();
  const tabId = `exec-${executionId}`;
  const providerHome = accounts.providerHome("claude");
  const current = await new ClaudeSettingsService(accounts.dataDir, () => providerHome, baseEnv).read();
  const selection = resolveClaudeLaunchMode(input.claudeLaunchMode, current.launchMode);
  const account = await accounts.resolve("claude");
  const configDir = claudeOverlayPath(accounts.dataDir, tabId);
  const launch = claudeAccountLaunch(buildToolEnv(baseEnv), configDir, await accounts.launchEnv(account));
  await pinClaudeExecutable(launch.env, input.cwd);
  const provider = await readAgentProviderStatus("claude", launch.env);
  const command = agentCommand("claude", launch.env);
  await fs.mkdir(path.dirname(configDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(configDir, { mode: 0o700 });
  const owner = await fs.lstat(configDir);
  const dispose = async () => {
    const current = await fs.lstat(configDir).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!current) return;
    if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("The temporary Claude execution directory changed ownership; it has been retained.");
    await fs.rm(configDir, { recursive: true });
  };
  try {
    const overlay = await materializeClaudeHomeOverlay({
      dataDir: accounts.dataDir, tabId, executionId, accountHome: accounts.home(account), providerHome,
      cwd: input.cwd, userStatePath: claudeUserStatePath(baseEnv), resolved: input.resolved,
      trustProject: current.autoTrustWorkspace, allowedSkills: current.skills.filter(skill => skill.allowed).map(skill => skill.name),
      launchEnv: launch.env, accountPolicy: launch.policy, launchMode: selection.mode, nativeVersion: provider.version, trackPreferences: false,
      conversationPolicy: { accountId: account.id }
    });
    await verifyClaudeNativeAccount({ command, cwd: input.cwd, env: launch.env, settingsPath: overlay.settingsPath, configurationArgs: overlay.configurationArgs, signal: input.signal }, launch.policy);
    const args = ["--settings", overlay.settingsPath, "--append-system-prompt-file", overlay.instructionsPath, ...overlay.configurationArgs];
    await new AgentLaunchRecords(accounts.dataDir).record({
      providerId: "claude", tabId, executionId, command, version: provider.version, accountId: account.id,
      cwd: input.cwd, args, env: launch.env, enforcedEnvironmentKeys: [...launch.enforced.unset, ...Object.keys(launch.enforced.set)],
      configurationPaths: [overlay.settingsPath, overlay.instructionsPath],
      skillSelections: current.skills.map(skill => ({ name: skill.name, source: skill.origin, selected: skill.allowed, available: skill.available })),
      claudeLaunchPolicy: overlay.launchPolicy, claudeLaunchModeSource: selection.source
    });
    return { env: launch.env, args, executionId, launchPolicy: overlay.launchPolicy, accountId: account.id, configDir, tabId, modeSource: selection.source, dispose };
  } catch (error) { await dispose(); throw error; }
}
