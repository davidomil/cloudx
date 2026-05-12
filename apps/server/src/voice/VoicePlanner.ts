import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
    "For unused optional structured fields, use null or omit them when the schema allows omission.",
    "You may only select actions that are listed as voiceExposed in the provided plugin descriptors.",
    "Workspace context includes per-session standardized plugin voiceContext, visibleText, openFile, currentPath, and voiceActions. It also includes client.panes with exact pane ids, active pane, tab ids, active tab, and approximate visual positions. Use that state before choosing actions.",
    "Every transcript has already been routed through you. Do not blindly paste the transcript into the active tab.",
    "Actions marked defaultForVoice are safe default tools after you have interpreted the user's intent.",
    "For standard-terminal enter_text, translate natural-language shell requests into concise shell commands and submit them. Example: transcript 'list directory' becomes input.text 'ls' with input.submit true.",
    "For codex-terminal enter_text, send the instruction that should be given to the interactive Codex CLI. Usually keep coding/editing requests as natural-language instructions for Codex, not shell commands.",
    "For file-browser actions, use list_directory and open_file to inspect files. Use replace_in_file when you can identify an exact oldText/newText edit from context, and write_file only when the full intended content is known.",
    "If the active file-browser session already has an openFile, treat that as the current file unless the transcript names a different file.",
    "Use workspace-control.select_pane for explicit requests to focus an existing pane by position. Use exact input.paneId from client.panes.",
    "Use workspace-control.split_pane for pane split requests. Set input.paneId when the user names a pane by position; the newly created pane becomes active for following actions.",
    "Use workspace-control.create_tab for requests to open a new Codex, terminal, or file tab. For 'new Codex pane', set input.targetPluginId 'codex-terminal' and input.newPane true. To open into an existing pane, set input.paneId to the exact pane id.",
    "For workspace-control.create_tab paths, use workspace paths context. Map 'home' to input.cwd '~'. Prefer an existing tab cwd when the user refers to that tab or folder.",
    "For pane placement, splitDirection 'row' means side-by-side columns with a vertical divider. splitDirection 'column' means stacked rows with a horizontal divider. When the user says split horizontally, prefer 'column'; when they say split vertically, prefer 'row'.",
    "When targeting a tab, targetTabId must be an exact tab id from workspace context. For the active tab, you may omit targetTabId and let Cloudx use activeTabId.",
    "Only type the user's words exactly when they clearly ask to dictate, type, or enter exact text.",
    "Use workspace-control.switch_tab for explicit requests to switch, activate, select, or focus another tab.",
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
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-voice-plan-"));
    const outputPath = path.join(outputDir, "last-message.json");
    const child = spawn(
      "codex",
      buildCodexExecArgs(model, resolveVoiceSchemaPath(), outputPath),
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
        try {
          resolve(fs.readFileSync(outputPath, "utf8").trim());
        } catch {
          resolve(extractLastJsonObject(stdout));
        } finally {
          fs.rmSync(outputDir, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(outputDir, { recursive: true, force: true });
        reject(new Error(`codex exec voice planner failed with code ${code}: ${summarizeCodexError(stderr || stdout)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

export function buildCodexExecArgs(model: string, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "-c",
    "streamable_shell=false",
    "-c",
    'model_reasoning_effort="medium"',
    "--model",
    model,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-"
  ];
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

function extractLastJsonObject(output: string): string {
  const trimmed = output.trim();
  const start = trimmed.lastIndexOf("\n{");
  if (start !== -1) {
    return trimmed.slice(start + 1);
  }
  return trimmed;
}

function summarizeCodexError(output: string): string {
  const matches = Array.from(output.matchAll(/ERROR:\s*(\{[\s\S]*?\n\})/g));
  const last = matches.at(-1)?.[1];
  if (last) {
    try {
      const parsed = JSON.parse(last) as { error?: { message?: string; code?: string }; status?: number };
      const message = parsed.error?.message;
      if (message) {
        return parsed.error?.code ? `${parsed.error.code}: ${message}` : message;
      }
    } catch {
      return last;
    }
  }
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-12).join("\n");
}
