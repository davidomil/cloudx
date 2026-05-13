import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VoiceActionPlan } from "@cloudx/shared";
import { parseVoiceActionPlan } from "@cloudx/shared";
import {
  planLogFields,
  serializeError,
  summarizeVoiceContext,
  transcriptLogFields,
  type StructuredVoiceLogger,
  type VoiceDebugLogOptions,
  type VoiceTrace
} from "./VoiceDebugLog.js";

export interface VoicePlannerInput extends VoiceTrace {
  transcript: string;
  context: Record<string, unknown>;
}

export interface VoicePlanner {
  plan(input: VoicePlannerInput): Promise<VoiceActionPlan>;
}

export class CodexExecVoicePlanner implements VoicePlanner {
  constructor(
    private readonly model: string,
    private readonly logger?: StructuredVoiceLogger,
    private readonly logOptions: VoiceDebugLogOptions = {}
  ) {}

  async plan(input: VoicePlannerInput): Promise<VoiceActionPlan> {
    const prompt = buildVoicePrompt(input.transcript, input.context);
    const startedAt = Date.now();
    this.logger?.info(
      {
        event: "voice_planner_codex_exec_started",
        voiceRequestId: input.voiceRequestId,
        source: input.source,
        model: this.model,
        promptChars: prompt.length,
        ...transcriptLogFields(input.transcript, this.logOptions.includeText),
        context: summarizeVoiceContext(input.context)
      },
      "voice planner codex exec started"
    );

    try {
      const output = await runCodexExec(this.model, prompt);
      const plan = parseVoiceActionPlan(JSON.parse(output));
      this.logger?.info(
        {
          event: "voice_planner_codex_exec_completed",
          voiceRequestId: input.voiceRequestId,
          source: input.source,
          model: this.model,
          durationMs: Date.now() - startedAt,
          outputChars: output.length,
          ...planLogFields(plan, this.logOptions.includeText)
        },
        "voice planner codex exec completed"
      );
      return plan;
    } catch (error) {
      this.logger?.error(
        {
          event: "voice_planner_codex_exec_failed",
          voiceRequestId: input.voiceRequestId,
          source: input.source,
          model: this.model,
          durationMs: Date.now() - startedAt,
          err: serializeError(error)
        },
        "voice planner codex exec failed"
      );
      throw error;
    }
  }
}

export function buildVoicePrompt(transcript: string, context: Record<string, unknown>): string {
  return [
    "You are the Cloudx voice controller.",
    "Return only JSON matching this shape:",
    "{\"transcript\":\"string\",\"summary\":\"string\",\"actions\":[{\"targetTabId\":\"string optional\",\"pluginId\":\"string optional\",\"action\":\"string\",\"input\":{},\"reason\":\"string optional\"}]}",
    "For unused optional structured fields, use null or omit them when the schema allows omission.",
    "You may only select actions that are listed as voiceExposed in the provided plugin descriptors.",
    "Workspace context includes per-session standardized plugin voiceContext, visibleText, openFile, currentPath, voiceActions, and history.text. history.text is the tab context file and contains recent terminal output, plugin actions, and prior voice actions. It also includes client.panes with exact pane ids, active pane, tab ids, active tab, and approximate visual positions. Use that state before choosing actions.",
    "The transcript is ASR output and is often wrong. Treat it as a noisy hint, not ground truth. Infer the user's likely command from the transcript plus workspace state, active pane, active tab, visible text, open file, current path, terminal history, and prior voice actions.",
    "Before choosing actions, internally do these steps: identify the target pane/tab if one exists; read that session's voiceContext and history.text; if no target exists, read the active session history; compare the noisy transcript against what the user is likely doing in that context; then choose plugin actions.",
    "When ASR gives a plausible but wrong word, prefer the command that fits the local context and common developer vocabulary. Example: if the transcript says 'run pink' in a terminal context, infer 'run ping' and send input.text 'ping' with input.submit true.",
    "Every transcript has already been routed through you. Do not blindly paste the transcript into the active tab.",
    "Actions marked defaultForVoice are safe default tools after you have interpreted the user's intent.",
    "Actions marked handlesUnhandledVoice are plugin-owned fallbacks Cloudx may use if you return zero actions for unresolved general speech.",
    "Plugin descriptions, action descriptions, input schemas, voiceContext, and history are authoritative for what each plugin can do and how each action should be used.",
    "Use exact plugin ids, tab ids, pane ids, action names, and input fields from the provided context; do not invent plugin capabilities.",
    "For paths, use workspace paths context, the active session cwd, or path guidance exposed by the chosen plugin action schema.",
    "For pane placement, follow the descriptions and enums exposed by the workspace action schemas and the exact pane ids in client.panes.",
    "When targeting a tab, targetTabId must be an exact tab id from workspace context. For the active tab, you may omit targetTabId and let Cloudx use activeTabId.",
    "Only type the user's words exactly when they clearly ask to dictate, type, or enter exact text.",
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
