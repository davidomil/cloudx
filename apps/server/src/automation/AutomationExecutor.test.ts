import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonSchemaLike } from "@cloudx/plugin-api";
import type { AutomationCatalogResponse, AutomationGroup, AutomationSafety, TriggerEvent } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("runs a trigger-to-hook graph and records trace output", async () => {
    const hooks = new HookRegistry();
    hooks.register({
      id: "test.echo",
      owner: { kind: "app" },
      title: "Echo",
      description: "Echo text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input, context) => ({ echoed: input.text, caller: context.caller.kind })
    });

    const run = await new AutomationExecutor().execute(group(), event(), catalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Running Test Trigger.", "Echo completed.", "finished"]));
  });

  it("keeps the reserved trigger payload output stable when payload fields collide", async () => {
    const hooks = new HookRegistry();
    let receivedValue: unknown;
    hooks.register({
      id: "test.capturePayload",
      owner: { kind: "app" },
      title: "Capture Payload",
      description: "Captures the full trigger payload.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "object" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        receivedValue = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(payloadCollisionGroup(), payloadCollisionEvent(), payloadCollisionCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedValue).toEqual({ payload: "shadow", text: "hello" });
  });

  it("passes trigger exec payload fields through data edges without blocking program flow", async () => {
    const hooks = new HookRegistry();
    let receivedValue: unknown;
    hooks.register({
      id: "test.captureExecField",
      owner: { kind: "app" },
      title: "Capture Exec Field",
      description: "Captures a payload field named exec.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        receivedValue = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(execPayloadFieldGroup(), execPayloadFieldEvent(), execPayloadFieldCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedValue).toBe("payload-exec");
  });

  it("uses catalog input defaults when a node has no configured value or data edge", async () => {
    const hooks = new HookRegistry();
    let received = "";
    hooks.register({
      id: "test.defaulted",
      owner: { kind: "app" },
      title: "Defaulted",
      description: "Reads a default.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input) => {
        received = String(input.text);
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(defaultValueGroup(), event(), defaultValueCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(received).toBe("from-catalog");
  });

  it("passes plugin hook targetTabId through call context without adding it to hook input", async () => {
    const hooks = new HookRegistry();
    let receivedInput: Record<string, unknown> | undefined;
    let receivedTargetTabId: string | undefined;
    hooks.register({
      id: "test.pluginAction",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Plugin Action",
      description: "Captures context.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input, context) => {
        receivedInput = input;
        receivedTargetTabId = context.targetTabId;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(targetTabGroup(), event(), targetTabCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedInput).toEqual({ text: "hello" });
    expect(receivedTargetTabId).toBe("tab-2");
  });

  it("keeps schema-owned plugin targetTabId values in hook input", async () => {
    const hooks = new HookRegistry();
    let receivedInput: Record<string, unknown> | undefined;
    let receivedTargetTabId: string | undefined;
    hooks.register({
      id: "test.schemaTargetTab",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Schema Target Tab",
      description: "Captures a schema-owned targetTabId.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          targetTabId: { type: "string" },
          text: { type: "string" }
        },
        required: ["targetTabId", "text"],
        additionalProperties: false
      },
      execute: (input, context) => {
        receivedInput = input;
        receivedTargetTabId = context.targetTabId;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(schemaOwnedTargetTabGroup(), event(), schemaOwnedTargetTabCatalog(), hooks);

    expect(run.status).toBe("succeeded");
    expect(receivedInput).toEqual({ targetTabId: "payload-tab", text: "hello" });
    expect(receivedTargetTabId).toBeUndefined();
  });

  it("blocks unsafe hooks at execution time even if validation is bypassed", async () => {
    const hooks = new HookRegistry();
    let called = false;
    hooks.register({
      id: "test.external",
      owner: { kind: "app" },
      title: "External",
      description: "External action.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        called = true;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(externalHookGroup(), event(), externalHookCatalog(), hooks);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("requires external automation safety");
    expect(called).toBe(false);
  });

  it("reconstructs nested hook inputs and exposes nested hook outputs as leaf ports", async () => {
    const hooks = new HookRegistry();
    let createInput: Record<string, unknown> | undefined;
    let notifyInput: Record<string, unknown> | undefined;
    hooks.register({
      id: "test.createWindow",
      owner: { kind: "app" },
      title: "Create Window",
      description: "Creates a window.",
      exposures: ["automation"],
      inputSchema: nestedCreateInputSchema(),
      outputSchema: nestedCreateOutputSchema(),
      execute: (input) => {
        createInput = input;
        return {
          window: {
            id: "window-1",
            name: (input.indicator as Record<string, unknown>).label,
            defaultCwd: "/tmp/feature"
          }
        };
      }
    });
    hooks.register({
      id: "test.notify",
      owner: { kind: "app" },
      title: "Notify",
      description: "Sends a notification.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" }
        },
        required: ["title"],
        additionalProperties: false
      },
      execute: (input) => {
        notifyInput = input;
        return {};
      }
    });

    const catalog = await nestedCatalog();
    const run = await new AutomationExecutor().execute(nestedHookGroup(), event(), catalog, hooks);

    expect(run.status).toBe("succeeded");
    expect(createInput).toEqual({ indicator: { color: "green", label: "feature-folder" } });
    expect(notifyInput).toEqual({ title: "feature-folder" });
  });

  it("rejects unsafe dotted hook input paths without polluting object prototypes", async () => {
    const hooks = new HookRegistry();
    hooks.register({
      id: "test.unsafe",
      owner: { kind: "app" },
      title: "Unsafe",
      description: "Uses an unsafe dotted input path.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true
      },
      execute: () => ({})
    });

    const run = await new AutomationExecutor().execute(unsafePathGroup(), event(), unsafePathCatalog(), hooks);

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Unsafe automation path segment: __proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("creates variables and evaluates array primitives", async () => {
    const run = await new AutomationExecutor().execute(variableArrayGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["2"]));
  });

  it("invalidates cached data node outputs after variable writes inside loops", async () => {
    const run = await new AutomationExecutor().execute(whileVariableMutationGroup(), event(), await primitiveCatalog(), new HookRegistry(), { maxSteps: 50 });

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["done"]));
    expect(run.error).toBeUndefined();
  });

  it("evaluates string operation primitives", async () => {
    const run = await new AutomationExecutor().execute(stringOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["world", "brave", "true"]));
  });

  it("rejects unsafe regular expression primitives before matching text", async () => {
    const run = await new AutomationExecutor().execute(regexPrimitiveGroup("primitive:string.regex.test", { pattern: "(a+)+$", text: `${"a".repeat(32)}!` }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("regular expression is too complex");
  });

  it("rejects invalid regular expression flags before matching text", async () => {
    const run = await new AutomationExecutor().execute(regexPrimitiveGroup("primitive:string.regex.extract", { pattern: "hello", flags: "ii", text: "hello" }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("has an invalid regular expression");
  });

  it("rejects non-boolean control-flow conditions instead of using truthiness", async () => {
    const run = await new AutomationExecutor().execute(nonBooleanConditionGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("requires condition to be a boolean");
    expect(run.trace.map((entry) => entry.message)).not.toContain("true branch");
  });

  it("lets explicit string-template config values override variables even when nullish", async () => {
    const run = await new AutomationExecutor().execute(nullTemplateOverrideGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Hello "]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("Hello fallback");
  });

  it("resolves string-template payload paths through owned nested fields only", async () => {
    const run = await new AutomationExecutor().execute(stringTemplatePayloadPathGroup(), nestedPayloadEvent(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["User Ada / inherited="]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("Object");
  });

  it("evaluates Python-style f-string primitives with dynamic inputs", async () => {
    const run = await new AutomationExecutor().execute(fStringGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(['Hi "hello", total=3.50, literal {ok}']));
  });

  it("does not resolve inherited properties from f-string payload paths", async () => {
    const run = await new AutomationExecutor().execute(fStringInheritedPayloadGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["payload="]));
    expect(run.trace.map((entry) => entry.message)).not.toContain("payload=Object");
  });

  it("rejects oversized f-string templates before parsing", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("x".repeat(50_001)), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Node format f-string template exceeds 50000 characters.");
  });

  it("rejects oversized f-string format widths before padding", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("{name:10001s}", ["name"], { name: "hello" }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string format width exceeds 10000.");
  });

  it("rejects oversized f-string numeric precision before formatting", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.101f}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string format precision exceeds 100.");
  });

  it("treats zero general f-string precision as one significant digit", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.0g}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["total=4"]));
  });

  it("rejects f-string integer precision instead of ignoring it", async () => {
    const run = await new AutomationExecutor().execute(fStringFormatGroup("total={count:.1d}", ["count"], { count: 3.5 }), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string precision is not supported for d integer formats.");
  });

  it("rejects f-string output that grows beyond the render cap", async () => {
    const inputNames = Array.from({ length: 21 }, (_value, index) => `name${index}`);
    const template = inputNames.map((name) => `{${name}:10000s}`).join("");
    const run = await new AutomationExecutor().execute(fStringFormatGroup(template, inputNames), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("failed");
    expect(run.error).toContain("F-string output exceeds 200000 characters.");
  });

  it("evaluates math operation primitives", async () => {
    const run = await new AutomationExecutor().execute(mathOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["10", "8", "3"]));
  });

  it("evaluates number and string comparison primitives", async () => {
    const run = await new AutomationExecutor().execute(comparisonOperationGroup(), event(), await primitiveCatalog(), new HookRegistry());

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["true", "false", "true"]));
  });

  it("runs sleep primitives with cancellable fake-timer coverage", async () => {
    vi.useFakeTimers();
    let settled = false;
    const runPromise = new AutomationExecutor()
      .execute(sleepGroup(1000), event(), await primitiveCatalog(), new HookRegistry())
      .then((run) => {
        settled = true;
        return run;
      });

    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const run = await runPromise;

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Sleeping for 1000 ms.", "Sleep completed.", "after sleep"]));
  });

  it("cancels sleep primitives without running the next node", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runPromise = new AutomationExecutor().execute(sleepGroup(1000), event(), await primitiveCatalog(), new HookRegistry(), { signal: controller.signal });

    await Promise.resolve();
    controller.abort();
    const run = await runPromise;

    expect(run.status).toBe("cancelled");
    expect(run.trace.map((entry) => entry.message)).not.toContain("after sleep");
  });

  it("runs Python primitives with bounded subprocess output and parsed JSON", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-"));
    const hooks = new HookRegistry();
    let captured: unknown;
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture Python JSON.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(pythonJsonGroup(), event(), pythonCaptureCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("succeeded");
    expect(captured).toEqual({ stdin: "from automation" });
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Starting Python process.", "Python process completed."]));
  });

  it("lets Python primitives call automation-exposed CloudX hooks", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-hooks-"));
    const hooks = new HookRegistry();
    let captured: unknown;
    hooks.register({
      id: "test.upper",
      owner: { kind: "app" },
      title: "Uppercase",
      description: "Uppercase text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          upper: { type: "string" }
        },
        required: ["upper"],
        additionalProperties: false
      },
      execute: (input) => ({ upper: String(input.text).toUpperCase() })
    });
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture hook results.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(pythonHookGroup(), event(), pythonCaptureCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("succeeded");
    expect(captured).toEqual([{ upper: "HELLO" }]);
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Calling CloudX hook test.upper.", "Python process completed."]));
  });

  it("requires external safety for Python primitives at execution time", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-safety-"));
    const run = await new AutomationExecutor().execute(pythonJsonGroup({ allowedSafety: ["read", "write"] }), event(), await primitiveCatalog(), new HookRegistry(), { allowedRoots: [dataDir] });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Run Python requires external automation safety");
  });

  it("applies hook safety policy to Python cloudx.call_hook requests", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-hook-safety-"));
    const hooks = new HookRegistry();
    let called = false;
    hooks.register({
      id: "test.destructive",
      owner: { kind: "app" },
      title: "Destructive",
      description: "Destructive action.",
      exposures: ["automation"],
      automationSafety: "destructive",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        called = true;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(pythonDestructiveHookGroup(), event(), pythonDestructiveHookCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Destructive requires destructive automation safety");
    expect(called).toBe(false);
  });

  it("does not treat user-printed Python stdout as CloudX hook requests", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-hook-spoof-"));
    const hooks = new HookRegistry();
    let upperCalled = false;
    let captured: unknown;
    hooks.register({
      id: "test.upper",
      owner: { kind: "app" },
      title: "Uppercase",
      description: "Uppercase text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: () => {
        upperCalled = true;
        return {};
      }
    });
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture visible stdout.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(pythonSpoofedHookOutputGroup(), event(), pythonCaptureCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("succeeded");
    expect(upperCalled).toBe(false);
    expect(captured).toBe('__CLOUDX_HOOK_CALL__:{"hookId":"test.upper","input":{"text":"spoofed"}}\n');
  });

  it("does not expose the server environment to Python or bash primitives", async () => {
    vi.stubEnv("CLOUDX_AUTOMATION_SECRET_SHOULD_NOT_LEAK", "secret");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-process-env-"));
    const hooks = new HookRegistry();
    const captured: unknown[] = [];
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture process environment checks.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured.push(input.value);
        return {};
      }
    });

    const catalog = pythonCaptureCatalog(await primitiveCatalog());
    const pythonRun = await new AutomationExecutor().execute(pythonSecretEnvGroup(), event(), catalog, hooks, { allowedRoots: [dataDir] });
    const bashRun = await new AutomationExecutor().execute(bashSecretEnvGroup(), event(), catalog, hooks, { allowedRoots: [dataDir] });

    expect(pythonRun.status).toBe("succeeded");
    expect(bashRun.status).toBe("succeeded");
    expect(captured).toEqual([{ leaked: false }, { leaked: false }]);
  });

  it("terminates timed-out Python process groups that ignore SIGTERM", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-timeout-"));
    const startedAt = Date.now();

    const run = await new AutomationExecutor().execute(pythonIgnoresSigtermGroup(), event(), await primitiveCatalog(), new HookRegistry(), { allowedRoots: [dataDir] });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Python process timed out after 20 ms");
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("rejects Python working directories outside allowed roots", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-python-outside-"));
    const run = await new AutomationExecutor().execute(pythonJsonGroup({ cwd: outside }), event(), await primitiveCatalog(), new HookRegistry(), { allowedRoots: [dataDir] });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("outside configured Cloudx roots");
  });

  it("runs bash primitives with bounded subprocess output and parsed JSON", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-bash-"));
    const hooks = new HookRegistry();
    let captured: unknown;
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture bash JSON.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(bashJsonGroup(), event(), pythonCaptureCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("succeeded");
    expect(captured).toEqual({ stdin: "from bash" });
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Starting bash process.", "Bash process completed."]));
  });

  it("runs Codex exec primitives with bounded subprocess output and parsed JSONL", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-exec-"));
    const fakeCodex = await fakeCodexExecutable(dataDir, `
const stdin = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => value += chunk);
  process.stdin.on("end", () => resolve(value));
});
console.error("progress: running");
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }) } }));
`);
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", fakeCodex);
    const hooks = new HookRegistry();
    let captured: unknown;
    hooks.register({
      id: "test.capture",
      owner: { kind: "app" },
      title: "Capture",
      description: "Capture Codex response.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          value: {}
        },
        required: ["value"],
        additionalProperties: false
      },
      execute: (input) => {
        captured = input.value;
        return {};
      }
    });

    const run = await new AutomationExecutor().execute(codexExecGroup(), event(), codexCaptureCatalog(await primitiveCatalog()), hooks, { allowedRoots: [dataDir] });

    expect(run.status).toBe("succeeded");
    expect(run.trace.map((entry) => entry.message)).toEqual(expect.arrayContaining(["Starting Codex exec process.", "Codex exec process completed."]));
    const parsed = JSON.parse(String(captured)) as { args: string[]; cwd: string; stdin: string };
    expect(parsed.cwd).toBe(dataDir);
    expect(parsed.stdin).toBe("context from automation");
    expect(parsed.args).toEqual([
      "exec",
      "--cd",
      dataDir,
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--ephemeral",
      "--profile",
      "ci",
      "--model",
      "gpt-5.5",
      "--json",
      "--skip-git-repo-check",
      "summarize the repo"
    ]);
  });

  it("cancels Codex exec primitives without running the next node", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-cancel-"));
    const fakeCodex = await fakeCodexExecutable(dataDir, "setInterval(() => undefined, 1000);");
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", fakeCodex);
    const controller = new AbortController();
    const runPromise = new AutomationExecutor().execute(codexExecGroup({ json: false }), event(), await primitiveCatalog(), new HookRegistry(), { allowedRoots: [dataDir], signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const run = await runPromise;

    expect(run.status).toBe("cancelled");
    expect(run.trace.map((entry) => entry.message)).not.toContain("after codex");
  });

  it("rejects Codex exec working directories outside allowed roots", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-codex-outside-"));
    const run = await new AutomationExecutor().execute(codexExecGroup({ cwd: outside }), event(), await primitiveCatalog(), new HookRegistry(), { allowedRoots: [dataDir] });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Codex working directory is outside configured Cloudx roots");
  });

  it("rejects non-object JSON values from the string-to-object converter", async () => {
    for (const value of ["42", "[1]"]) {
      const run = await new AutomationExecutor().execute(nonObjectJsonConverterGroup(value), event(), await primitiveCatalog(), new HookRegistry());

      expect(run.status).toBe("failed");
      expect(run.error).toContain("requires a JSON object");
    }
  });
});

function catalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts the graph.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      },
      {
        typeId: "hook:test.echo",
        kind: "function",
        title: "Echo",
        description: "Echo text.",
        hookId: "test.echo",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      },
      {
        typeId: "primitive:log",
        kind: "primitive",
        title: "Log",
        description: "Log a message.",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "message", label: "Message", kind: "data", direction: "input", type: { kind: "unknown" } }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function payloadCollisionCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts the graph.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] } }
        ]
      },
      {
        typeId: "hook:test.capturePayload",
        kind: "function",
        title: "Capture Payload",
        description: "Captures the full trigger payload.",
        hookId: "test.capturePayload",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "object", properties: {}, required: [] }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function execPayloadFieldCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      {
        typeId: "trigger:test.started",
        kind: "trigger",
        title: "Test Trigger",
        description: "Starts tests.",
        triggerId: "test.started",
        inputs: [],
        outputs: [
          { id: "exec", label: "Start", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "payload", label: "Payload", kind: "data", direction: "output", type: { kind: "object", properties: {}, required: [] } },
          { id: "exec", label: "Exec Field", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      },
      {
        typeId: "hook:test.captureExecField",
        kind: "function",
        title: "Capture Exec Field",
        description: "Captures a payload field named exec.",
        hookId: "test.captureExecField",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function payloadCollisionGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-payload-collision",
    name: "Payload Collision",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "capture", typeId: "hook:test.capturePayload", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "payload-capture", kind: "data", sourceNodeId: "trigger", sourcePortId: "payload", targetNodeId: "capture", targetPortId: "value" }
      ]
    }
  };
}

function execPayloadFieldGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-exec-payload-field",
    name: "Exec Payload Field",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "capture", typeId: "hook:test.captureExecField", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "exec-field-capture", kind: "data", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "value" }
      ]
    }
  };
}

function targetTabCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.pluginAction",
        kind: "function",
        title: "Plugin Action",
        description: "Captures context.",
        pluginId: "fake-plugin",
        hookId: "test.pluginAction",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "targetTabId", label: "Target Tab", kind: "data", direction: "input", type: { kind: "string" }, automationRole: "pluginTargetTab", required: true },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function schemaOwnedTargetTabCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.schemaTargetTab",
        kind: "function",
        title: "Schema Target Tab",
        description: "Captures a schema-owned targetTabId.",
        pluginId: "fake-plugin",
        hookId: "test.schemaTargetTab",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "targetTabId", label: "Target Tab", kind: "data", direction: "input", type: { kind: "string" }, required: true },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function schemaOwnedTargetTabGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-schema-target-tab",
    name: "Schema Target Tab",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "plugin", typeId: "hook:test.schemaTargetTab", position: { x: 200, y: 0 }, config: { targetTabId: "payload-tab" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "plugin", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "plugin", targetPortId: "text" }
      ]
    }
  };
}

function externalHookCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.external",
        kind: "function",
        title: "External",
        description: "External action.",
        hookId: "test.external",
        safety: "external",
        inputs: [{ id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } }],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

async function primitiveCatalog(): Promise<AutomationCatalogResponse> {
  return {
    nodes: [
      catalog().nodes[0]!,
      ...(await new AutomationCatalogService(new AutomationTypeService(), () => [], () => []).catalog()).nodes
    ]
  };
}

async function nestedCatalog(): Promise<AutomationCatalogResponse> {
  return await new AutomationCatalogService(
    new AutomationTypeService(),
    () => [
      {
        id: "test.started",
        owner: { kind: "plugin", pluginId: "test" },
        title: "Test Trigger",
        description: "Starts the graph.",
        exposures: ["automation"],
        payloadSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            folderName: { type: "string" }
          },
          required: ["text", "folderName"],
          additionalProperties: false
        }
      }
    ],
    () => [
      {
        id: "test.createWindow",
        owner: { kind: "app" },
        title: "Create Window",
        description: "Creates a window.",
        exposures: ["automation"],
        inputSchema: nestedCreateInputSchema(),
        outputSchema: nestedCreateOutputSchema()
      },
      {
        id: "test.notify",
        owner: { kind: "app" },
        title: "Notify",
        description: "Sends a notification.",
        exposures: ["automation"],
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" }
          },
          required: ["title"],
          additionalProperties: false
        }
      }
    ]
  ).catalog();
}

function nestedCreateInputSchema(): JsonSchemaLike {
  return {
    type: "object",
    properties: {
      indicator: {
        type: "object",
        properties: {
          color: { type: "string" },
          label: { type: "string" }
        },
        required: ["color", "label"],
        additionalProperties: false
      }
    },
    required: ["indicator"],
    additionalProperties: false
  };
}

function nestedCreateOutputSchema(): JsonSchemaLike {
  return {
    type: "object",
    properties: {
      window: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          defaultCwd: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  };
}

function group(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-1",
    name: "Group",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "echo", typeId: "hook:test.echo", position: { x: 200, y: 0 } },
        { id: "log", typeId: "primitive:log", position: { x: 400, y: 0 }, config: { message: "finished" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "echo", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "echo", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "echo", targetPortId: "text" }
      ]
    }
  };
}

function nestedHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-nested",
    name: "Nested Hook Ports",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "create", typeId: "hook:test.createWindow", position: { x: 200, y: 0 }, config: { "indicator.color": "green" } },
        { id: "notify", typeId: "hook:test.notify", position: { x: 400, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "create", sourcePortId: "exec", targetNodeId: "notify", targetPortId: "exec" },
        { id: "folder-label", kind: "data", sourceNodeId: "trigger", sourcePortId: "folderName", targetNodeId: "create", targetPortId: "indicator.label" },
        { id: "window-notify", kind: "data", sourceNodeId: "create", sourcePortId: "window.name", targetNodeId: "notify", targetPortId: "title" }
      ]
    }
  };
}

function unsafePathCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.unsafe",
        kind: "function",
        title: "Unsafe",
        description: "Uses an unsafe dotted input path.",
        hookId: "test.unsafe",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "__proto__.polluted", label: "Unsafe", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function unsafePathGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-unsafe-path",
    name: "Unsafe Path",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "unsafe", typeId: "hook:test.unsafe", position: { x: 200, y: 0 }, config: { "__proto__.polluted": "yes" } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "unsafe", targetPortId: "exec" }]
    }
  };
}

function variableArrayGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-array",
    name: "Array Variables",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "array", typeId: "primitive:array.literal", position: { x: 120, y: 140 }, config: { items: "[\"a\"]" } },
        { id: "append", typeId: "primitive:array.append", position: { x: 320, y: 140 }, config: { item: "b" } },
        { id: "create", typeId: "primitive:variables.create", position: { x: 240, y: 0 }, config: { name: "items" } },
        { id: "get", typeId: "primitive:variables.get", position: { x: 470, y: 140 }, config: { name: "items" } },
        { id: "length", typeId: "primitive:array.length", position: { x: 650, y: 140 } },
        { id: "log", typeId: "primitive:log", position: { x: 500, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "create", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "array-append", kind: "data", sourceNodeId: "array", sourcePortId: "value", targetNodeId: "append", targetPortId: "array" },
        { id: "append-create", kind: "data", sourceNodeId: "append", sourcePortId: "value", targetNodeId: "create", targetPortId: "initial" },
        { id: "get-length", kind: "data", sourceNodeId: "get", sourcePortId: "value", targetNodeId: "length", targetPortId: "array" },
        { id: "length-log", kind: "data", sourceNodeId: "length", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function whileVariableMutationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-while-variable",
    name: "While Variable Mutation",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "create-flag", typeId: "primitive:variables.create", position: { x: 180, y: 0 }, config: { name: "continue", initial: true } },
        { id: "get-flag", typeId: "primitive:variables.get", position: { x: 360, y: 160 }, config: { name: "continue" } },
        { id: "while", typeId: "primitive:while", position: { x: 360, y: 0 } },
        { id: "stop", typeId: "primitive:variables.set", position: { x: 560, y: 120 }, config: { name: "continue", value: false } },
        { id: "log", typeId: "primitive:log", position: { x: 560, y: 0 }, config: { message: "done" } }
      ],
      edges: [
        { id: "exec-create", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "create-flag", targetPortId: "exec" },
        { id: "exec-while", kind: "exec", sourceNodeId: "create-flag", sourcePortId: "exec", targetNodeId: "while", targetPortId: "exec" },
        { id: "condition", kind: "data", sourceNodeId: "get-flag", sourcePortId: "value", targetNodeId: "while", targetPortId: "condition" },
        { id: "body-stop", kind: "exec", sourceNodeId: "while", sourcePortId: "body", targetNodeId: "stop", targetPortId: "exec" },
        { id: "done-log", kind: "exec", sourceNodeId: "while", sourcePortId: "done", targetNodeId: "log", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function stringOperationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string",
    name: "String Operations",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "append", typeId: "primitive:string.append", position: { x: 120, y: 120 }, config: { text: "Hello", suffix: " world" } },
        { id: "insert", typeId: "primitive:string.insert", position: { x: 300, y: 120 }, config: { insert: " brave", index: 5 } },
        { id: "extract", typeId: "primitive:string.regex.extract", position: { x: 500, y: 120 }, config: { pattern: "brave\\s+(\\w+)", group: 1 } },
        { id: "split", typeId: "primitive:string.split", position: { x: 500, y: 230 }, config: { separator: " " } },
        { id: "get", typeId: "primitive:array.get", position: { x: 680, y: 230 }, config: { index: 1 } },
        { id: "test", typeId: "primitive:string.regex.test", position: { x: 680, y: 340 }, config: { pattern: "HELLO", flags: "i" } },
        { id: "log-world", typeId: "primitive:log", position: { x: 720, y: 0 } },
        { id: "log-brave", typeId: "primitive:log", position: { x: 920, y: 0 } },
        { id: "log-test", typeId: "primitive:log", position: { x: 1120, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log-world", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "log-world", sourcePortId: "exec", targetNodeId: "log-brave", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "log-brave", sourcePortId: "exec", targetNodeId: "log-test", targetPortId: "exec" },
        { id: "append-insert", kind: "data", sourceNodeId: "append", sourcePortId: "value", targetNodeId: "insert", targetPortId: "text" },
        { id: "insert-extract", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "extract", targetPortId: "text" },
        { id: "extract-log", kind: "data", sourceNodeId: "extract", sourcePortId: "value", targetNodeId: "log-world", targetPortId: "message" },
        { id: "insert-split", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "split", targetPortId: "text" },
        { id: "split-get", kind: "data", sourceNodeId: "split", sourcePortId: "value", targetNodeId: "get", targetPortId: "array" },
        { id: "get-log", kind: "data", sourceNodeId: "get", sourcePortId: "value", targetNodeId: "log-brave", targetPortId: "message" },
        { id: "insert-test", kind: "data", sourceNodeId: "insert", sourcePortId: "value", targetNodeId: "test", targetPortId: "text" },
        { id: "test-log", kind: "data", sourceNodeId: "test", sourcePortId: "value", targetNodeId: "log-test", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function regexPrimitiveGroup(typeId: "primitive:string.regex.test" | "primitive:string.regex.extract", config: Record<string, unknown>): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: `group-${typeId}`,
    name: "Regex Primitive",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "regex", typeId, position: { x: 200, y: 120 }, config },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "regex-log", kind: "data", sourceNodeId: "regex", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function nonBooleanConditionGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-non-boolean-condition",
    name: "Non Boolean Condition",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "if", typeId: "primitive:if", position: { x: 200, y: 0 }, config: { condition: "false" } },
        { id: "log-true", typeId: "primitive:log", position: { x: 420, y: 0 }, config: { message: "true branch" } },
        { id: "log-false", typeId: "primitive:log", position: { x: 420, y: 160 }, config: { message: "false branch" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "if", targetPortId: "exec" },
        { id: "if-true", kind: "exec", sourceNodeId: "if", sourcePortId: "true", targetNodeId: "log-true", targetPortId: "exec" },
        { id: "if-false", kind: "exec", sourceNodeId: "if", sourcePortId: "false", targetNodeId: "log-false", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function nullTemplateOverrideGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-null-template",
    name: "Null Template Override",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:stringTemplate", position: { x: 160, y: 120 }, config: { template: "Hello ${name}", name: null } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: [{ name: "name", type: { kind: "string" }, defaultValue: "fallback" }]
    }
  };
}

function stringTemplatePayloadPathGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string-template-payload-path",
    name: "String Template Payload Path",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:stringTemplate", position: { x: 160, y: 120 }, config: { template: "User ${payload.user.profile.name} / inherited=${payload.user.constructor.name}" } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring",
    name: "F-String",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template: "Hi {name!r}, total={count:.2f}, literal {{ok}}", inputNames: ["name", "count"], count: 3.5 } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "name-format", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "format", targetPortId: "name" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringInheritedPayloadGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring-inherited-payload",
    name: "F-String Inherited Payload",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template: "payload={payload.constructor.name}", inputNames: [] } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function fStringFormatGroup(template: string, inputNames: string[] = [], extraConfig: Record<string, unknown> = {}): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-fstring-format",
    name: "F-String Format",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "format", typeId: "primitive:string.fstring", position: { x: 160, y: 120 }, config: { template, inputNames, ...extraConfig } },
        { id: "log", typeId: "primitive:log", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "format-log", kind: "data", sourceNodeId: "format", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function mathOperationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-math",
    name: "Math Operations",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "add", typeId: "primitive:math.add", position: { x: 120, y: 120 }, config: { left: 2, right: 3 } },
        { id: "multiply", typeId: "primitive:math.multiply", position: { x: 300, y: 120 }, config: { right: 4 } },
        { id: "divide", typeId: "primitive:math.divide", position: { x: 480, y: 120 }, config: { right: 2 } },
        { id: "power", typeId: "primitive:math.power", position: { x: 300, y: 230 }, config: { left: 2, right: 3 } },
        { id: "ceil", typeId: "primitive:math.ceil", position: { x: 480, y: 230 }, config: { value: 2.2 } },
        { id: "log-divide", typeId: "primitive:log", position: { x: 680, y: 0 } },
        { id: "log-power", typeId: "primitive:log", position: { x: 880, y: 0 } },
        { id: "log-ceil", typeId: "primitive:log", position: { x: 1080, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log-divide", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "log-divide", sourcePortId: "exec", targetNodeId: "log-power", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "log-power", sourcePortId: "exec", targetNodeId: "log-ceil", targetPortId: "exec" },
        { id: "add-multiply", kind: "data", sourceNodeId: "add", sourcePortId: "value", targetNodeId: "multiply", targetPortId: "left" },
        { id: "multiply-divide", kind: "data", sourceNodeId: "multiply", sourcePortId: "value", targetNodeId: "divide", targetPortId: "left" },
        { id: "divide-log", kind: "data", sourceNodeId: "divide", sourcePortId: "value", targetNodeId: "log-divide", targetPortId: "message" },
        { id: "power-log", kind: "data", sourceNodeId: "power", sourcePortId: "value", targetNodeId: "log-power", targetPortId: "message" },
        { id: "ceil-log", kind: "data", sourceNodeId: "ceil", sourcePortId: "value", targetNodeId: "log-ceil", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function comparisonOperationGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-comparison",
    name: "Comparison Operations",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "number", typeId: "primitive:number.compare", position: { x: 120, y: 120 }, config: { left: 7, right: 3, operator: "greaterThan" } },
        { id: "string", typeId: "primitive:string.compare", position: { x: 120, y: 240 }, config: { left: "CloudX", right: "cloud", operator: "startsWith", caseSensitive: true } },
        { id: "range", typeId: "primitive:number.range", position: { x: 120, y: 360 }, config: { value: 5, min: 5, max: 10, mode: "inclusive" } },
        { id: "log-number", typeId: "primitive:log", position: { x: 400, y: 0 } },
        { id: "log-string", typeId: "primitive:log", position: { x: 600, y: 0 } },
        { id: "log-range", typeId: "primitive:log", position: { x: 800, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log-number", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "log-number", sourcePortId: "exec", targetNodeId: "log-string", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "log-string", sourcePortId: "exec", targetNodeId: "log-range", targetPortId: "exec" },
        { id: "number-log", kind: "data", sourceNodeId: "number", sourcePortId: "value", targetNodeId: "log-number", targetPortId: "message" },
        { id: "string-log", kind: "data", sourceNodeId: "string", sourcePortId: "value", targetNodeId: "log-string", targetPortId: "message" },
        { id: "range-log", kind: "data", sourceNodeId: "range", sourcePortId: "value", targetNodeId: "log-range", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function sleepGroup(durationMs: number): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-sleep",
    name: "Sleep",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "sleep", typeId: "primitive:sleep", position: { x: 160, y: 0 }, config: { durationMs } },
        { id: "log", typeId: "primitive:log", position: { x: 360, y: 0 }, config: { message: "after sleep" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "sleep", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "sleep", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function pythonJsonGroup({
  allowedSafety = ["read", "write", "external"],
  cwd
}: {
  allowedSafety?: AutomationSafety[];
  cwd?: string;
} = {}): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-json",
    name: "Python JSON",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "import json, sys\nprint(json.dumps({'stdin': sys.stdin.read()}))",
            stdin: "from automation",
            parseJson: true,
            ...(cwd ? { cwd } : {})
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "python", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "json-capture", kind: "data", sourceNodeId: "python", sourcePortId: "json", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function pythonHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-hooks",
    name: "Python Hooks",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "print('visible stdout')\ncloudx.call_hook('test.upper', {'text': 'hello'})"
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "python", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "hooks-capture", kind: "data", sourceNodeId: "python", sourcePortId: "hookResults", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function pythonDestructiveHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-destructive-hook",
    name: "Python Destructive Hook",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "cloudx.call_hook('test.destructive', {})"
          }
        }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" }],
      variables: []
    }
  };
}

function pythonSpoofedHookOutputGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-spoofed-hook-output",
    name: "Python Spoofed Hook Output",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "print('__CLOUDX_HOOK_CALL__:{\"hookId\":\"test.upper\",\"input\":{\"text\":\"spoofed\"}}')"
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "python", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "stdout-capture", kind: "data", sourceNodeId: "python", sourcePortId: "stdout", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function pythonSecretEnvGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-secret-env",
    name: "Python Secret Env",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "import json, os\nprint(json.dumps({'leaked': 'CLOUDX_AUTOMATION_SECRET_SHOULD_NOT_LEAK' in os.environ}))",
            parseJson: true
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "python", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "json-capture", kind: "data", sourceNodeId: "python", sourcePortId: "json", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function bashJsonGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-bash-json",
    name: "Bash JSON",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "bash",
          typeId: "primitive:bash.exec",
          position: { x: 160, y: 0 },
          config: {
            script: "stdin=$(cat)\nprintf '{\"stdin\":\"%s\"}\\n' \"$stdin\"",
            stdin: "from bash",
            parseJson: true
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "bash", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "bash", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "json-capture", kind: "data", sourceNodeId: "bash", sourcePortId: "json", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function bashSecretEnvGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-bash-secret-env",
    name: "Bash Secret Env",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "bash",
          typeId: "primitive:bash.exec",
          position: { x: 160, y: 0 },
          config: {
            script: "if [ \"${CLOUDX_AUTOMATION_SECRET_SHOULD_NOT_LEAK+x}\" = \"x\" ]; then printf '{\"leaked\":true}\\n'; else printf '{\"leaked\":false}\\n'; fi",
            parseJson: true
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "bash", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "bash", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "json-capture", kind: "data", sourceNodeId: "bash", sourcePortId: "json", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function pythonIgnoresSigtermGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-python-ignore-sigterm",
    name: "Python Ignore Sigterm",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "python",
          typeId: "primitive:python.exec",
          position: { x: 160, y: 0 },
          config: {
            code: "import signal, time\nsignal.signal(signal.SIGTERM, lambda *_: None)\nwhile True:\n    time.sleep(0.1)",
            timeoutMs: 20
          }
        }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "python", targetPortId: "exec" }],
      variables: []
    }
  };
}

function pythonCaptureCatalog(catalog: AutomationCatalogResponse): AutomationCatalogResponse {
  return {
    nodes: [
      ...catalog.nodes,
      {
        typeId: "hook:test.capture",
        kind: "function",
        title: "Capture",
        description: "Capture Python JSON.",
        hookId: "test.capture",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "unknown" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      },
      {
        typeId: "hook:test.upper",
        kind: "function",
        title: "Upper",
        description: "Uppercase text.",
        hookId: "test.upper",
        safety: "write",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true }
        ],
        outputs: [
          { id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } },
          { id: "upper", label: "Upper", kind: "data", direction: "output", type: { kind: "string" } }
        ]
      }
    ]
  };
}

function pythonDestructiveHookCatalog(catalog: AutomationCatalogResponse): AutomationCatalogResponse {
  return {
    nodes: [
      ...catalog.nodes,
      {
        typeId: "hook:test.destructive",
        kind: "function",
        title: "Destructive",
        description: "Destructive action.",
        hookId: "test.destructive",
        safety: "destructive",
        inputs: [{ id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } }],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function codexExecGroup({
  cwd,
  json = true
}: {
  cwd?: string;
  json?: boolean;
} = {}): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-codex-exec",
    name: "Codex Exec",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        {
          id: "codex",
          typeId: "primitive:codex.exec",
          position: { x: 160, y: 0 },
          config: {
            prompt: "summarize the repo",
            stdin: "context from automation",
            timeoutMs: 10_000,
            profile: "ci",
            model: "gpt-5.5",
            sandbox: "read-only",
            approvalPolicy: "never",
            ephemeral: true,
            json,
            skipGitRepoCheck: true,
            ...(cwd ? { cwd } : {})
          }
        },
        { id: "capture", typeId: "hook:test.capture", position: { x: 420, y: 0 } },
        { id: "log", typeId: "primitive:log", position: { x: 640, y: 0 }, config: { message: "after codex" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "codex", targetPortId: "exec" },
        { id: "exec-2", kind: "exec", sourceNodeId: "codex", sourcePortId: "exec", targetNodeId: "capture", targetPortId: "exec" },
        { id: "exec-3", kind: "exec", sourceNodeId: "capture", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "message-capture", kind: "data", sourceNodeId: "codex", sourcePortId: "finalMessage", targetNodeId: "capture", targetPortId: "value" }
      ],
      variables: []
    }
  };
}

function codexCaptureCatalog(catalog: AutomationCatalogResponse): AutomationCatalogResponse {
  return {
    nodes: [
      ...catalog.nodes,
      {
        typeId: "hook:test.capture",
        kind: "function",
        title: "Capture",
        description: "Capture Codex output.",
        hookId: "test.capture",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "value", label: "Value", kind: "data", direction: "input", type: { kind: "unknown" }, required: true }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

async function fakeCodexExecutable(directory: string, body: string): Promise<string> {
  const file = path.join(directory, `fake-codex-${Math.random().toString(16).slice(2)}.mjs`);
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

function nonObjectJsonConverterGroup(value: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-string-to-object",
    name: "String To Object",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "convert", typeId: "converter:string.toObject", position: { x: 120, y: 120 }, config: { value } },
        { id: "log", typeId: "primitive:log", position: { x: 360, y: 0 } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" },
        { id: "convert-log", kind: "data", sourceNodeId: "convert", sourcePortId: "value", targetNodeId: "log", targetPortId: "message" }
      ],
      variables: []
    }
  };
}

function defaultValueCatalog(): AutomationCatalogResponse {
  return {
    nodes: [
      catalog().nodes[0]!,
      {
        typeId: "hook:test.defaulted",
        kind: "function",
        title: "Defaulted",
        description: "Reads a default.",
        hookId: "test.defaulted",
        inputs: [
          { id: "exec", label: "Run", kind: "exec", direction: "input", type: { kind: "exec" } },
          { id: "text", label: "Text", kind: "data", direction: "input", type: { kind: "string" }, required: true, defaultValue: "from-catalog" }
        ],
        outputs: [{ id: "exec", label: "Done", kind: "exec", direction: "output", type: { kind: "exec" } }]
      }
    ]
  };
}

function defaultValueGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-default",
    name: "Default Values",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "defaulted", typeId: "hook:test.defaulted", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "defaulted", targetPortId: "exec" }]
    }
  };
}

function targetTabGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-target-tab",
    name: "Target Tab",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "plugin", typeId: "hook:test.pluginAction", position: { x: 200, y: 0 }, config: { targetTabId: "tab-2" } }
      ],
      edges: [
        { id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "plugin", targetPortId: "exec" },
        { id: "data-1", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "plugin", targetPortId: "text" }
      ]
    }
  };
}

function externalHookGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "group-external",
    name: "External",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: "trigger", typeId: "trigger:test.started", position: { x: 0, y: 0 } },
        { id: "external", typeId: "hook:test.external", position: { x: 200, y: 0 } }
      ],
      edges: [{ id: "exec-1", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "external", targetPortId: "exec" }]
    }
  };
}

function event(): TriggerEvent {
  return {
    id: "event-1",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { text: "hello", folderName: "feature-folder" },
    emittedAt: new Date(0).toISOString()
  };
}

function nestedPayloadEvent(): TriggerEvent {
  return {
    ...event(),
    id: "event-nested-payload",
    payload: {
      text: "hello",
      folderName: "feature-folder",
      user: {
        profile: {
          name: "Ada"
        }
      }
    }
  };
}

function payloadCollisionEvent(): TriggerEvent {
  return {
    id: "event-payload-collision",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { payload: "shadow", text: "hello" },
    emittedAt: new Date(0).toISOString()
  };
}

function execPayloadFieldEvent(): TriggerEvent {
  return {
    id: "event-exec-payload-field",
    triggerId: "test.started",
    source: { kind: "test" },
    payload: { exec: "payload-exec", payload: "shadow", text: "hello" },
    emittedAt: new Date(0).toISOString()
  };
}
