import path from "node:path";
import type { PreparedAgentLaunch } from "@cloudx/plugin-api";
import { isRecord } from "@cloudx/shared";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { AppServerClient, type AppServerTransport } from "../appServer/AppServerClient.js";
import { OwnedAppServerTransport } from "../appServer/OwnedAppServerTransport.js";
import { AgentLaunchRecords } from "../agents/AgentLaunchRecords.js";
import { assertDirectoryIdentity, readDirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import { writeEvidenceReceipt } from "../forge/ForgeEvidenceFiles.js";
import { isReviewConversationBinding, type ReviewConversationBinding } from "../forge/ForgeReviewConversation.js";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CODEX_HISTORY_MAINTENANCE_VERSIONS, CodexStorageService } from "./CodexStorageService.js";

interface MaintenanceTransport extends AppServerTransport { finish(): Promise<void>; terminate(): Promise<void> }
export interface NativeHistoryRetirement {
  state: "retained" | "removing" | "removed";
  threadId: string;
  selectedVersion: string | null;
  reason: string;
  beforeAllocatedBytes?: number;
  afterAllocatedBytes?: number;
  reclaimedBytes?: number;
}

/** Only the terminal Forge lifecycle calls this owner. No interactive-tab deletion API exists. */
export class CodexHistoryMaintenance {
  constructor(
    private readonly dataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly createTransport: (launch: PreparedAgentLaunch) => Promise<MaintenanceTransport> = launch => OwnedAppServerTransport.create(launch),
  ) {}

  async retire(workerId: string, binding: ReviewConversationBinding, assertDisposable: () => Promise<void>, admit: <T>(task: () => Promise<T>) => Promise<T>): Promise<NativeHistoryRetirement> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/u.test(workerId) || !isReviewConversationBinding(binding) || binding.creating || !binding.threadId)
      throw new Error("Native history retirement requires a verified Forge conversation binding.");
    const threadId = binding.threadId;
    const file = new JsonStateFile(this.dataDir, `codex-history-retirement/${workerId}-${threadId}.json`, "Native history retirement", 0o600);
    const saved = await file.read<{ binding: ReviewConversationBinding; result: NativeHistoryRetirement }>();
    if (saved && (JSON.stringify(saved.binding) !== JSON.stringify(binding) || saved.result.threadId !== threadId || !["retained", "removing", "removed"].includes(saved.result.state)))
      throw new Error("Native history retirement ownership changed; history was preserved.");
    if (saved?.result.state === "removed") return saved.result;
    // A lost acknowledgement cannot become a fresh disposal decision after an upgrade or restart.
    if (saved?.result.state === "removing") return saved.result;
    const env = buildToolEnv(this.env);
    const command = resolveAssistantCommand(env);
    let selectedVersion: string | null = null;
    try { selectedVersion = await readCodexVersion(command, { env }); } catch { /* Unverified native clients cannot remove history. */ }
    const retain = async (reason: string): Promise<NativeHistoryRetirement> => {
      const result: NativeHistoryRetirement = { state: "retained", threadId, selectedVersion, reason };
      await writeEvidenceReceipt(file, { binding, result });
      return result;
    };
    if (!binding.sqliteHomeVerified) return retain("The historical native SQLite home has no verified effective-configuration receipt. Its conversation and databases were preserved.");
    if (!selectedVersion || !CODEX_HISTORY_MAINTENANCE_VERSIONS.has(selectedVersion))
      return retain(`Native history deletion is unavailable for unverified Codex ${selectedVersion ?? "unknown"}. The conversation remains resumable.`);
    const retireNative = async (): Promise<NativeHistoryRetirement> => {
      const sources = new CodexStateSources(this.dataDir, { ...this.env, CODEX_HOME: binding.source.home });
      let transport: MaintenanceTransport | undefined;
      let client: AppServerClient | undefined;
      let removing: NativeHistoryRetirement | undefined;
      const assertStorage = async () => {
        await sources.assertCurrent(binding.source);
        assertDirectoryIdentity(binding.sqliteHome, await readDirectoryIdentity(binding.sqliteHome.path, "Native SQLite home"), "Native SQLite home");
        assertDirectoryIdentity(binding.originView, await readDirectoryIdentity(binding.originView.path, "Native conversation view"), "Native conversation view");
        if (!await sources.readBinding(path.basename(binding.originView.path))) throw new Error("Native conversation source binding is missing.");
      };
      try {
        await assertStorage();
        const launch = await new AgentLaunchRecords(this.dataDir).read(path.basename(binding.originView.path), "codex");
        if (!launch || launch.version !== selectedVersion || launch.command !== command)
          return await retain("The selected executable does not match the conversation's recorded native version. History was preserved.");
        await assertDisposable();
        const inventory = new CodexStorageService(sources, { ...env, CODEX_SQLITE_HOME: binding.sqliteHome.path });
        const before = await inventory.read();
        if (before.warnings.length) return await retain("Native storage could not be measured completely. History was preserved.");
        transport = await this.createTransport({ tabId: launch.tabId, cwd: binding.source.home, command,
          configurationArgs: ["-c", `sqlite_home=${JSON.stringify(binding.sqliteHome.path)}`, "-c", "features.background_paginated_rollout_migration=false", "-c", "features.local_thread_store_compression=false"],
          env: { ...env, CODEX_HOME: binding.source.home, CODEX_SQLITE_HOME: binding.sqliteHome.path } });
        client = new AppServerClient(transport);
        await client.request("initialize", { clientInfo: { name: "cloudx_history_maintenance", version: "1" }, capabilities: { experimentalApi: true } });
        transport.send({ method: "initialized", params: {} });
        await assertStorage();
        await assertDisposable();
        // Native deletion expands to the spawned subtree. A descendant is not disposal authority.
        for (const archived of [false, true]) {
          const children = await client.request("thread/list", { ancestorThreadId: threadId, archived, limit: 1 });
          if (!isRecord(children) || !Array.isArray(children.data) || children.data.length || children.nextCursor !== null)
            return await retain("The native conversation has spawned descendants or unverified descendant ownership. The complete conversation tree was preserved.");
        }
        const attachments = await client.request("thread/attachment/list", { threadId, limit: 1 });
        if (!isRecord(attachments) || !Array.isArray(attachments.data) || attachments.data.length || attachments.nextCursor !== null)
          return await retain("The native conversation has attachments or unverified artifact ownership. Its history and artifacts were preserved.");
        removing = { state: "removing", threadId, selectedVersion, reason: "Native thread/delete requested for a terminal, unreferenced Forge conversation.", beforeAllocatedBytes: nativeAllocation(before) };
        await writeEvidenceReceipt(file, { binding, result: removing });
        await assertDisposable();
        await assertStorage();
        const response = await client.request("thread/delete", { threadId });
        if (!isRecord(response) || Object.keys(response).length) throw new Error("Native deletion did not return its expected acknowledgement.");
        await transport.finish();
        const after = await inventory.read();
        if (after.warnings.length) throw new Error("Native deletion completed but its allocated-byte measurement is incomplete.");
        const result: NativeHistoryRetirement = { ...removing, state: "removed", reason: "Native thread/delete and process shutdown confirmed. Native writer/reference locks and projection removal completed.",
          afterAllocatedBytes: nativeAllocation(after), reclaimedBytes: Math.max(0, nativeAllocation(before) - nativeAllocation(after)) };
        return result;
      } catch (error) {
        // A failed native operation can have partial effects. Keep the removing receipt for diagnosis.
        if (removing) {
          const result = { ...removing, reason: `Native maintenance did not complete: ${error instanceof Error ? error.message : "unknown failure"}` };
          await writeEvidenceReceipt(file, { binding, result });
          return result;
        }
        return await retain(`Native maintenance preconditions failed: ${error instanceof Error ? error.message : "unknown failure"}`);
      } finally {
        try { client?.close(); }
        finally {
          try { await transport?.terminate(); }
          finally { await sources.dispose(); }
        }
      }
    };
    try {
      const completed = await admit(retireNative);
      await writeEvidenceReceipt(file, { binding, result: completed });
      return completed;
    } catch (error) {
      const reason = `Native maintenance admission or process cleanup is unresolved: ${error instanceof Error ? error.message : "unknown failure"}`;
      const current = await file.read<{ binding: ReviewConversationBinding; result: NativeHistoryRetirement }>();
      if (current?.result.state === "removing" || current?.result.state === "removed") {
        const result: NativeHistoryRetirement = { ...current.result, state: "removing", reason, reclaimedBytes: undefined };
        await writeEvidenceReceipt(file, { binding, result });
        return result;
      }
      return retain(reason);
    }
  }
}

function nativeAllocation(inventory: Awaited<ReturnType<CodexStorageService["read"]>>): number {
  return Object.values(inventory.native).reduce((bytes, value) => bytes + value.allocatedBytes, 0);
}
