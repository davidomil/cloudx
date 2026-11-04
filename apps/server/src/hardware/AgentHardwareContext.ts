import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAgentTab, isRecord, parseHardwareOwner, type AgentOwner, type WorkspaceRuntimeContext, type WorkspaceTab } from "@cloudx/shared";

import { writeTextFileAtomic } from "../jsonStateFile.js";

export interface HardwareAgentLocator {
  version: 1;
  owner: AgentOwner;
  endpoint: string;
  capability: string;
  caPath?: string;
}

interface HardwareAgentContextOptions {
  dataDir: string;
  endpoint(): string;
  caPath?: string;
  binding(tabId: string): AgentOwner | undefined | Promise<AgentOwner | undefined>;
}

/** The environment points to one execution's locator, never a tab's next execution. */
export class AgentHardwareContext {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HardwareAgentContextOptions) {}

  contextDirectory(tabId: string): string {
    if (!tabId || tabId.length > 512 || tabId.includes("\0")) throw new Error("A stable Hardware tab identity is required.");
    return path.join(this.options.dataDir, "hardware-agents", digest(tabId));
  }

  contextPath(owner: AgentOwner): string {
    return executionContextPath(this.contextDirectory(owner.tabId), owner.executionId);
  }

  async owner(tabId: string): Promise<AgentOwner | undefined> {
    const owner = await this.options.binding(tabId);
    return owner?.tabId === tabId ? parseHardwareOwner(owner) as AgentOwner : undefined;
  }

  prepare(tabId: string): Promise<HardwareAgentLocator | undefined> {
    const task = this.pending.then(async () => {
      const owner = await this.owner(tabId);
      if (!owner) return undefined;
      const endpoint = new URL(this.options.endpoint());
      if (!["http:", "https:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error("Hardware helpers require a local HTTP endpoint.");
      if (this.options.caPath && !path.isAbsolute(this.options.caPath)) throw new Error("Hardware TLS trust requires an absolute certificate path.");
      const directory = this.contextDirectory(tabId);
      const parent = path.dirname(directory);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const parentStat = await fs.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077)) throw new Error("Hardware contexts require a real private directory.");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Hardware contexts require a real private directory.");
      const previous = await this.read(owner);
      if (previous && ownerIdentity(previous.owner) !== ownerIdentity(owner)) throw new Error("A Hardware execution identity cannot be reused for a different owner.");
      const locator: HardwareAgentLocator = { version: 1, owner, endpoint: endpoint.href,
        capability: previous?.capability ?? randomBytes(32).toString("hex"), ...(this.options.caPath ? { caPath: this.options.caPath } : {}) };
      await writeTextFileAtomic(directory, this.contextPath(owner), `${JSON.stringify(locator)}\n`, "Hardware execution context", 0o600);
      // Old processes keep their original path. Removing it cannot give them the replacement's capability.
      for (const name of await fs.readdir(directory)) if (/^[a-f0-9]{64}\.json$/.test(name) && name !== path.basename(this.contextPath(owner)))
        await fs.rm(path.join(directory, name), { force: true });
      return locator;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  async augmentRuntimeContext(tab: WorkspaceTab, context: WorkspaceRuntimeContext = {}): Promise<WorkspaceRuntimeContext> {
    if (!isAgentTab(tab)) return context;
    await this.prepare(tab.id);
    return { ...context, pluginRuntime: { ...context.pluginRuntime,
      hardware: { directory: this.contextDirectory(tab.id), helperPath: HARDWARE_HELPER_PATH } } };
  }

  async authenticate(request: { tabId: string; executionId: string; capability: string }): Promise<AgentOwner> {
    const owner = await this.owner(request.tabId);
    if (!owner || owner.executionId !== request.executionId) throw forbidden();
    const locator = await this.read(owner);
    const current = await this.owner(request.tabId);
    if (!locator || ownerIdentity(locator.owner) !== ownerIdentity(owner) ||
      !current || ownerIdentity(current) !== ownerIdentity(owner) ||
      !/^[a-f0-9]{64}$/.test(request.capability) || !timingSafeEqual(Buffer.from(locator.capability, "hex"), Buffer.from(request.capability, "hex"))) throw forbidden();
    return owner;
  }

  async revoke(tabId: string): Promise<void> {
    await this.pending;
    await fs.rm(this.contextDirectory(tabId), { recursive: true, force: true });
  }

  private async read(owner: AgentOwner): Promise<HardwareAgentLocator | undefined> {
    let file;
    try {
      file = await fs.open(this.contextPath(owner), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077)) throw new Error("Hardware locator must be a bounded private regular file.");
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!isRecord(value) || value.version !== 1 || typeof value.capability !== "string" || !/^[a-f0-9]{64}$/.test(value.capability) || typeof value.endpoint !== "string") throw new Error("Hardware locator is invalid.");
      const parsedOwner = parseHardwareOwner(value.owner);
      if (parsedOwner.kind !== "agent") throw new Error("Hardware locator requires an agent owner.");
      return { ...value, owner: parsedOwner } as unknown as HardwareAgentLocator;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally { await file?.close(); }
  }
}

export const HARDWARE_HELPER_PATH = fileURLToPath(new URL("../../helpers/hardware-helper.mjs", import.meta.url));

export function hardwareLaunchEnv(context?: WorkspaceRuntimeContext, executionId?: string): Record<string, string> {
  const runtime = context?.pluginRuntime?.hardware;
  if (runtime === undefined) return {};
  if (!isRecord(runtime) || typeof runtime.directory !== "string" || !path.isAbsolute(runtime.directory) ||
    typeof runtime.helperPath !== "string" || !path.isAbsolute(runtime.helperPath)) throw new Error("Hardware launch context is invalid.");
  if (!executionId) throw new Error("Hardware launch requires an exact execution identity.");
  return { CLOUDX_HARDWARE_CONTEXT: executionContextPath(runtime.directory, executionId), CLOUDX_HARDWARE_HELPER: runtime.helperPath };
}

export function ownerIdentity(owner: AgentOwner): string {
  return JSON.stringify([owner.tabId, owner.providerId, owner.executionId, owner.ownerPluginId, owner.logicalRunId, owner.workerId, owner.attemptId]);
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function executionContextPath(directory: string, executionId: string): string { return path.join(directory, `${digest(executionId)}.json`); }
function forbidden(): Error { return Object.assign(new Error("This Hardware execution capability is unavailable or revoked."), { code: "FORBIDDEN", statusCode: 403 }); }
