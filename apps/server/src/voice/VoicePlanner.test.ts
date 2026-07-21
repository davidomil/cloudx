import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCodexExecArgs,
  buildCodexExecLaunch,
  buildVoicePrompt,
  CodexExecVoicePlanner,
  compactVoicePromptContext,
  runCodexExec,
  summarizeCodexError
} from "./VoicePlanner.js";

describe("buildVoicePrompt", () => {
  it("keeps plugin-specific behavior in descriptors instead of planner rules", () => {
    const prompt = buildVoicePrompt("list directory", {
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", pluginId: "standard-terminal", title: "Shell" }],
      plugins: [
        {
          id: "standard-terminal",
          actions: [{ name: "enter_text", voiceExposed: true, defaultForVoice: true }]
        }
      ]
    });

    expect(prompt).toContain("Do not blindly paste the transcript");
    expect(prompt).toContain("transcript is ASR output and is often wrong");
    expect(prompt).toContain("read that session's voiceContext and history.text");
    expect(prompt).toContain("handlesUnhandledVoice");
    expect(prompt).toContain("hookId");
    expect(prompt).toContain("if the transcript says 'run pink' in a terminal context, infer 'run ping'");
    expect(prompt).toContain("Plugin descriptions, hook descriptions, action descriptions, input schemas, voiceContext, and history are authoritative");
    expect(prompt).toContain("standardized plugin voiceContext");
    expect(prompt).toContain("do not invent plugin capabilities");
    expect(prompt).toContain("unique stable id");
    expect(prompt).toContain("dependsOn");
    expect(prompt).toContain("exact persisted windowId and paneId");
    expect(prompt).not.toContain("For standard-terminal enter_text");
    expect(prompt).not.toContain("For codex-terminal enter_text");
    expect(prompt).not.toContain("Use workspace-control");
    expect(prompt).not.toContain("set input.text to the full transcript");
  });

  it("compacts oversized workspace context before sending it to Codex exec", () => {
    const longActiveHistory = `${"old active output\n".repeat(2_000)}latest active command`;
    const longInactiveHistory = `${"old inactive output\n".repeat(2_000)}latest inactive command`;
    const prompt = buildVoicePrompt("run tests", {
      activeTabId: "tab-active",
      sessions: [
        {
          tabId: "tab-active",
          active: true,
          history: { text: longActiveHistory },
          voiceContext: {
            kind: "terminal",
            visibleText: "active visible\n".repeat(2_000),
            recentOutput: "active output\n".repeat(2_000)
          }
        },
        {
          tabId: "tab-inactive",
          active: false,
          history: { text: longInactiveHistory },
          voiceContext: {
            kind: "terminal",
            visibleText: "inactive visible\n".repeat(2_000),
            recentOutput: "inactive output\n".repeat(2_000)
          }
        }
      ]
    });

    expect(prompt.length).toBeLessThan(80_000);
    expect(prompt).toContain("contextBudget");
    expect(prompt).toContain("Cloudx voice context truncated");
    expect(prompt).toContain("latest active command");
    expect(prompt).toContain("latest inactive command");
  });
});

describe("compactVoicePromptContext", () => {
  it("keeps active session history larger than inactive session history", () => {
    const context = compactVoicePromptContext({
      sessions: [
        { tabId: "active", active: true, history: { text: "A".repeat(20_000) } },
        { tabId: "inactive", active: false, history: { text: "B".repeat(20_000) } }
      ]
    });

    const sessions = context.sessions as Array<{ history: { text: string } }>;
    expect(sessions[0]!.history.text.length).toBeGreaterThan(sessions[1]!.history.text.length);
    expect(sessions[0]!.history.text).toContain("kept 12000 last chars");
    expect(sessions[1]!.history.text).toContain("kept 2000 last chars");
  });

  it("keeps exact ids while trimming verbose descriptions", () => {
    const context = compactVoicePromptContext({
      hooks: [
        {
          id: "workspace.tabs.create",
          description: "Create tabs. ".repeat(500),
          inputSchema: { type: "object", properties: { pluginId: { type: "string" } } }
        }
      ]
    });

    expect(context).toMatchObject({
      hooks: [
        {
          id: "workspace.tabs.create",
          inputSchema: { type: "object", properties: { pluginId: { type: "string" } } }
        }
      ]
    });
    expect(JSON.stringify(context)).toContain("Cloudx voice context truncated");
  });
});

describe("buildCodexExecArgs", () => {
  it("forces medium reasoning for the voice planner subprocess", () => {
    expect(buildCodexExecArgs("gpt-5.3-codex-spark", "/schema.json", "/out.json")).toEqual(
      expect.arrayContaining(["-c", 'model_reasoning_effort="medium"', "--model", "gpt-5.3-codex-spark"])
    );
  });

  it("attaches image files to Codex exec prompts", () => {
    expect(buildCodexExecArgs("gpt-5.4-mini", "/schema.json", "/out.json", ["/tmp/schematic.png", "/tmp/detail.jpg"])).toEqual(
      expect.arrayContaining(["--image", "/tmp/schematic.png", "--image", "/tmp/detail.jpg", "--output-schema", "/schema.json"])
    );
  });
});

describe("voice-plan.schema.json", () => {
  it("keeps every object closed for strict structured output validation", async () => {
    const schema = JSON.parse(await fs.readFile(new URL("./voice-plan.schema.json", import.meta.url), "utf8"));

    expect(closedObjectSchemaIssues(schema)).toEqual([]);
  });
});

describe("buildCodexExecLaunch", () => {
  it("launches Codex exec with the configured assistant binary", () => {
    expect(
      buildCodexExecLaunch("gpt-5.3-codex-spark", "/schema.json", "/out.json", {
        CLOUDX_ASSISTANT_BIN: "/usr/bin/codex",
        SHELL: "/bin/bash"
      })
    ).toEqual({
      command: "/usr/bin/codex",
      args: [
        "exec",
        "-c",
        "streamable_shell=false",
        "-c",
        'model_reasoning_effort="medium"',
        "--model",
        "gpt-5.3-codex-spark",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--output-schema",
        "/schema.json",
        "--output-last-message",
        "/out.json",
        "-"
      ]
    });
  });
});

describe("summarizeCodexError", () => {
  it("extracts one-line Codex JSON errors and explains ChatGPT account model mismatches", () => {
    const message = summarizeCodexError(
      [
        "startup",
        "ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.\"}}"
      ].join("\n"),
      "gpt-5.3-codex-spark"
    );

    expect(message).toContain("gpt-5.3-codex-spark");
    expect(message).toContain("active ChatGPT account cannot use that model");
    expect(message).toContain("CLOUDX_VOICE_MODEL");
  });
});

describe("CodexExecVoicePlanner", () => {
  it("resolves the configured model provider for each plan request", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fake-codex-model-"));
    const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
    const previousAssistantBin = process.env.CLOUDX_ASSISTANT_BIN;
    let currentModel = "gpt-5.4";

    await fs.writeFile(
      fakeCodexPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const model = args[args.indexOf('--model') + 1];",
        "const outputPath = args[args.indexOf('--output-last-message') + 1];",
        "fs.writeFileSync(outputPath, JSON.stringify({ transcript: model, summary: model, actions: [] }));"
      ].join("\n"),
      "utf8"
    );
    await fs.chmod(fakeCodexPath, 0o755);
    process.env.CLOUDX_ASSISTANT_BIN = fakeCodexPath;

    try {
      const planner = new CodexExecVoicePlanner(() => currentModel);
      await expect(planner.plan({ transcript: "noop", context: {} })).resolves.toMatchObject({ summary: "gpt-5.4" });
      currentModel = "gpt-5.4-mini";
      await expect(planner.plan({ transcript: "noop", context: {} })).resolves.toMatchObject({ summary: "gpt-5.4-mini" });
    } finally {
      if (previousAssistantBin === undefined) {
        delete process.env.CLOUDX_ASSISTANT_BIN;
      } else {
        process.env.CLOUDX_ASSISTANT_BIN = previousAssistantBin;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects when the planner subprocess exceeds the output limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fake-codex-"));
    const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
    const previousAssistantBin = process.env.CLOUDX_ASSISTANT_BIN;

    await fs.writeFile(
      fakeCodexPath,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(1_100_000));\n",
      "utf8"
    );
    await fs.chmod(fakeCodexPath, 0o755);
    process.env.CLOUDX_ASSISTANT_BIN = fakeCodexPath;

    try {
      const planner = new CodexExecVoicePlanner("gpt-test");
      await expect(planner.plan({ transcript: "noop", context: {} })).rejects.toThrow("output limit");
    } finally {
      if (previousAssistantBin === undefined) {
        delete process.env.CLOUDX_ASSISTANT_BIN;
      } else {
        process.env.CLOUDX_ASSISTANT_BIN = previousAssistantBin;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Codex process-group escalation alive when the leader exits before its descendant", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fake-codex-abort-"));
    const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
    const startedPath = path.join(tempDir, "started.json");
    const previousAssistantBin = process.env.CLOUDX_ASSISTANT_BIN;
    const previousStartedPath = process.env.CLOUDX_TEST_CODEX_STARTED;
    await fs.writeFile(fakeCodexPath, [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "descendant.once('message', () => fs.writeFileSync(process.env.CLOUDX_TEST_CODEX_STARTED, JSON.stringify({ parent: process.pid, descendant: descendant.pid })));",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");
    await fs.chmod(fakeCodexPath, 0o755);
    process.env.CLOUDX_ASSISTANT_BIN = fakeCodexPath;
    process.env.CLOUDX_TEST_CODEX_STARTED = startedPath;
    const controller = new AbortController();
    const stopped = new Error("Codex runner stopped");

    try {
      const execution = runCodexExec("gpt-test", "prompt", { signal: controller.signal, timeoutMs: 5_000 });
      const pids = JSON.parse(await waitForFile(startedPath)) as { parent: number; descendant: number };
      controller.abort(stopped);
      const rejected = expect(execution).rejects.toBe(stopped);

      await waitUntil(() => !isProcessRunning(pids.parent));
      expect(isProcessRunning(pids.descendant)).toBe(true);

      await rejected;
      expect(isProcessRunning(pids.parent)).toBe(false);
      expect(isProcessRunning(pids.descendant)).toBe(false);
    } finally {
      if (previousAssistantBin === undefined) {
        delete process.env.CLOUDX_ASSISTANT_BIN;
      } else {
        process.env.CLOUDX_ASSISTANT_BIN = previousAssistantBin;
      }
      if (previousStartedPath === undefined) {
        delete process.env.CLOUDX_TEST_CODEX_STARTED;
      } else {
        process.env.CLOUDX_TEST_CODEX_STARTED = previousStartedPath;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process state.");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function closedObjectSchemaIssues(value: unknown, pathParts: string[] = ["#"]): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const issues: string[] = [];
  if (schemaAllowsObject(value)) {
    if (value.additionalProperties !== false) {
      issues.push(`${pathParts.join(".")} must set additionalProperties: false`);
    }
    const propertyNames = Object.keys(value.properties ?? {});
    const required = Array.isArray(value.required) ? value.required : [];
    const missingRequired = propertyNames.filter((property) => !required.includes(property));
    if (missingRequired.length > 0) {
      issues.push(`${pathParts.join(".")} must require properties: ${missingRequired.join(", ")}`);
    }
  }

  for (const [key, child] of Object.entries(value.properties ?? {})) {
    issues.push(...closedObjectSchemaIssues(child, [...pathParts, "properties", key]));
  }
  if ("items" in value) {
    issues.push(...closedObjectSchemaIssues(value.items, [...pathParts, "items"]));
  }
  if (Array.isArray(value.anyOf)) {
    value.anyOf.forEach((child, index) => {
      issues.push(...closedObjectSchemaIssues(child, [...pathParts, "anyOf", String(index)]));
    });
  }
  if (isRecord(value.$defs)) {
    for (const [key, child] of Object.entries(value.$defs)) {
      issues.push(...closedObjectSchemaIssues(child, [...pathParts, "$defs", key]));
    }
  }
  return issues;
}

function schemaAllowsObject(schema: Record<string, unknown>): boolean {
  return schema.type === "object" || Array.isArray(schema.type) && schema.type.includes("object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
