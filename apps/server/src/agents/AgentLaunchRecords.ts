import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentLaunchRecord, AgentProviderId } from "@cloudx/shared";
import { JsonStateFile } from "../jsonStateFile.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_SOURCE_BYTES = 524_288;
const OMITTED = "[omitted]";
const VALUE_FLAGS = new Set(["--model", "-m", "--profile", "-p", "--effort", "--permission-mode", "--settings", "--add-dir", "--cd", "--session-id", "--resume", "--remote", "--append-system-prompt-file"]);
const SWITCH_FLAGS = new Set(["--yolo", "--dangerously-skip-permissions", "--continue", "--no-alt-screen"]);

export class AgentLaunchRecords {
  constructor(private readonly dataDir: string) {}

  async record(input: {
    providerId: AgentProviderId; tabId: string; executionId: string; command: string;
    version?: string; accountId?: string; cwd: string; args: string[];
    env: NodeJS.ProcessEnv; enforcedEnvironmentKeys: string[]; configurationPaths: string[];
    skillSelections?: AgentLaunchRecord["skillSelections"];
  }): Promise<AgentLaunchRecord> {
    const version = input.version?.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0] ?? null;
    const record = parseRecord({
      providerId: input.providerId, tabId: input.tabId, executionId: input.executionId,
      command: input.command, version, accountId: input.accountId ?? null, cwd: input.cwd,
      recordedAt: new Date().toISOString(), arguments: publicArguments(input.args),
      environmentKeys: Object.keys(input.env).filter(key => input.env[key] !== undefined).sort(),
      enforcedEnvironmentKeys: [...new Set(input.enforcedEnvironmentKeys)].sort(),
      skillSelections: input.skillSelections ?? [],
      configurationSources: await Promise.all([...new Set(input.configurationPaths)].map(sourceFingerprint)),
    });
    await this.file(input.tabId, input.providerId).write(record);
    return record;
  }

  async read(tabId: string, providerId: AgentProviderId): Promise<AgentLaunchRecord | undefined> {
    const file = this.file(tabId, providerId);
    try {
      if ((await fs.lstat(file.filePath)).size > 262_144) throw new Error("Agent launch record exceeds the inspection limit.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const value = await file.read<unknown>();
    if (value === undefined) return undefined;
    const record = parseRecord(value);
    if (record.tabId !== tabId || record.providerId !== providerId) throw new Error("Agent launch record identity does not match its owner.");
    return record;
  }

  private file(tabId: string, providerId: AgentProviderId): JsonStateFile {
    if (!ID.test(tabId) || !["codex", "claude"].includes(providerId)) throw new Error("Invalid agent launch record owner.");
    return new JsonStateFile(this.dataDir, path.join("agent-launch-records", `${providerId}-${tabId}.json`), "Agent launch record", 0o600);
  }
}

function publicArguments(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < Math.min(args.length, 512); index++) {
    const arg = args[index]!;
    if (arg === "--") { result.push("--", OMITTED); break; }
    if (SWITCH_FLAGS.has(arg)) result.push(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      const safe = typeof value === "string" && (
        ["--settings", "--add-dir", "--cd", "--append-system-prompt-file"].includes(arg) ? path.isAbsolute(value)
          : ["--model", "-m"].includes(arg) ? /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/u.test(value)
          : ["--profile", "-p", "--session-id", "--resume"].includes(arg) ? ID.test(value)
          : arg === "--permission-mode" ? ["manual", "acceptEdits", "auto", "plan", "bypassPermissions"].includes(value)
          : arg === "--effort" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value) : false);
      result.push(arg, safe ? value! : OMITTED);
      index++;
    } else if (arg === "-c" || arg === "--config") { result.push(arg, OMITTED); index++; }
    else result.push(OMITTED);
  }
  return result;
}

async function sourceFingerprint(source: string): Promise<AgentLaunchRecord["configurationSources"][number]> {
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { path: source, state: "unobserved" };
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    return length > MAX_SOURCE_BYTES ? { path: source, state: "unobserved" }
      : { path: source, state: "file", sha256: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") };
  } catch (error) {
    return { path: source, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unobserved" };
  } finally { await file?.close(); }
}

function parseRecord(value: unknown): AgentLaunchRecord {
  const invalid = () => { throw new Error("Invalid agent launch record."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as AgentLaunchRecord;
  const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
  const names = (value: unknown) => Array.isArray(value) && value.length <= 4096 && value.every(key => text(key, 256) && ENVIRONMENT_KEY.test(key));
  if (!["codex", "claude"].includes(record.providerId) || !text(record.tabId, 128) || !ID.test(record.tabId)
    || !text(record.executionId, 128) || !ID.test(record.executionId) || !text(record.command) || !text(record.cwd)
    || !text(record.recordedAt, 24) || !Number.isFinite(Date.parse(record.recordedAt))
    || record.version !== null && (!text(record.version, 128) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.version))
    || record.accountId !== null && (!text(record.accountId, 128) || !ID.test(record.accountId))
    || !Array.isArray(record.arguments) || record.arguments.length > 1024 || !record.arguments.every(arg => text(arg))
    || !names(record.environmentKeys) || !names(record.enforcedEnvironmentKeys)
    || !Array.isArray(record.skillSelections) || record.skillSelections.length > 4096
    || record.skillSelections.some(skill => !skill || !text(skill.name, 128) || !ID.test(skill.name)
      || !["personal", "synced"].includes(skill.source) || typeof skill.selected !== "boolean" || typeof skill.available !== "boolean")
    || !Array.isArray(record.configurationSources) || record.configurationSources.length > 128
    || record.configurationSources.some(source => !source || !text(source.path) || !path.isAbsolute(source.path)
      || !["file", "missing", "unobserved"].includes(source.state)
      || source.state === "file" && (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256))
      || source.state !== "file" && source.sha256 !== undefined)) return invalid();
  return {
    providerId: record.providerId, tabId: record.tabId, executionId: record.executionId, recordedAt: record.recordedAt,
    command: record.command, version: record.version, accountId: record.accountId, cwd: record.cwd,
    arguments: publicArguments(record.arguments), environmentKeys: record.environmentKeys, enforcedEnvironmentKeys: record.enforcedEnvironmentKeys,
    skillSelections: record.skillSelections.map(skill => ({ name: skill.name, source: skill.source, selected: skill.selected, available: skill.available })),
    configurationSources: record.configurationSources.map(source => ({ path: source.path, state: source.state, ...(source.sha256 ? { sha256: source.sha256 } : {}) })),
  };
}
