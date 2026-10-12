import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { mergeCodexConfigurationLayers, parseCodexConfiguration, withCodexLaunchModelDefault } from "./CodexConfigurationDocument.js";

interface NativeModelCapabilities {
  model: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
  supportsPersonality: boolean;
}

function supportsReasoningEffort(model: NativeModelCapabilities | undefined, effort: unknown): boolean {
  return typeof effort === "string" && Array.isArray(model?.supportedReasoningEfforts)
    && model.supportedReasoningEfforts.some(item => item?.reasoningEffort === effort);
}

function longestModelPrefix(models: NativeModelCapabilities[], requested: string): NativeModelCapabilities | undefined {
  let matched: NativeModelCapabilities | undefined;
  for (const model of models) {
    if (typeof model?.model === "string" && requested.startsWith(model.model)
      && (!matched || model.model.length > matched.model.length)) matched = model;
  }
  return matched;
}

function resolveNativeModelCapabilities(models: NativeModelCapabilities[], requested: unknown): NativeModelCapabilities | undefined {
  if (typeof requested !== "string") return undefined;
  const direct = longestModelPrefix(models, requested);
  if (direct) return direct;
  const namespaced = /^[A-Za-z0-9_-]+\/([^/]*)$/.exec(requested);
  return namespaced ? longestModelPrefix(models, namespaced[1]!) : undefined;
}

/** Parse the candidate with the selected native executable, without using its credentials or state. */
export async function validateNativeCodexConfiguration(command: string, config: string, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, profile: { name: string; text: string } | undefined, previous: Readonly<Record<string, unknown>>, checkPersonality: boolean): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-settings-validation-"));
  try {
    const base = parseCodexConfiguration(config);
    const candidate = withCodexLaunchModelDefault(profile ? mergeCodexConfigurationLayers(base, parseCodexConfiguration(profile.text)) : base);
    if (profile && candidate.profiles && typeof candidate.profiles === "object" && Object.hasOwn(candidate.profiles, profile.name))
      throw new Error(`Native Codex launch profile conflicts with legacy profiles.${profile.name}. Remove the legacy table before selecting this profile.`);
    const effective = stringify(candidate);
    const before = withCodexLaunchModelDefault(previous);
    const modelSourceChanged = candidate.model_provider !== previous.model_provider || candidate.model_catalog_json !== previous.model_catalog_json;
    const selectionChanged = candidate.model !== before.model || modelSourceChanged;
    const needsCapabilities = selectionChanged || checkPersonality
      || candidate.model_reasoning_effort !== previous.model_reasoning_effort || candidate.plan_mode_reasoning_effort !== previous.plan_mode_reasoning_effort
      || candidate.model_reasoning_effort !== undefined || candidate.plan_mode_reasoning_effort !== undefined;
    await fs.writeFile(path.join(home, "config.toml"), effective, { mode: 0o600 });
    if (profile) await fs.writeFile(path.join(home, `${profile.name}.config.toml`), profile.text, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["app-server", "--stdio", "-c", `sqlite_home=${JSON.stringify(home)}`, "-c", `log_dir=${JSON.stringify(home)}`, "-c", "features.remote_control=false"], {
        cwd: home, env: { PATH: env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "off" }, stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      let settled = false;
      let failure: Error | undefined;
      let advertised: NativeModelCapabilities | undefined;
      const stop = (error?: Error) => { if (settled) return; settled = true; failure = error; child.kill("SIGKILL"); };
      const aborted = () => stop(new Error("Codex settings validation cancelled."));
      const timeout = setTimeout(() => stop(new Error("Selected Codex did not validate the settings within 10 seconds.")), 10_000);
      signal?.addEventListener("abort", aborted, { once: true });
      child.once("error", () => stop(new Error("Selected Codex could not start to validate settings.")));
      child.once("close", () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        if (!settled) failure = new Error("Selected Codex rejected the candidate configuration. Check the selected version and native setting constraints.");
        failure ? reject(failure) : resolve();
      });
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 2_097_152) { stop(new Error("Native Codex configuration response exceeded the validation limit.")); return; }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            if (message.error) { stop(new Error("Selected Codex rejected configuration initialization.")); return; }
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: false } })}\n`);
          }
          if (message.id === 2) {
            if (message.error) stop(new Error("Selected Codex rejected the candidate settings. Check profile and native configuration constraints."));
            else if (needsCapabilities) child.stdin.write(`${JSON.stringify({ id: 3, method: "model/list", params: { includeHidden: true } })}\n`);
            else stop();
          }
          if (message.id === 3) {
            const models: NativeModelCapabilities[] = Array.isArray(message.result?.data) ? message.result.data : [];
            advertised = resolveNativeModelCapabilities(models, candidate.model);
            const mainInherited = candidate.model_reasoning_effort === undefined && (selectionChanged || previous.model_reasoning_effort !== undefined);
            const planInherited = candidate.plan_mode_reasoning_effort === undefined && previous.plan_mode_reasoning_effort !== undefined;
            const effort = mainInherited ? advertised?.defaultReasoningEffort : candidate.model_reasoning_effort;
            const inheritsNoMainEffort = mainInherited && effort === "none";
            if (message.error || !advertised) stop(new Error("Selected model capabilities are not advertised by native Codex. Configure a model catalog before changing model-specific defaults."));
            else if ((mainInherited || effort !== undefined) && !inheritsNoMainEffort && !supportsReasoningEffort(advertised, effort)) stop(new Error("Selected model does not advertise the chosen reasoning effort."));
            else if (candidate.plan_mode_reasoning_effort !== undefined && !supportsReasoningEffort(advertised, candidate.plan_mode_reasoning_effort)) stop(new Error("Selected model does not advertise the chosen Plan reasoning effort."));
            else if (checkPersonality && candidate.personality !== undefined && candidate.personality !== "none" && advertised.supportsPersonality !== true) stop(new Error("Selected model does not advertise personality support."));
            else if (planInherited) child.stdin.write(`${JSON.stringify({ id: 4, method: "collaborationMode/list", params: {} })}\n`);
            else stop();
          }
          if (message.id === 4) {
            const effort = Array.isArray(message.result?.data) ? message.result.data.find((item: { mode: string }) => item?.mode === "plan")?.reasoning_effort : undefined;
            if (message.error || !supportsReasoningEffort(advertised, effort))
              stop(new Error("Selected model does not advertise the inherited Plan reasoning effort. Set a supported Plan effort before unsetting its override or changing the model/profile."));
            else stop();
          }
        }
      });
      if (signal?.aborted) aborted();
      else child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "cloudx_settings_validation", version: "1.0.0" }, capabilities: { experimentalApi: true } } })}\n`);
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
