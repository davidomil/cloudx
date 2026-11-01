import fs from "node:fs/promises";
import path from "node:path";
import type { CodexLaunchPolicyInspection } from "@cloudx/shared";
import { readCodexConfiguration } from "./CodexConfigurationSettings.js";
import type { CodexStateSources } from "./CodexStateSources.js";

/** Inspect owned generated state without starting a client or reading credential values. */
export async function inspectCodexLaunchPolicy(sources: CodexStateSources, tabId: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CodexLaunchPolicyInspection> {
  const text = await sources.readLaunchConfig(tabId, signal);
  const sourcePath = path.join(sources.viewPath(tabId), "config.toml");
  const configuration = readCodexConfiguration(text, "unrecorded-launch-version", "unobserved", sourcePath, false);
  const skillConfig = (configuration.values.skills as Record<string, unknown> | undefined)?.config;
  if (Array.isArray(skillConfig) && skillConfig.length > 4096) throw new Error("Codex launch skill inspection exceeds the path limit.");
  const skills: CodexLaunchPolicyInspection["skills"] = [];
  for (const entry of Array.isArray(skillConfig) ? skillConfig : []) {
    if (signal?.aborted) throw new Error("Codex launch inspection cancelled.");
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.enabled !== "boolean") continue;
    const source = skillSource(entry.path, sources.viewPath(tabId));
    let available = false;
    try { available = (await fs.stat(path.basename(entry.path) === "SKILL.md" ? entry.path : path.join(entry.path, "SKILL.md"))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
    skills.push({
      path: entry.path, source, available, enabled: entry.enabled,
      freshDefault: source === "cloudx-system" ? "enabled" : source === "selected-template" ? "template-dependent" : source === "native-vendor-cache" ? path.basename(entry.path) === "imagegen" ? "enabled" : "disabled" : "native-config",
      provenance: source === "native-vendor-cache" ? "Shared-cache artifact; selected-CLI version provenance unverified" : source === "native-config" ? "Explicit/discovered native path recorded in the generated configuration" : "CloudX generated launch selection",
    });
  }
  if (signal?.aborted) throw new Error("Codex launch inspection cancelled.");
  return {
    tabId, sourcePath, observation: "generated-config-on-disk", values: configuration.values, skills,
    serverEnvironmentKeys: Object.keys(env).filter(key => /^(?:CODEX_|OPENAI_|AZURE_|AWS_|GOOGLE_|GCLOUD_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/.test(key) && env[key] !== undefined).sort(),
    unresolvedLayers: [
      "The generated file is observed on disk, not read back from a running client; later edits may differ from its in-memory state.",
      "The launch executable version, process environment, explicit arguments and selected account are not recorded in this inspection; the current selected version is not substituted.",
      "Trusted project/nested project configuration, enforced administrator requirements and later skill discovery are evaluated by the native client and are not observed here.",
      "Environment names describe the current CloudX server, not the historical process environment. Values are never returned.",
    ],
  };
}

function skillSource(skillPath: string, home: string): CodexLaunchPolicyInspection["skills"][number]["source"] {
  for (const [directory, source] of [["cloudx-system", "cloudx-system"], ["cloudx", "selected-template"], ["cloudx-exceptions", "native-vendor-cache"]] as const) {
    const relative = path.relative(path.join(home, "skills", directory), skillPath);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return source;
  }
  return "native-config";
}
