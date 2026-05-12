import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VoiceActionPlan } from "@cloudx/shared";
import { parseVoiceActionPlan } from "@cloudx/shared";

export interface VoicePlanner {
  plan(input: { transcript: string; context: Record<string, unknown> }): Promise<VoiceActionPlan>;
}

export class CodexExecVoicePlanner implements VoicePlanner {
  constructor(private readonly model: string) {}

  async plan(input: { transcript: string; context: Record<string, unknown> }): Promise<VoiceActionPlan> {
    const prompt = buildVoicePrompt(input.transcript, input.context);
    const output = await runCodexExec(this.model, prompt);
    return parseVoiceActionPlan(JSON.parse(output));
  }
}

export function buildVoicePrompt(transcript: string, context: Record<string, unknown>): string {
  return [
    "You are the Cloudx voice controller.",
    "Return only JSON matching this shape:",
    "{\"transcript\":\"string\",\"summary\":\"string\",\"actions\":[{\"targetTabId\":\"string optional\",\"pluginId\":\"string optional\",\"action\":\"string\",\"input\":{},\"reason\":\"string optional\"}]}",
    "You may only select actions that are listed as voiceExposed in the provided plugin descriptors.",
    "Prefer entering text into the active tab when the command sounds like dictation.",
    "For multi-step requests, return actions in execution order.",
    "Never invent shell access. Never ask to run commands directly.",
    "",
    `Transcript: ${transcript}`,
    "",
    "Workspace context:",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

function runCodexExec(model: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--model", model, "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--output-schema", resolveVoiceSchemaPath(), "-"],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`codex exec voice planner failed with code ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(prompt);
  });
}

function resolveVoiceSchemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "voice-plan.schema.json"), path.resolve(here, "../../src/voice/voice-plan.schema.json")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Missing voice-plan.schema.json for Codex voice planner.");
  }
  return found;
}
