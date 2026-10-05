import { createHash } from "node:crypto";
import path from "node:path";

import type { CodexConfigRepairPreview } from "@cloudx/shared";
import { parse, type TomlTable } from "smol-toml";
import { parseTOML, type AST } from "toml-eslint-parser";

import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";
import type { CodexStateSources } from "./CodexStateSources.js";

// These exact release schemas exclude the two flags and locate the acknowledgement in notice.
// https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/config.schema.json
const reviewedVersions = new Set(["0.156.1", "0.157.1", "0.160.0"]);
const legacyFlags = ["ghost_commit", "streamable_shell"];
const acknowledgement = "hide_full_access_warning";

export class CodexConfigRepairService {
  constructor(private readonly sources: CodexStateSources, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async read(signal?: AbortSignal): Promise<CodexConfigRepairPreview> {
    return (await this.review(signal)).preview;
  }

  async apply(expectedRevision: string, signal?: AbortSignal): Promise<CodexConfigRepairPreview> {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("Invalid Codex configuration repair revision.");
    const { preview, source, original, replacement } = await this.review(signal);
    if (preview.revision !== expectedRevision) throw new Error("Codex source configuration or selected executable changed. Reload the repair before applying it.");
    if (!preview.canApply || replacement === undefined) throw new Error(preview.blockedReason ?? "No reviewed Codex configuration repair is available.");
    await this.sources.replaceConfig(source, original, replacement, signal);
    return this.read(signal);
  }

  private async review(signal?: AbortSignal) {
    const source = await this.sources.resolve(signal);
    const original = await this.sources.readConfig(source, signal);
    const env = buildToolEnv(this.env);
    const selectedCommand = resolveAssistantCommand(env);
    const selectedVersion = await readCodexVersion(selectedCommand, { env, signal });
    const plan = planRepair(original ?? "");
    const blockedReason = !reviewedVersions.has(selectedVersion)
      ? `No correction has been reviewed for selected Codex ${selectedVersion}. The source is unchanged; review its versioned schema before editing.`
      : plan.blockedReason;
    const preview: CodexConfigRepairPreview = {
      revision: createHash("sha256").update(JSON.stringify([source, original ?? null, selectedCommand, selectedVersion])).digest("hex"),
      sourceConfigPath: path.join(source.home, "config.toml"), selectedCommand, selectedVersion,
      changes: plan.changes, blockedReason, canApply: plan.changes.length > 0 && blockedReason === null,
    };
    return { preview, source, original, replacement: blockedReason === null ? plan.replacement : undefined };
  }
}

export function legacyCodexConfigKeys(text: string): string[] {
  const config = parseConfig(text);
  const features = config.features as TomlTable | undefined;
  return [
    ...legacyFlags.filter(key => features?.[key] !== undefined).map(key => `features.${key}`),
    ...(config[acknowledgement] !== undefined ? [acknowledgement] : []),
  ];
}

function parseConfig(text: string): TomlTable {
  try { return parse(text); }
  catch { throw new Error("Shared Codex configuration contains invalid TOML. No repair was saved."); }
}

function planRepair(text: string): { changes: string[]; replacement?: string; blockedReason: string | null } {
  const config = parseConfig(text);
  const keys = legacyCodexConfigKeys(text);
  const changes = keys.map(key => key === acknowledgement
    ? `Move ${acknowledgement} to notice.${acknowledgement}, preserving its boolean value.`
    : `Remove unsupported ${key}.`);
  const notice = config.notice as TomlTable | undefined;
  const rootValue = config[acknowledgement];
  if (rootValue !== undefined && (typeof rootValue !== "boolean" || (notice !== undefined && (!notice || typeof notice !== "object" || Array.isArray(notice) || notice instanceof Date))))
    return { changes, blockedReason: "The acknowledgement must be a boolean and notice must be a table. Review the source before repairing." };
  if (rootValue !== undefined && notice?.[acknowledgement] !== undefined && notice[acknowledgement] !== rootValue)
    return { changes, blockedReason: "Root and notice acknowledgements conflict. Review the source and choose the intended value before repairing." };
  let replacement = text;
  for (const key of keys) replacement = removeSetting(replacement, key.split("."));
  if (rootValue !== undefined && notice?.[acknowledgement] === undefined) replacement = addNotice(replacement, rootValue as boolean);
  parseConfig(replacement);
  return { changes, replacement, blockedReason: null };
}

interface Setting { entry: AST.TOMLKeyValue; table?: AST.TOMLInlineTable }

function document(text: string) { return parseTOML(text, { tomlVersion: "1.1" }).body[0].body; }
function parts(key: AST.TOMLKey) { return key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value); }
function equalPath(left: string[], right: string[]) { return left.length === right.length && left.every((part, i) => part === right[i]); }

function findSetting(text: string, wanted: string[]): Setting | undefined {
  const visit = (entry: AST.TOMLKeyValue, prefix: string[], table?: AST.TOMLInlineTable): Setting | undefined => {
    const key = [...prefix, ...parts(entry.key)];
    if (equalPath(key, wanted)) return { entry, table };
    if (entry.value.type === "TOMLInlineTable") {
      for (const child of entry.value.body) {
        const found = visit(child, key, entry.value);
        if (found) return found;
      }
    }
  };
  for (const item of document(text)) {
    if (item.type === "TOMLKeyValue") {
      const found = visit(item, []);
      if (found) return found;
    } else {
      for (const entry of item.body) {
        const found = visit(entry, parts(item.key));
        if (found) return found;
      }
    }
  }
}

function replace(text: string, start: number, end: number, value = "") { return text.slice(0, start) + value + text.slice(end); }

function removeSetting(text: string, key: string[]): string {
  const found = findSetting(text, key);
  if (!found) throw new Error("Codex configuration uses an unsupported key shape. No repair was saved.");
  const [start, end] = found.entry.range;
  let result = text;
  if (found.table) {
    const siblings = found.table.body;
    const index = siblings.indexOf(found.entry);
    const tokens = parseTOML(text, { tomlVersion: "1.1" }).tokens;
    const after = siblings[index + 1]?.range[0] ?? found.table.range[1] - 1;
    const before = siblings[index - 1]?.range[1] ?? found.table.range[0] + 1;
    const commas = tokens.filter(token => token.type === "Punctuator" && token.value === ",");
    const comma = commas.find(token => token.range[0] >= end && token.range[1] <= after)
      ?? commas.find(token => token.range[0] >= before && token.range[1] <= start);
    if (comma) {
      if (comma.range[0] >= end) result = replace(result, comma.range[0], comma.range[1]);
      else return replace(replace(result, start, end), comma.range[0], comma.range[1]);
    }
  }
  return replace(result, start, end);
}

function addNotice(text: string, value: boolean): string {
  const table = document(text).find(item => item.type === "TOMLTable" && equalPath(parts(item.key), ["notice"]));
  if (table?.type === "TOMLTable") {
    const lineEnd = text.indexOf("\n", table.key.range[1]);
    const insertion = lineEnd === -1 ? text.length : lineEnd + 1;
    return replace(text, insertion, insertion, `${lineEnd === -1 ? "\n" : ""}${acknowledgement} = ${value}\n`);
  }
  const inline = findSetting(text, ["notice"])?.entry.value;
  if (inline?.type === "TOMLInlineTable") {
    return replace(text, inline.range[0] + 1, inline.range[0] + 1, ` ${acknowledgement} = ${value}${inline.body.length ? "," : ""} `);
  }
  return `notice.${acknowledgement} = ${value}\n${text}`;
}
