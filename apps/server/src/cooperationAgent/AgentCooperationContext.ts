import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAgentTab, isRecord, type CooperationAsset, type CooperationCaller, type CooperationProvider, type WorkspaceRuntimeContext, type WorkspaceTab } from "@cloudx/shared";

import { writeTextFileAtomic } from "../jsonStateFile.js";

export interface CooperationAgentBinding {
  tabId: string;
  boardId: string | null;
  assignmentGeneration: number;
  providerId?: CooperationProvider;
  ownerPluginId?: string;
  logicalRunId?: string;
  attemptId?: string;
  executionId?: string;
}

export interface CooperationAgentLocator extends CooperationAgentBinding {
  version: 1;
  endpoint: string;
  capability: string;
  assetRoot: string;
  caPath?: string;
}

export interface AgentCooperationContextOptions {
  dataDir: string;
  endpoint: () => string;
  caPath?: string;
  binding: (tabId: string) => Promise<CooperationAgentBinding | undefined> | CooperationAgentBinding | undefined;
}

/** One private, stable locator per tab. Membership is checked again on each request. */
export class AgentCooperationContext {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AgentCooperationContextOptions) {
    this.directory = path.join(options.dataDir, "cooperation-agents");
  }

  contextPath(tabId: string): string {
    if (!tabId || tabId.length > 512 || tabId.includes("\0")) throw new Error("A stable agent tab identity is required.");
    return path.join(this.directory, `${createHash("sha256").update(tabId).digest("hex")}.json`);
  }

  prepare(tabId: string): Promise<CooperationAgentLocator> {
    const task = this.queue.then(async () => {
      const binding = await this.options.binding(tabId);
      if (!binding || binding.tabId !== tabId) throw new Error("The agent tab no longer exists.");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Cooperation contexts require a real private directory.");
      const previous = await this.readLocator(tabId);
      const assetRoot = `${this.contextPath(tabId)}.assets`;
      const sameLease = previous && leaseIdentity(previous) === leaseIdentity(binding);
      if (previous && !sameLease)
        await fs.rm(assetRoot, { recursive: true, force: true });
      await fs.mkdir(assetRoot, { recursive: true, mode: 0o700 });
      const assetDirectory = await fs.lstat(assetRoot);
      if (!assetDirectory.isDirectory() || assetDirectory.isSymbolicLink()) throw new Error("Cooperation images require a real per-tab directory.");
      const locator: CooperationAgentLocator = {
        version: 1, ...binding,
        endpoint: localEndpoint(this.options.endpoint()),
        assetRoot,
        ...(this.options.caPath ? { caPath: absoluteCertificatePath(this.options.caPath) } : {}),
        capability: sameLease
          ? previous.capability : randomBytes(32).toString("hex")
      };
      await writeTextFileAtomic(this.directory, this.contextPath(tabId), `${JSON.stringify(locator)}\n`, "Cooperation context", 0o600);
      return locator;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async augmentRuntimeContext(tab: WorkspaceTab, context: WorkspaceRuntimeContext = {}): Promise<WorkspaceRuntimeContext> {
    if (!isAgentTab(tab)) return context;
    await this.prepare(tab.id);
    return {
      ...context,
      pluginRuntime: {
        ...context.pluginRuntime,
        cooperation: { contextPath: this.contextPath(tab.id), helperPath: COOPERATION_HELPER_PATH, assetRoot: `${this.contextPath(tab.id)}.assets` }
      }
    };
  }

  async authenticate(request: { tabId: string; assignmentGeneration: number; boardId: string | null; capability: string }): Promise<Extract<CooperationCaller, { kind: "agent" }>> {
    const locator = await this.readLocator(request.tabId);
    const binding = await this.options.binding(request.tabId);
    if (!locator || !binding || !sameSecret(locator.capability, request.capability))
      throw Object.assign(new Error("This cooperation capability is unavailable or revoked."), { code: "FORBIDDEN", statusCode: 403 });
    if (binding.assignmentGeneration !== request.assignmentGeneration || binding.boardId !== request.boardId ||
      locator.assignmentGeneration !== binding.assignmentGeneration || locator.boardId !== binding.boardId)
      throw Object.assign(new Error("The blackboard assignment changed. Read the current context before continuing."), { code: "ASSIGNMENT_CHANGED", statusCode: 409 });
    if (leaseIdentity(locator) !== leaseIdentity(binding))
      throw Object.assign(new Error("The original agent execution capability has been revoked."), { code: "FORBIDDEN", statusCode: 403 });
    return {
      kind: "agent", tabId: locator.tabId, assignmentGeneration: locator.assignmentGeneration,
      ...(locator.providerId ? { providerId: locator.providerId } : {}),
      ...(locator.ownerPluginId ? { ownerPluginId: locator.ownerPluginId } : {}),
      ...(locator.logicalRunId ? { logicalRunId: locator.logicalRunId } : {}),
      ...(locator.attemptId ? { attemptId: locator.attemptId } : {})
    };
  }

  async revoke(tabId: string): Promise<void> {
    await this.queue;
    await fs.rm(this.contextPath(tabId), { force: true });
    await fs.rm(`${this.contextPath(tabId)}.native.json`, { force: true });
    await fs.rm(`${this.contextPath(tabId)}.assets`, { recursive: true, force: true });
  }

  async materializeAsset(tabId: string, generation: number, original: { asset: CooperationAsset; localPath: string }): Promise<{ asset: CooperationAsset; localPath: string }> {
    const context = await this.prepare(tabId);
    if (context.assignmentGeneration !== generation || !context.boardId)
      throw Object.assign(new Error("The blackboard assignment changed before image access."), { code: "ASSIGNMENT_CHANGED", statusCode: 409 });
    if (!/^[a-f0-9]{64}$/.test(original.asset.sha256) || !["image/png", "image/jpeg", "image/webp"].includes(original.asset.mime))
      throw new Error("The original board image metadata is invalid.");
    const source = await fs.open(original.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await source.stat();
      if (!stat.isFile() || stat.size !== original.asset.byteLength || stat.size > 10 * 1024 * 1024) throw new Error("The original board image is invalid.");
      bytes = await source.readFile();
    } finally { await source.close(); }
    if (createHash("sha256").update(bytes).digest("hex") !== original.asset.sha256) throw new Error("The original board image hash changed.");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[original.asset.mime];
    const localPath = path.join(context.assetRoot, `${original.asset.sha256}.${extension}`);
    let target;
    try {
      target = await fs.open(localPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      await target.writeFile(bytes);
      await target.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const cached = await fs.open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await cached.stat();
        if (!stat.isFile() || stat.size !== bytes.length || createHash("sha256").update(await cached.readFile()).digest("hex") !== original.asset.sha256)
          throw new Error("The per-tab original image copy was modified.");
      } finally { await cached.close(); }
    } finally { await target?.close(); }
    const current = await this.options.binding(tabId);
    if (!current || leaseIdentity(current) !== leaseIdentity(context)) {
      await fs.rm(localPath, { force: true });
      throw Object.assign(new Error("The blackboard assignment changed during image access."), { code: "ASSIGNMENT_CHANGED", statusCode: 409 });
    }
    return { asset: original.asset, localPath };
  }

  private async readLocator(tabId: string): Promise<CooperationAgentLocator | undefined> {
    let handle;
    try {
      handle = await fs.open(this.contextPath(tabId), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16_384) throw new Error("The cooperation context must be a bounded regular file.");
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!isRecord(value) || value.version !== 1 || value.tabId !== tabId ||
        typeof value.capability !== "string" || !/^[a-f0-9]{64}$/.test(value.capability) ||
        !Number.isSafeInteger(value.assignmentGeneration) || (value.assignmentGeneration as number) < 0 ||
        value.boardId !== null && typeof value.boardId !== "string") throw new Error("The cooperation context is invalid.");
      return value as unknown as CooperationAgentLocator;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally { await handle?.close(); }
  }
}

export const COOPERATION_HELPER_PATH = fileURLToPath(new URL("../../helpers/cooperation-helper.mjs", import.meta.url));

export function cooperationLaunchEnv(context?: WorkspaceRuntimeContext): Record<string, string> {
  const runtime = context?.pluginRuntime?.cooperation;
  if (!isRecord(runtime)) return {};
  if (typeof runtime.contextPath !== "string" || !path.isAbsolute(runtime.contextPath) ||
    typeof runtime.helperPath !== "string" || !path.isAbsolute(runtime.helperPath)) throw new Error("Cooperation launch context is invalid.");
  if (typeof runtime.assetRoot !== "string" || !path.isAbsolute(runtime.assetRoot)) throw new Error("Cooperation image root is invalid.");
  return { CLOUDX_COOPERATION_CONTEXT: runtime.contextPath, CLOUDX_COOPERATION_HELPER: runtime.helperPath, CLOUDX_COOPERATION_ASSETS: runtime.assetRoot };
}

function localEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new Error("Cooperation helper requires a local HTTP endpoint.");
  return endpoint.href;
}

function sameSecret(expected: string, received: string): boolean {
  if (typeof received !== "string" || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

function absoluteCertificatePath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Cooperation TLS trust requires an absolute certificate path.");
  return value;
}

function leaseIdentity(binding: CooperationAgentBinding): string {
  return JSON.stringify([binding.tabId, binding.boardId, binding.assignmentGeneration, binding.providerId,
    binding.ownerPluginId, binding.logicalRunId, binding.attemptId, binding.executionId]);
}
