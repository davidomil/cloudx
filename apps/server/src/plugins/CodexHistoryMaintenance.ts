import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { JsonStateFile } from "../jsonStateFile.js";
import { writeEvidenceReceipt } from "../forge/ForgeEvidenceFiles.js";
import { isReviewConversationBinding, type ReviewConversationBinding } from "../forge/ForgeReviewConversation.js";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";
import { codexHistoryMaintenanceLimitation } from "./CodexStorageService.js";

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
    try {
      return await admit(async () => {
        await assertDisposable();
        // Native 0.166.0 serializes individual mutations, but offers no conditional
        // delete or reservation spanning CloudX's eligibility checks and deletion.
        return retain(codexHistoryMaintenanceLimitation(selectedVersion));
      });
    } catch (error) {
      return retain(`Native maintenance preconditions failed: ${error instanceof Error ? error.message : "unknown failure"}`);
    }
  }
}
