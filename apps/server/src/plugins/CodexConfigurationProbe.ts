import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { mergeCodexConfigurationLayers, parseCodexConfiguration } from "./CodexConfigurationDocument.js";
import { DEFAULT_CODEX_MODEL } from "@cloudx/shared";

/** Parse the candidate with the selected native executable, without using its credentials or state. */
export async function validateNativeCodexConfiguration(command: string, config: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, profile?: { name: string; text: string }, checkModel = false): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-settings-validation-"));
  try {
    const effective = profile ? stringify(mergeCodexConfigurationLayers(parseCodexConfiguration(config), parseCodexConfiguration(profile.text))) : config;
    const candidate = parseCodexConfiguration(effective);
    await fs.writeFile(path.join(home, "config.toml"), effective, { mode: 0o600 });
    if (profile) await fs.writeFile(path.join(home, `${profile.name}.config.toml`), profile.text, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["app-server", "--stdio", "-c", `sqlite_home=${JSON.stringify(home)}`, "-c", `log_dir=${JSON.stringify(home)}`, "-c", "features.remote_control=false"], {
        cwd: home, env: { PATH: env.PATH, HOME: home, CODEX_HOME: home, RUST_LOG: "off" }, stdio: ["pipe", "pipe", "ignore"],
      });
      let buffer = "";
      let settled = false;
      let failure: Error | undefined;
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
            else if (checkModel && (candidate.model_reasoning_effort !== undefined || candidate.personality !== undefined && candidate.personality !== "none")) child.stdin.write(`${JSON.stringify({ id: 3, method: "model/list", params: { includeHidden: true } })}\n`);
            else stop();
          }
          if (message.id === 3) {
            const model = candidate.model ?? DEFAULT_CODEX_MODEL;
            const advertised = message.result?.data?.find((item: { model: string }) => item.model === model);
            const effort = candidate.model_reasoning_effort;
            if (message.error || !advertised) stop(new Error("Selected model capabilities are not advertised by native Codex. Configure a model catalog before changing model-specific defaults."));
            else if (effort !== undefined && !advertised.supportedReasoningEfforts?.some((item: { reasoningEffort: string }) => item.reasoningEffort === effort)) stop(new Error("Selected model does not advertise the chosen reasoning effort."));
            else if (candidate.personality !== undefined && candidate.personality !== "none" && !advertised.supportsPersonality) stop(new Error("Selected model does not advertise personality support."));
            else stop();
          }
        }
      });
      if (signal?.aborted) aborted();
      else child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "cloudx_settings_validation", version: "1.0.0" }, capabilities: { experimentalApi: true } } })}\n`);
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
