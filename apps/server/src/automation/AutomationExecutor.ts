import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import safeRegex from "safe-regex2";

import type { HookRegistry } from "../hooks/HookRegistry.js";
import { isSameOrChildPath } from "../pathBoundary.js";
import type { AutomationCatalogResponse, AutomationEdge, AutomationGroup, AutomationNode, AutomationNodeCatalogEntry, AutomationRunSummary, AutomationRunTraceEntry, TriggerEvent } from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID, automationEntryWithDynamicPorts, automationFStringInputNames, automationSafetyAllowed } from "@cloudx/shared";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";

export interface AutomationExecutorOptions {
  activeTabId?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  maxTraceEntries?: number;
  allowedRoots?: string[];
  signal?: AbortSignal;
  effectSink?: AutomationEffectSink;
  onRunStarted?: (run: AutomationRunSummary) => Promise<void> | void;
}

export interface AutomationEffectSink {
  applyHookResult(result: Record<string, unknown>): Promise<void> | void;
}

type OutputMap = Map<string, Record<string, unknown>>;

const AUTOMATION_REGEX_PATTERN_MAX_CHARS = 512;
const AUTOMATION_REGEX_TEXT_MAX_CHARS = 200_000;
const AUTOMATION_REGEX_REPEAT_LIMIT = 25;
const AUTOMATION_FSTRING_TEMPLATE_MAX_CHARS = 50_000;
const AUTOMATION_FSTRING_OUTPUT_MAX_CHARS = 200_000;
const AUTOMATION_FSTRING_FORMAT_WIDTH_MAX = 10_000;
const AUTOMATION_FSTRING_FORMAT_PRECISION_MAX = 100;
const AUTOMATION_SLEEP_MAX_MS = 60 * 60 * 1000;
const AUTOMATION_PYTHON_CODE_MAX_CHARS = 100_000;
const AUTOMATION_PYTHON_STDIN_MAX_BYTES = 1024 * 1024;
const AUTOMATION_PYTHON_OUTPUT_MAX_BYTES = 1024 * 1024;
const AUTOMATION_PYTHON_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const AUTOMATION_PYTHON_DEFAULT_TIMEOUT_MS = 30_000;
const AUTOMATION_BASH_SCRIPT_MAX_CHARS = 100_000;
const AUTOMATION_BASH_STDIN_MAX_BYTES = 1024 * 1024;
const AUTOMATION_BASH_OUTPUT_MAX_BYTES = 1024 * 1024;
const AUTOMATION_BASH_TIMEOUT_MAX_MS = 5 * 60 * 1000;
const AUTOMATION_BASH_DEFAULT_TIMEOUT_MS = 30_000;
const AUTOMATION_CODEX_PROMPT_MAX_CHARS = 100_000;
const AUTOMATION_CODEX_STDIN_MAX_BYTES = 1024 * 1024;
const AUTOMATION_CODEX_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const AUTOMATION_CODEX_TIMEOUT_MAX_MS = 60 * 60 * 1000;
const AUTOMATION_CODEX_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const AUTOMATION_PROCESS_TERMINATION_GRACE_MS = 250;
const AUTOMATION_PROCESS_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const;
const CLOUDX_HOOK_STDOUT_PREFIX = "__CLOUDX_HOOK_CALL__:";
function cloudxPythonHookPrelude(hookToken: string): string {
  const prefix = `${CLOUDX_HOOK_STDOUT_PREFIX}${hookToken}:`;
  return `
import json as _cloudx_json

class __CloudxAutomation:
    def call_hook(self, hook_id, input=None, target_tab_id=None):
        payload = {"hookId": hook_id, "input": {} if input is None else input}
        if target_tab_id is not None:
            payload["targetTabId"] = target_tab_id
        print(${JSON.stringify(prefix)} + _cloudx_json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)

cloudx = __CloudxAutomation()

def call_hook(hook_id, input=None, target_tab_id=None):
    return cloudx.call_hook(hook_id, input, target_tab_id)
`;
}

export class AutomationCancelledError extends Error {
  constructor() {
    super("Automation run was cancelled.");
    this.name = "AutomationCancelledError";
  }
}

export class AutomationExecutor {
  async execute(group: AutomationGroup, event: TriggerEvent, catalog: AutomationCatalogResponse, hooks: HookRegistry, options: AutomationExecutorOptions = {}): Promise<AutomationRunSummary> {
    const run: AutomationRunSummary = {
      id: randomUUID(),
      groupId: group.id,
      triggerEventId: event.id,
      status: "running",
      startedAt: new Date().toISOString(),
      trace: []
    };
    const runtime = new AutomationRuntime(group, event, catalog, hooks, run, options);
    try {
      await options.onRunStarted?.(run);
      await runtime.execute();
      if (options.signal?.aborted) {
        throw new AutomationCancelledError();
      }
      run.status = "succeeded";
    } catch (error) {
      const cancelled = error instanceof AutomationCancelledError || options.signal?.aborted;
      run.status = cancelled ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      runtime.trace(run.status === "cancelled" ? "warn" : "error", run.error);
    } finally {
      run.finishedAt = new Date().toISOString();
    }
    return run;
  }
}

class AutomationRuntime {
  private readonly nodesById: Map<string, AutomationNode>;
  private readonly catalogByType: Map<string, AutomationNodeCatalogEntry>;
  private readonly outgoingExec = new Map<string, AutomationEdge[]>();
  private readonly incomingData = new Map<string, AutomationEdge[]>();
  private readonly outputs: OutputMap = new Map();
  private readonly variables = new Map<string, unknown>();
  private readonly startedAt = Date.now();
  private steps = 0;

  constructor(
    private readonly group: AutomationGroup,
    private readonly event: TriggerEvent,
    catalog: AutomationCatalogResponse,
    private readonly hooks: HookRegistry,
    private readonly run: AutomationRunSummary,
    private readonly options: AutomationExecutorOptions
  ) {
    this.nodesById = new Map(group.graph.nodes.map((node) => [node.id, node]));
    this.catalogByType = new Map(catalog.nodes.map((entry) => [entry.typeId, entry]));
    for (const edge of group.graph.edges) {
      if (edge.kind === "exec") {
        const key = `${edge.sourceNodeId}:${edge.sourcePortId}`;
        this.outgoingExec.set(key, [...(this.outgoingExec.get(key) ?? []), edge]);
      } else {
        const key = `${edge.targetNodeId}:${edge.targetPortId}`;
        this.incomingData.set(key, [...(this.incomingData.get(key) ?? []), edge]);
      }
    }
    for (const variable of group.graph.variables ?? []) {
      if (variable.defaultValue !== undefined) {
        this.variables.set(variable.name, variable.defaultValue);
      }
    }
  }

  async execute(): Promise<void> {
    const starts = this.group.graph.nodes.filter((node) => this.entry(node)?.kind === "trigger" && this.entry(node)?.triggerId === this.event.triggerId);
    if (starts.length === 0) {
      throw new Error(`Automation group ${this.group.id} has no trigger node for ${this.event.triggerId}.`);
    }
    for (const start of starts) {
      await this.executeNode(start);
    }
  }

  trace(level: AutomationRunTraceEntry["level"], message: string, nodeId?: string, data?: Record<string, unknown>): void {
    const maxTraceEntries = this.options.maxTraceEntries ?? 10_000;
    if (this.run.trace.length >= maxTraceEntries) {
      return;
    }
    this.run.trace.push({
      id: randomUUID(),
      nodeId,
      level,
      message,
      at: new Date().toISOString(),
      data: trimData(data)
    });
  }

  private async executeNode(node: AutomationNode): Promise<void> {
    this.guard(node.id);
    const entry = this.requireEntry(node);
    this.assertSafetyAllowed(entry);
    this.trace("info", `Running ${entry.title}.`, node.id);
    if (entry.kind === "trigger") {
      this.outputs.set(node.id, this.triggerOutputs());
      await this.executeNext(node, "exec");
      return;
    }
    if (entry.kind === "function") {
      const targetTabPort = entry.inputs.find((port) => isPluginTargetTabPort(entry, port));
      const targetTabId = targetTabPort ? optionalString(await this.optionalInputValue(node, targetTabPort.id)) : undefined;
      const input = await this.inputObject(node, entry);
      this.assertNotCancelled();
      const result = await this.hooks.call(entry.hookId!, input, {
        caller: { kind: "automation", pluginId: "automation", automationGroupId: this.group.id },
        targetTabId,
        activeTabId: this.options.activeTabId,
        signal: this.options.signal
      });
      this.assertNotCancelled();
      await this.options.effectSink?.applyHookResult(result);
      this.assertNotCancelled();
      this.outputs.set(node.id, { result, ...result, ...flattenObject(result) });
      this.trace("info", `${entry.title} completed.`, node.id);
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:if") {
      const condition = booleanValue(await this.inputValue(node, "condition"), node, "condition");
      this.outputs.set(node.id, { condition });
      await this.executeNext(node, condition ? "true" : "false");
      return;
    }
    if (node.typeId === "primitive:while") {
      let iterations = 0;
      while (booleanValue(await this.inputValue(node, "condition"), node, "condition")) {
        iterations += 1;
        if (iterations > 1000) {
          throw new Error(`Automation loop limit exceeded in node ${node.id}.`);
        }
        await this.executeNext(node, "body");
      }
      await this.executeNext(node, "done");
      return;
    }
    if (node.typeId === "primitive:variables.create") {
      const name = requireConfigString(node, "name");
      if (this.variables.has(name)) {
        throw new Error(`Variable ${name} already exists.`);
      }
      const value = await this.optionalInputValue(node, "initial");
      this.variables.set(name, value);
      this.invalidateCachedDataNodeOutputs();
      this.outputs.set(node.id, { value });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:variables.set") {
      const name = requireConfigString(node, "name");
      const value = await this.inputValue(node, "value");
      this.variables.set(name, value);
      this.invalidateCachedDataNodeOutputs();
      this.outputs.set(node.id, { value });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:log") {
      const message = await this.optionalInputValue(node, "message") ?? node.config?.message ?? "";
      this.trace("info", typeof message === "string" ? message : JSON.stringify(message), node.id);
      this.outputs.set(node.id, {});
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:sequence") {
      this.outputs.set(node.id, {});
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:sleep") {
      const durationMs = durationMsValue(await this.inputValue(node, "durationMs"), node, "durationMs", AUTOMATION_SLEEP_MAX_MS);
      const remainingMs = this.remainingDurationBudgetMs();
      if (durationMs > remainingMs) {
        throw new Error(`Node ${node.id} sleep duration ${durationMs} ms exceeds the remaining automation duration budget of ${remainingMs} ms.`);
      }
      this.trace("info", `Sleeping for ${durationMs} ms.`, node.id, { durationMs });
      await sleepForAutomation(durationMs, this.options.signal);
      this.assertNotCancelled();
      this.outputs.set(node.id, {});
      this.trace("info", "Sleep completed.", node.id, { durationMs });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:python.exec") {
      const code = textValue(await this.inputValue(node, "code"));
      if (code.length > AUTOMATION_PYTHON_CODE_MAX_CHARS) {
        throw new Error(`Node ${node.id} Python code exceeds ${AUTOMATION_PYTHON_CODE_MAX_CHARS} characters.`);
      }
      const stdin = textValue(await this.optionalInputValue(node, "stdin"));
      if (Buffer.byteLength(stdin, "utf8") > AUTOMATION_PYTHON_STDIN_MAX_BYTES) {
        throw new Error(`Node ${node.id} Python stdin exceeds ${AUTOMATION_PYTHON_STDIN_MAX_BYTES} bytes.`);
      }
      const timeoutMs = durationMsValue(await this.optionalInputValue(node, "timeoutMs") ?? AUTOMATION_PYTHON_DEFAULT_TIMEOUT_MS, node, "timeoutMs", AUTOMATION_PYTHON_TIMEOUT_MAX_MS);
      const remainingMs = this.remainingDurationBudgetMs();
      if (timeoutMs > remainingMs) {
        throw new Error(`Node ${node.id} Python timeout ${timeoutMs} ms exceeds the remaining automation duration budget of ${remainingMs} ms.`);
      }
      const cwd = await resolveAutomationProcessCwd(await this.optionalInputValue(node, "cwd"), this.options.allowedRoots, "Python");
      const cloudxHooks = booleanValue(await this.optionalInputValue(node, "cloudxHooks") ?? true, node, "cloudxHooks");
      const parseJson = booleanValue(await this.optionalInputValue(node, "parseJson") ?? false, node, "parseJson");
      const hookToken = cloudxHooks ? randomUUID() : "";
      this.trace("info", "Starting Python process.", node.id, { cwd, timeoutMs, cloudxHooks });
      const result = await runPythonCode({ code: cloudxHooks ? `${cloudxPythonHookPrelude(hookToken)}\n${code}` : code, stdin, cwd, timeoutMs, signal: this.options.signal });
      this.assertNotCancelled();
      const hookExtraction = cloudxHooks ? extractCloudxHookCalls(result.stdout, node, hookToken) : { stdout: result.stdout, calls: [] };
      const outputs: Record<string, unknown> = { stdout: hookExtraction.stdout, stderr: result.stderr, exitCode: result.exitCode, hookResults: [], hookResultCount: 0 };
      if (result.exitCode !== 0) {
        this.outputs.set(node.id, outputs);
        throw new Error(`Node ${node.id} Python process exited with code ${result.exitCode}.${result.stderr ? ` ${result.stderr.trim()}` : ""}`);
      }
      const hookResults = await this.callCloudxHooks(node, hookExtraction.calls);
      outputs.hookResults = hookResults;
      outputs.hookResultCount = hookResults.length;
      if (parseJson) {
        try {
          outputs.json = JSON.parse(hookExtraction.stdout) as unknown;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Node ${node.id} could not parse Python stdout as JSON: ${message}`);
        }
      }
      this.outputs.set(node.id, outputs);
      this.trace("info", "Python process completed.", node.id, {
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(hookExtraction.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
        hookResultCount: hookResults.length
      });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:bash.exec") {
      const script = textValue(await this.inputValue(node, "script"));
      if (script.length > AUTOMATION_BASH_SCRIPT_MAX_CHARS) {
        throw new Error(`Node ${node.id} bash script exceeds ${AUTOMATION_BASH_SCRIPT_MAX_CHARS} characters.`);
      }
      const stdin = textValue(await this.optionalInputValue(node, "stdin"));
      if (Buffer.byteLength(stdin, "utf8") > AUTOMATION_BASH_STDIN_MAX_BYTES) {
        throw new Error(`Node ${node.id} bash stdin exceeds ${AUTOMATION_BASH_STDIN_MAX_BYTES} bytes.`);
      }
      const timeoutMs = durationMsValue(await this.optionalInputValue(node, "timeoutMs") ?? AUTOMATION_BASH_DEFAULT_TIMEOUT_MS, node, "timeoutMs", AUTOMATION_BASH_TIMEOUT_MAX_MS);
      const remainingMs = this.remainingDurationBudgetMs();
      if (timeoutMs > remainingMs) {
        throw new Error(`Node ${node.id} bash timeout ${timeoutMs} ms exceeds the remaining automation duration budget of ${remainingMs} ms.`);
      }
      const cwd = await resolveAutomationProcessCwd(await this.optionalInputValue(node, "cwd"), this.options.allowedRoots, "Bash");
      const parseJson = booleanValue(await this.optionalInputValue(node, "parseJson") ?? false, node, "parseJson");
      this.trace("info", "Starting bash process.", node.id, { cwd, timeoutMs });
      const result = await runBashScript({ script, stdin, cwd, timeoutMs, signal: this.options.signal });
      this.assertNotCancelled();
      const outputs: Record<string, unknown> = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      if (result.exitCode !== 0) {
        this.outputs.set(node.id, outputs);
        throw new Error(`Node ${node.id} bash process exited with code ${result.exitCode}.${result.stderr ? ` ${result.stderr.trim()}` : ""}`);
      }
      if (parseJson) {
        try {
          outputs.json = JSON.parse(result.stdout) as unknown;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Node ${node.id} could not parse bash stdout as JSON: ${message}`);
        }
      }
      this.outputs.set(node.id, outputs);
      this.trace("info", "Bash process completed.", node.id, {
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8")
      });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:codex.exec") {
      const prompt = textValue(await this.inputValue(node, "prompt"));
      if (prompt.length > AUTOMATION_CODEX_PROMPT_MAX_CHARS) {
        throw new Error(`Node ${node.id} Codex prompt exceeds ${AUTOMATION_CODEX_PROMPT_MAX_CHARS} characters.`);
      }
      const stdin = textValue(await this.optionalInputValue(node, "stdin"));
      if (Buffer.byteLength(stdin, "utf8") > AUTOMATION_CODEX_STDIN_MAX_BYTES) {
        throw new Error(`Node ${node.id} Codex stdin exceeds ${AUTOMATION_CODEX_STDIN_MAX_BYTES} bytes.`);
      }
      const timeoutMs = durationMsValue(await this.optionalInputValue(node, "timeoutMs") ?? AUTOMATION_CODEX_DEFAULT_TIMEOUT_MS, node, "timeoutMs", AUTOMATION_CODEX_TIMEOUT_MAX_MS);
      const remainingMs = this.remainingDurationBudgetMs();
      if (timeoutMs > remainingMs) {
        throw new Error(`Node ${node.id} Codex timeout ${timeoutMs} ms exceeds the remaining automation duration budget of ${remainingMs} ms.`);
      }
      const cwd = await resolveAutomationProcessCwd(await this.optionalInputValue(node, "cwd"), this.options.allowedRoots, "Codex");
      const profile = optionalString(await this.optionalInputValue(node, "profile"));
      const model = optionalString(await this.optionalInputValue(node, "model"));
      const sandbox = enumInputValue(await this.optionalInputValue(node, "sandbox") ?? "read-only", ["read-only", "workspace-write", "danger-full-access"], node, "sandbox");
      const approvalPolicy = enumInputValue(await this.optionalInputValue(node, "approvalPolicy") ?? "never", ["untrusted", "on-request", "never"], node, "approvalPolicy");
      const ephemeral = booleanValue(await this.optionalInputValue(node, "ephemeral") ?? true, node, "ephemeral");
      const json = booleanValue(await this.optionalInputValue(node, "json") ?? false, node, "json");
      const skipGitRepoCheck = booleanValue(await this.optionalInputValue(node, "skipGitRepoCheck") ?? false, node, "skipGitRepoCheck");
      this.trace("info", "Starting Codex exec process.", node.id, { cwd, timeoutMs, sandbox, approvalPolicy, json });
      const result = await runCodexExec({ prompt, stdin, cwd, timeoutMs, profile, model, sandbox, approvalPolicy, ephemeral, json, skipGitRepoCheck, signal: this.options.signal });
      this.assertNotCancelled();
      const jsonEvents = json ? parseCodexJsonLines(result.stdout, node) : undefined;
      const finalMessage = jsonEvents ? finalMessageFromCodexEvents(jsonEvents) : result.stdout.trimEnd();
      const outputs: Record<string, unknown> = { finalMessage, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      if (jsonEvents) {
        outputs.jsonEvents = jsonEvents;
      }
      this.outputs.set(node.id, outputs);
      if (result.exitCode !== 0) {
        throw new Error(`Node ${node.id} Codex exec exited with code ${result.exitCode}.${result.stderr ? ` ${result.stderr.trim()}` : ""}`);
      }
      this.trace("info", "Codex exec process completed.", node.id, {
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8")
      });
      await this.executeNext(node, "exec");
      return;
    }
    if (entry.kind === "converter" || entry.kind === "primitive") {
      this.outputs.set(node.id, { value: await this.evaluateDataNode(node) });
      return;
    }
  }

  private async executeNext(node: AutomationNode, portId: string): Promise<void> {
    for (const edge of this.outgoingExec.get(`${node.id}:${portId}`) ?? []) {
      const target = this.nodesById.get(edge.targetNodeId);
      if (!target) {
        throw new Error(`Missing target node ${edge.targetNodeId}.`);
      }
      await this.executeNode(target);
    }
  }

  private async inputObject(node: AutomationNode, entry: AutomationNodeCatalogEntry): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    for (const port of entry.inputs.filter((port) => port.kind === "data")) {
      if (isPluginTargetTabPort(entry, port)) {
        continue;
      }
      const value = await this.optionalInputValue(node, port.id);
      if (value !== undefined) {
        setPathValue(input, port.id, value);
      }
    }
    return input;
  }

  private async inputValue(node: AutomationNode, portId: string): Promise<unknown> {
    const value = await this.optionalInputValue(node, portId);
    if (value === undefined) {
      throw new Error(`Node ${node.id} requires input ${portId}.`);
    }
    return value;
  }

  private async optionalInputValue(node: AutomationNode, portId: string): Promise<unknown> {
    const incoming = this.incomingData.get(`${node.id}:${portId}`)?.[0];
    if (!incoming) {
      if (hasOwn(node.config, portId)) {
        return node.config[portId];
      }
      return this.entry(node)?.inputs.find((port) => port.id === portId)?.defaultValue;
    }
    const source = this.nodesById.get(incoming.sourceNodeId);
    if (!source) {
      throw new Error(`Missing source node ${incoming.sourceNodeId}.`);
    }
    const sourceOutputs = this.outputs.get(source.id) ?? { value: await this.evaluateDataNode(source) };
    return sourceOutputs[incoming.sourcePortId];
  }

  private async evaluateDataNode(node: AutomationNode): Promise<unknown> {
    this.guard(node.id);
    const existing = this.outputs.get(node.id);
    if (existing && "value" in existing) {
      return existing.value;
    }
    if (this.entry(node)?.kind === "trigger") {
      this.outputs.set(node.id, this.triggerOutputs());
      return this.outputs.get(node.id)?.value;
    }
    if (node.typeId === "primitive:variables.get") {
      return this.variables.get(requireConfigString(node, "name"));
    }
    if (node.typeId === "primitive:constant.string") {
      return String(node.config?.value ?? "");
    }
    if (node.typeId === "primitive:constant.number") {
      const value = Number(node.config?.value ?? 0);
      if (!Number.isFinite(value)) {
        throw new Error(`Node ${node.id} has an invalid number constant.`);
      }
      return value;
    }
    if (node.typeId === "primitive:constant.boolean") {
      return booleanValue(node.config?.value ?? false, node, "value");
    }
    if (node.typeId === "primitive:stringTemplate") {
      return this.renderTemplate(node);
    }
    if (node.typeId === AUTOMATION_FSTRING_TYPE_ID) {
      return this.renderFString(node);
    }
    if (node.typeId === "primitive:array.literal") {
      return arrayValue(node.config?.items ?? [], node, "items");
    }
    if (node.typeId === "primitive:array.append") {
      const array = arrayValue(await this.inputValue(node, "array"), node, "array");
      const item = await this.inputValue(node, "item");
      return [...array, item];
    }
    if (node.typeId === "primitive:array.get") {
      const array = arrayValue(await this.inputValue(node, "array"), node, "array");
      const index = integerValue(await this.inputValue(node, "index"), node, "index");
      if (index < 0 || index >= array.length) {
        throw new Error(`Node ${node.id} array index ${index} is out of range.`);
      }
      return array[index];
    }
    if (node.typeId === "primitive:array.length") {
      return arrayValue(await this.inputValue(node, "array"), node, "array").length;
    }
    if (node.typeId === "primitive:string.append") {
      return textValue(await this.inputValue(node, "text")) + textValue(await this.inputValue(node, "suffix"));
    }
    if (node.typeId === "primitive:string.insert") {
      const text = textValue(await this.inputValue(node, "text"));
      const insert = textValue(await this.inputValue(node, "insert"));
      const index = integerValue(await this.inputValue(node, "index"), node, "index");
      if (index < 0 || index > text.length) {
        throw new Error(`Node ${node.id} string insert index ${index} is out of range.`);
      }
      return `${text.slice(0, index)}${insert}${text.slice(index)}`;
    }
    if (node.typeId === "primitive:string.split") {
      return textValue(await this.inputValue(node, "text")).split(textValue(await this.inputValue(node, "separator")));
    }
    if (node.typeId === "primitive:string.replace") {
      const text = textValue(await this.inputValue(node, "text"));
      const search = textValue(await this.inputValue(node, "search"));
      const replacement = textValue(await this.inputValue(node, "replacement"));
      const regex = await this.optionalInputValue(node, "regex");
      if (regex === undefined ? false : booleanValue(regex, node, "regex")) {
        return regexTextValue(text, node, "text").replace(automationRegExp(search, textValue(await this.optionalInputValue(node, "flags")), node), replacement);
      }
      return search ? text.split(search).join(replacement) : text;
    }
    if (node.typeId === "primitive:string.regex.test") {
      return automationRegExp(await this.inputValue(node, "pattern"), await this.optionalInputValue(node, "flags"), node).test(regexTextValue(await this.inputValue(node, "text"), node, "text"));
    }
    if (node.typeId === "primitive:string.regex.extract") {
      const match = automationRegExp(await this.inputValue(node, "pattern"), await this.optionalInputValue(node, "flags"), node).exec(regexTextValue(await this.inputValue(node, "text"), node, "text"));
      return match?.[integerValue(await this.optionalInputValue(node, "group"), node, "group")] ?? "";
    }
    if (node.typeId === "primitive:string.length") {
      return textValue(await this.inputValue(node, "text")).length;
    }
    if (node.typeId === "primitive:string.trim") {
      return textValue(await this.inputValue(node, "text")).trim();
    }
    if (node.typeId === "primitive:string.lowercase") {
      return textValue(await this.inputValue(node, "text")).toLowerCase();
    }
    if (node.typeId === "primitive:string.uppercase") {
      return textValue(await this.inputValue(node, "text")).toUpperCase();
    }
    if (node.typeId === "primitive:string.compare") {
      return compareStrings(
        textValue(await this.inputValue(node, "left")),
        textValue(await this.inputValue(node, "right")),
        textValue(await this.inputValue(node, "operator")),
        booleanValue(await this.optionalInputValue(node, "caseSensitive") ?? true, node, "caseSensitive"),
        node
      );
    }
    if (node.typeId === "primitive:math.add") {
      return numberValue(await this.inputValue(node, "left"), node, "left") + numberValue(await this.inputValue(node, "right"), node, "right");
    }
    if (node.typeId === "primitive:math.subtract") {
      return numberValue(await this.inputValue(node, "left"), node, "left") - numberValue(await this.inputValue(node, "right"), node, "right");
    }
    if (node.typeId === "primitive:math.multiply") {
      return numberValue(await this.inputValue(node, "left"), node, "left") * numberValue(await this.inputValue(node, "right"), node, "right");
    }
    if (node.typeId === "primitive:math.divide") {
      const right = numberValue(await this.inputValue(node, "right"), node, "right");
      if (right === 0) {
        throw new Error(`Node ${node.id} cannot divide by zero.`);
      }
      return numberValue(await this.inputValue(node, "left"), node, "left") / right;
    }
    if (node.typeId === "primitive:math.modulo") {
      const right = numberValue(await this.inputValue(node, "right"), node, "right");
      if (right === 0) {
        throw new Error(`Node ${node.id} cannot modulo by zero.`);
      }
      return numberValue(await this.inputValue(node, "left"), node, "left") % right;
    }
    if (node.typeId === "primitive:math.power") {
      return numberValue(await this.inputValue(node, "left"), node, "left") ** numberValue(await this.inputValue(node, "right"), node, "right");
    }
    if (node.typeId === "primitive:math.min") {
      return Math.min(numberValue(await this.inputValue(node, "left"), node, "left"), numberValue(await this.inputValue(node, "right"), node, "right"));
    }
    if (node.typeId === "primitive:math.max") {
      return Math.max(numberValue(await this.inputValue(node, "left"), node, "left"), numberValue(await this.inputValue(node, "right"), node, "right"));
    }
    if (node.typeId === "primitive:math.abs") {
      return Math.abs(numberValue(await this.inputValue(node, "value"), node, "value"));
    }
    if (node.typeId === "primitive:math.round") {
      return Math.round(numberValue(await this.inputValue(node, "value"), node, "value"));
    }
    if (node.typeId === "primitive:math.floor") {
      return Math.floor(numberValue(await this.inputValue(node, "value"), node, "value"));
    }
    if (node.typeId === "primitive:math.ceil") {
      return Math.ceil(numberValue(await this.inputValue(node, "value"), node, "value"));
    }
    if (node.typeId === "primitive:number.compare") {
      return compareNumbers(numberValue(await this.inputValue(node, "left"), node, "left"), numberValue(await this.inputValue(node, "right"), node, "right"), textValue(await this.inputValue(node, "operator")), node);
    }
    if (node.typeId === "primitive:number.range") {
      return numberInRange(
        numberValue(await this.inputValue(node, "value"), node, "value"),
        numberValue(await this.inputValue(node, "min"), node, "min"),
        numberValue(await this.inputValue(node, "max"), node, "max"),
        textValue(await this.inputValue(node, "mode")),
        node
      );
    }
    if (node.typeId === "converter:string.toNumber") {
      const value = Number(await this.inputValue(node, "value"));
      if (!Number.isFinite(value)) {
        throw new Error(`Node ${node.id} could not convert value to number.`);
      }
      return value;
    }
    if (node.typeId === "converter:number.toString" || node.typeId === "converter:boolean.toString") {
      return String(await this.inputValue(node, "value"));
    }
    if (node.typeId === "converter:object.toString") {
      return JSON.stringify(await this.inputValue(node, "value"));
    }
    if (node.typeId === "converter:string.toObject") {
      const value = await this.inputValue(node, "value");
      if (typeof value !== "string") {
        throw new Error(`Node ${node.id} requires a string value.`);
      }
      const parsed = JSON.parse(value) as unknown;
      if (isPlainObject(parsed)) {
        return parsed;
      }
      throw new Error(`Node ${node.id} requires a JSON object.`);
    }
    throw new Error(`Node ${node.id} does not produce data until it is executed.`);
  }

  private async renderTemplate(node: AutomationNode): Promise<string> {
    const template = typeof node.config?.template === "string" ? node.config.template : "${value}";
    const value = await this.optionalInputValue(node, "value");
    return template.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const trimmed = key.trim();
      if (trimmed === "value") {
        return stringify(value);
      }
      if (trimmed.startsWith("payload.")) {
        return stringify(pathValue(this.event.payload, trimmed.slice("payload.".length)));
      }
      if (hasOwn(node.config, trimmed)) {
        return stringify(node.config?.[trimmed]);
      }
      return stringify(this.variables.get(trimmed));
    });
  }

  private async renderFString(node: AutomationNode): Promise<string> {
    const template = typeof node.config?.template === "string" ? node.config.template : "Hello {value}";
    if (template.length > AUTOMATION_FSTRING_TEMPLATE_MAX_CHARS) {
      throw new Error(`Node ${node.id} f-string template exceeds ${AUTOMATION_FSTRING_TEMPLATE_MAX_CHARS} characters.`);
    }
    const values = new Map<string, unknown>();
    for (const name of automationFStringInputNames(node.config)) {
      values.set(name, await this.optionalInputValue(node, name));
    }
    return renderFStringTemplate(template, (expression) => this.resolveFStringExpression(expression, values));
  }

  private resolveFStringExpression(expression: string, values: Map<string, unknown>): unknown {
    if (expression.startsWith("payload.")) {
      return pathValue(this.event.payload, expression.slice("payload.".length));
    }
    const [root, ...path] = expression.split(".");
    if (!root) {
      return undefined;
    }
    const value = values.has(root) ? values.get(root) : this.variables.get(root);
    return path.length ? pathValue(value, path.join(".")) : value;
  }

  private triggerOutputs(): Record<string, unknown> {
    return { ...this.event.payload, payload: this.event.payload };
  }

  private async callCloudxHooks(node: AutomationNode, calls: CloudxHookCallRequest[]): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const call of calls) {
      this.assertNotCancelled();
      const entry = this.requireHookCatalogEntry(call.hookId);
      this.assertSafetyAllowed(entry);
      this.trace("info", `Calling CloudX hook ${call.hookId}.`, node.id, { hookId: call.hookId });
      const result = await this.hooks.call(call.hookId, call.input, {
        caller: { kind: "automation", pluginId: "automation", automationGroupId: this.group.id },
        targetTabId: call.targetTabId,
        activeTabId: this.options.activeTabId,
        signal: this.options.signal
      });
      this.assertNotCancelled();
      await this.options.effectSink?.applyHookResult(result);
      results.push(result);
    }
    return results;
  }

  private requireHookCatalogEntry(hookId: string): AutomationNodeCatalogEntry {
    const entry = this.catalogByType.get(`hook:${hookId}`);
    if (!entry || entry.kind !== "function") {
      throw new Error(`Hook ${hookId} is not available in the automation catalog.`);
    }
    return entry;
  }

  private entry(node: AutomationNode): AutomationNodeCatalogEntry | undefined {
    const entry = this.catalogByType.get(node.typeId);
    return entry ? automationEntryWithDynamicPorts(entry, node.config) : undefined;
  }

  private requireEntry(node: AutomationNode): AutomationNodeCatalogEntry {
    const entry = this.entry(node);
    if (!entry) {
      throw new Error(`Unknown node type ${node.typeId}.`);
    }
    return entry;
  }

  private assertSafetyAllowed(entry: AutomationNodeCatalogEntry): void {
    if (automationSafetyAllowed(entry.safety, this.group.graph.allowedSafety)) {
      return;
    }
    const safety = entry.safety ?? "unknown";
    throw new Error(`${entry.title} requires ${safety} automation safety. Enable ${safety} for this graph before it can run.`);
  }

  private guard(nodeId: string): void {
    this.assertNotCancelled();
    this.steps += 1;
    if (this.steps > (this.options.maxSteps ?? 1000)) {
      throw new Error(`Automation step limit exceeded near node ${nodeId}.`);
    }
    if (Date.now() - this.startedAt > (this.options.maxDurationMs ?? 5 * 60 * 1000)) {
      throw new Error(`Automation duration limit exceeded near node ${nodeId}.`);
    }
  }

  private remainingDurationBudgetMs(): number {
    return Math.max(0, (this.options.maxDurationMs ?? 5 * 60 * 1000) - (Date.now() - this.startedAt));
  }

  private assertNotCancelled(): void {
    if (this.options.signal?.aborted) {
      throw new AutomationCancelledError();
    }
  }

  private invalidateCachedDataNodeOutputs(): void {
    for (const [nodeId] of this.outputs) {
      const node = this.nodesById.get(nodeId);
      const entry = node ? this.entry(node) : undefined;
      if (!entry || entry.kind === "trigger" || entry.inputs.some((port) => port.kind === "exec")) {
        continue;
      }
      this.outputs.delete(nodeId);
    }
  }
}

function requireConfigString(node: AutomationNode, key: string): string {
  const value = node.config?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Node ${node.id} requires config.${key}.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPluginTargetTabPort(entry: AutomationNodeCatalogEntry, port: { automationRole?: string }): boolean {
  return entry.kind === "function" && typeof entry.pluginId === "string" && port.automationRole === "pluginTargetTab";
}

function arrayValue(value: unknown, node: AutomationNode, key: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Node ${node.id} requires ${key} to be an array.`);
}

function integerValue(value: unknown, node: AutomationNode, key: string): number {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Node ${node.id} requires ${key} to be an integer.`);
  }
  return number;
}

function numberValue(value: unknown, node: AutomationNode, key: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Node ${node.id} requires ${key} to be a finite number.`);
  }
  return number;
}

function durationMsValue(value: unknown, node: AutomationNode, key: string, max: number): number {
  const number = integerValue(value, node, key);
  if (number < 0) {
    throw new Error(`Node ${node.id} requires ${key} to be non-negative.`);
  }
  if (number > max) {
    throw new Error(`Node ${node.id} requires ${key} to be no greater than ${max} ms.`);
  }
  return number;
}

function booleanValue(value: unknown, node: AutomationNode, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Node ${node.id} requires ${key} to be a boolean.`);
  }
  return value;
}

function enumInputValue<T extends string>(value: unknown, allowed: readonly T[], node: AutomationNode, key: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Node ${node.id} requires ${key} to be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function compareStrings(left: string, right: string, operator: string, caseSensitive: boolean, node: AutomationNode): boolean {
  const actualLeft = caseSensitive ? left : left.toLocaleLowerCase();
  const actualRight = caseSensitive ? right : right.toLocaleLowerCase();
  if (operator === "equals") {
    return actualLeft === actualRight;
  }
  if (operator === "notEquals") {
    return actualLeft !== actualRight;
  }
  if (operator === "contains") {
    return actualLeft.includes(actualRight);
  }
  if (operator === "startsWith") {
    return actualLeft.startsWith(actualRight);
  }
  if (operator === "endsWith") {
    return actualLeft.endsWith(actualRight);
  }
  throw new Error(`Node ${node.id} has unsupported string comparison operator: ${operator}.`);
}

function compareNumbers(left: number, right: number, operator: string, node: AutomationNode): boolean {
  if (operator === "equals") {
    return left === right;
  }
  if (operator === "notEquals") {
    return left !== right;
  }
  if (operator === "lessThan") {
    return left < right;
  }
  if (operator === "lessThanOrEqual") {
    return left <= right;
  }
  if (operator === "greaterThan") {
    return left > right;
  }
  if (operator === "greaterThanOrEqual") {
    return left >= right;
  }
  throw new Error(`Node ${node.id} has unsupported number comparison operator: ${operator}.`);
}

function numberInRange(value: number, min: number, max: number, mode: string, node: AutomationNode): boolean {
  if (min > max) {
    throw new Error(`Node ${node.id} requires min to be less than or equal to max.`);
  }
  const inclusive = value >= min && value <= max;
  const exclusive = value > min && value < max;
  if (mode === "inclusive") {
    return inclusive;
  }
  if (mode === "exclusive") {
    return exclusive;
  }
  if (mode === "outsideInclusive") {
    return !inclusive;
  }
  if (mode === "outsideExclusive") {
    return !exclusive;
  }
  throw new Error(`Node ${node.id} has unsupported range mode: ${mode}.`);
}

function textValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function sleepForAutomation(durationMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AutomationCancelledError());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new AutomationCancelledError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

function automationRegExp(patternValue: unknown, flagsValue: unknown, node: AutomationNode): RegExp {
  const pattern = textValue(patternValue);
  const flags = textValue(flagsValue);
  if (pattern.length > AUTOMATION_REGEX_PATTERN_MAX_CHARS) {
    throw new Error(`Node ${node.id} regular expression pattern exceeds ${AUTOMATION_REGEX_PATTERN_MAX_CHARS} characters.`);
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Node ${node.id} has an invalid regular expression: ${message}`);
  }
  if (!safeRegex(expression, { limit: AUTOMATION_REGEX_REPEAT_LIMIT })) {
    throw new Error(`Node ${node.id} regular expression is too complex and may cause excessive backtracking.`);
  }
  return expression;
}

function regexTextValue(value: unknown, node: AutomationNode, key: string): string {
  const text = textValue(value);
  if (text.length > AUTOMATION_REGEX_TEXT_MAX_CHARS) {
    throw new Error(`Node ${node.id} ${key} exceeds ${AUTOMATION_REGEX_TEXT_MAX_CHARS} characters for regular expression matching.`);
  }
  return text;
}

interface FStringField {
  expression: string;
  debug: boolean;
  conversion?: "s" | "r" | "a";
  formatSpec?: string;
}

function renderFStringTemplate(template: string, resolve: (expression: string) => unknown): string {
  let result = "";
  const append = (segment: string) => {
    if (result.length + segment.length > AUTOMATION_FSTRING_OUTPUT_MAX_CHARS) {
      throw new Error(`F-string output exceeds ${AUTOMATION_FSTRING_OUTPUT_MAX_CHARS} characters.`);
    }
    result += segment;
  };
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    const next = template[index + 1];
    if (char === "{" && next === "{") {
      append("{");
      index += 1;
      continue;
    }
    if (char === "}" && next === "}") {
      append("}");
      index += 1;
      continue;
    }
    if (char === "}") {
      throw new Error("F-string template contains an unmatched closing brace.");
    }
    if (char !== "{") {
      append(char);
      continue;
    }
    const close = template.indexOf("}", index + 1);
    if (close === -1) {
      throw new Error("F-string template contains an unmatched opening brace.");
    }
    const fieldText = template.slice(index + 1, close);
    const field = parseFStringField(fieldText);
    const value = resolve(field.expression);
    const rendered = formatFStringValue(value, field.conversion, field.formatSpec);
    append(field.debug ? `${field.expression}=${rendered}` : rendered);
    index = close;
  }
  return result;
}

function parseFStringField(fieldText: string): FStringField {
  let remaining = fieldText.trim();
  if (!remaining) {
    throw new Error("F-string template contains an empty replacement field.");
  }
  let formatSpec: string | undefined;
  const colon = remaining.indexOf(":");
  if (colon >= 0) {
    formatSpec = remaining.slice(colon + 1);
    remaining = remaining.slice(0, colon).trim();
  }
  let conversion: FStringField["conversion"];
  const conversionMatch = /!([sra])$/.exec(remaining);
  if (conversionMatch) {
    conversion = conversionMatch[1] as FStringField["conversion"];
    remaining = remaining.slice(0, -2).trim();
  }
  let debug = false;
  if (remaining.endsWith("=")) {
    debug = true;
    remaining = remaining.slice(0, -1).trim();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(remaining)) {
    throw new Error(`F-string field ${JSON.stringify(fieldText)} must be a named input such as {name} or {payload.path}.`);
  }
  return { expression: remaining, debug, conversion, formatSpec };
}

function formatFStringValue(value: unknown, conversion?: FStringField["conversion"], formatSpec = ""): string {
  const converted = conversion === "r" ? repr(value) : conversion === "a" ? asciiRepr(value) : stringify(value);
  if (!formatSpec) {
    return converted;
  }
  if (typeof value === "number") {
    return formatNumber(value, formatSpec);
  }
  if (/^\d*s?$/.test(formatSpec)) {
    const widthText = formatSpec.replace(/s$/, "");
    const width = widthText ? parseBoundedFormatInteger(widthText, "width", AUTOMATION_FSTRING_FORMAT_WIDTH_MAX) : undefined;
    return width !== undefined && width > converted.length ? converted.padStart(width) : converted;
  }
  throw new Error(`Unsupported f-string format specifier: ${formatSpec}.`);
}

function formatNumber(value: number, formatSpec: string): string {
  const match = /^(?<comma>,)?(?:(?<width>\d+))?(?:\.(?<precision>\d+))?(?<type>[fFgGd%])?$/.exec(formatSpec);
  if (!match?.groups) {
    throw new Error(`Unsupported f-string format specifier: ${formatSpec}.`);
  }
  let precision =
    match.groups.precision === undefined
      ? undefined
      : parseBoundedFormatInteger(match.groups.precision, "precision", AUTOMATION_FSTRING_FORMAT_PRECISION_MAX);
  const type = match.groups.type ?? "g";
  if (type === "d" && precision !== undefined) {
    throw new Error("F-string precision is not supported for d integer formats.");
  }
  if ((type === "g" || type === "G") && precision === 0) {
    precision = 1;
  }
  let rendered: string;
  if (type === "d") {
    rendered = String(Math.trunc(value));
  } else if (type === "%") {
    rendered = `${((precision === undefined ? value * 100 : Number((value * 100).toFixed(precision)))).toLocaleString("en-US", { minimumFractionDigits: precision ?? 0, maximumFractionDigits: precision ?? 20 })}%`;
  } else if (type === "f" || type === "F") {
    rendered = value.toLocaleString("en-US", { useGrouping: match.groups.comma === ",", minimumFractionDigits: precision ?? 6, maximumFractionDigits: precision ?? 6 });
  } else {
    rendered = precision === undefined ? String(value) : value.toPrecision(precision);
    if (match.groups.comma === ",") {
      const [whole, fraction] = rendered.split(".");
      rendered = `${Number(whole).toLocaleString("en-US")}${fraction === undefined ? "" : `.${fraction}`}`;
    }
  }
  const width =
    match.groups.width === undefined
      ? undefined
      : parseBoundedFormatInteger(match.groups.width, "width", AUTOMATION_FSTRING_FORMAT_WIDTH_MAX);
  return width && width > rendered.length ? rendered.padStart(width) : rendered;
}

function parseBoundedFormatInteger(value: string, label: "precision" | "width", max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`F-string format ${label} must be a non-negative integer.`);
  }
  if (parsed > max) {
    throw new Error(`F-string format ${label} exceeds ${max}.`);
  }
  return parsed;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (isSafePathPart(key) && hasOwn(current, key)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function setPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  for (const part of parts) {
    if (!isSafePathPart(part)) {
      throw new Error(`Unsafe automation path segment: ${part}.`);
    }
  }
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = hasOwn(current, part) ? current[part] : undefined;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function flattenObject(value: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      Object.assign(flattened, flattenObject(child, path));
      continue;
    }
    flattened[path] = child;
  }
  return flattened;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: unknown, key: string): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && Object.prototype.hasOwnProperty.call(value, key);
}

function isSafePathPart(part: string): boolean {
  return part !== "__proto__" && part !== "prototype" && part !== "constructor";
}

function repr(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return stringify(value);
}

function asciiRepr(value: unknown): string {
  return repr(value).replace(/[^\x00-\x7F]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function trimData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, "utf8") <= 1024 * 1024) {
    return data;
  }
  return { truncated: true };
}

interface PythonRunInput {
  code: string;
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface BashRunInput {
  script: string;
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ProcessRunInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  processName: string;
  outputMaxBytes: number;
  signal?: AbortSignal;
}

interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type PythonRunResult = ProcessRunResult;
type BashRunResult = ProcessRunResult;

interface CloudxHookCallRequest {
  hookId: string;
  input: Record<string, unknown>;
  targetTabId?: string;
}

interface CodexExecInput {
  prompt: string;
  stdin: string;
  cwd: string;
  timeoutMs: number;
  profile?: string;
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "never";
  ephemeral: boolean;
  json: boolean;
  skipGitRepoCheck: boolean;
  signal?: AbortSignal;
}

interface CodexExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function resolveAutomationProcessCwd(cwdValue: unknown, allowedRoots: string[] | undefined, processName: string): Promise<string> {
  const roots = allowedRoots?.length ? allowedRoots : [process.cwd()];
  const rootRealPaths = await Promise.all(roots.map((root) => realpathOrResolved(root)));
  const base = rootRealPaths[0];
  if (!base) {
    throw new Error(`Automation ${processName} execution requires at least one allowed root.`);
  }
  const cwdText = optionalString(cwdValue);
  const resolved = cwdText ? (path.isAbsolute(cwdText) ? path.resolve(cwdText) : path.resolve(base, cwdText)) : base;
  const real = await fs.realpath(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`${processName} working directory does not exist: ${resolved}`);
    }
    throw error;
  });
  if (!rootRealPaths.some((root) => isSameOrChildPath(root, real))) {
    throw new Error(`${processName} working directory is outside configured Cloudx roots: ${cwdText ?? resolved}`);
  }
  return real;
}

async function realpathOrResolved(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  return fs.realpath(resolved).catch(() => resolved);
}

function runPythonCode(input: PythonRunInput): Promise<PythonRunResult> {
  return runBoundedProcess({
    command: "python3",
    args: ["-c", input.code],
    cwd: input.cwd,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
    processName: "Python",
    outputMaxBytes: AUTOMATION_PYTHON_OUTPUT_MAX_BYTES,
    signal: input.signal
  });
}

function runBashScript(input: BashRunInput): Promise<BashRunResult> {
  return runBoundedProcess({
    command: "bash",
    args: ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", input.script],
    cwd: input.cwd,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
    processName: "Bash",
    outputMaxBytes: AUTOMATION_BASH_OUTPUT_MAX_BYTES,
    signal: input.signal
  });
}

function runBoundedProcess(input: ProcessRunInput): Promise<ProcessRunResult> {
  if (input.signal?.aborted) {
    return Promise.reject(new AutomationCancelledError());
  }
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: automationProcessEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      stopChildProcess(child, signal);
      if (signal === "SIGTERM" && !killTimeout) {
        killTimeout = setTimeout(() => stopChildProcess(child, "SIGKILL"), AUTOMATION_PROCESS_TERMINATION_GRACE_MS);
        killTimeout.unref();
      }
    };
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || !childStdin) {
      terminate("SIGTERM");
      reject(new Error(`${input.processName} process did not expose piped stdio streams.`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stoppingError: Error | undefined;
    let cancelled = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      input.signal?.removeEventListener("abort", abort);
    };
    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const stopWithError = (error: Error) => {
      if (!stoppingError) {
        stoppingError = error;
      }
      terminate("SIGTERM");
    };
    const abort = () => {
      cancelled = true;
      terminate("SIGTERM");
    };
    const timeout = setTimeout(() => {
      stopWithError(new Error(`${input.processName} process timed out after ${input.timeoutMs} ms.`));
    }, input.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });

    const appendOutput = (streamName: "stdout" | "stderr", chunk: string) => {
      if (stoppingError || cancelled) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (streamName === "stdout") {
        stdoutBytes += chunkBytes;
        if (stdoutBytes > input.outputMaxBytes) {
          stopWithError(new Error(`${input.processName} stdout exceeded the ${input.outputMaxBytes} byte output limit.`));
          return;
        }
        stdout += chunk;
        return;
      }
      stderrBytes += chunkBytes;
      if (stderrBytes > input.outputMaxBytes) {
        stopWithError(new Error(`${input.processName} stderr exceeded the ${input.outputMaxBytes} byte output limit.`));
        return;
      }
      stderr += chunk;
    };

    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk) => appendOutput("stdout", chunk));
    childStderr.on("data", (chunk) => appendOutput("stderr", chunk));
    childStdout.on("error", (error) => stopWithError(error));
    childStderr.on("error", (error) => stopWithError(error));
    childStdin.on("error", (error) => {
      if (!stoppingError && !cancelled) {
        stopWithError(error);
      }
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new AutomationCancelledError());
        return;
      }
      if (stoppingError) {
        reject(stoppingError);
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    childStdin.end(input.stdin);
  });
}

function extractCloudxHookCalls(stdout: string, node: AutomationNode, hookToken: string): { stdout: string; calls: CloudxHookCallRequest[] } {
  const hookPrefix = `${CLOUDX_HOOK_STDOUT_PREFIX}${hookToken}:`;
  const visibleChunks: string[] = [];
  const calls: CloudxHookCallRequest[] = [];
  for (const chunk of stdout.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!chunk) {
      continue;
    }
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
    if (!line.startsWith(hookPrefix)) {
      visibleChunks.push(chunk);
      continue;
    }
    const payloadText = line.slice(hookPrefix.length);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Node ${node.id} emitted an invalid CloudX hook request: ${message}`);
    }
    calls.push(cloudxHookCallRequest(payload, node));
  }
  return { stdout: visibleChunks.join(""), calls };
}

function cloudxHookCallRequest(payload: unknown, node: AutomationNode): CloudxHookCallRequest {
  if (!isPlainObject(payload)) {
    throw new Error(`Node ${node.id} emitted a CloudX hook request that is not an object.`);
  }
  const hookId = payload.hookId;
  if (typeof hookId !== "string" || !hookId.trim()) {
    throw new Error(`Node ${node.id} emitted a CloudX hook request without a hookId.`);
  }
  const input = payload.input;
  if (input !== undefined && !isPlainObject(input)) {
    throw new Error(`Node ${node.id} emitted a CloudX hook request whose input is not an object.`);
  }
  const targetTabId = payload.targetTabId;
  if (targetTabId !== undefined && (typeof targetTabId !== "string" || !targetTabId.trim())) {
    throw new Error(`Node ${node.id} emitted a CloudX hook request with an invalid targetTabId.`);
  }
  return { hookId: hookId.trim(), input: input ?? {}, targetTabId: typeof targetTabId === "string" ? targetTabId.trim() : undefined };
}

function automationProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUTOMATION_PROCESS_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function stopChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
      return;
    }
  }
  child.kill(signal);
}

function runCodexExec(input: CodexExecInput): Promise<CodexExecResult> {
  const args = [
    "exec",
    "--cd",
    input.cwd,
    "--sandbox",
    input.sandbox,
    "--ask-for-approval",
    input.approvalPolicy
  ];
  if (input.ephemeral) {
    args.push("--ephemeral");
  }
  if (input.profile) {
    args.push("--profile", input.profile);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.json) {
    args.push("--json");
  }
  if (input.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  args.push(input.prompt);
  return runCodexProcess({
    command: resolveAssistantCommand(process.env, "codex"),
    args,
    cwd: input.cwd,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
    signal: input.signal
  });
}

function runCodexProcess(input: { command: string; args: string[]; cwd: string; stdin: string; timeoutMs: number; signal?: AbortSignal }): Promise<CodexExecResult> {
  if (input.signal?.aborted) {
    return Promise.reject(new AutomationCancelledError());
  }
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: buildToolEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      stopChildProcess(child, signal);
      if (signal === "SIGTERM" && !killTimeout) {
        killTimeout = setTimeout(() => stopChildProcess(child, "SIGKILL"), AUTOMATION_PROCESS_TERMINATION_GRACE_MS);
        killTimeout.unref();
      }
    };
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || !childStdin) {
      terminate("SIGTERM");
      reject(new Error("Codex exec process did not expose piped stdio streams."));
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stoppingError: Error | undefined;
    let cancelled = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      input.signal?.removeEventListener("abort", abort);
    };
    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const stopWithError = (error: Error) => {
      if (!stoppingError) {
        stoppingError = error;
      }
      terminate("SIGTERM");
    };
    const abort = () => {
      cancelled = true;
      terminate("SIGTERM");
    };
    const timeout = setTimeout(() => {
      stopWithError(new Error(`Codex exec process timed out after ${input.timeoutMs} ms.`));
    }, input.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });

    const appendOutput = (streamName: "stdout" | "stderr", chunk: string) => {
      if (stoppingError || cancelled) {
        return;
      }
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (streamName === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes > AUTOMATION_CODEX_OUTPUT_MAX_BYTES) {
          stopWithError(new Error(`Codex exec stdout exceeded ${AUTOMATION_CODEX_OUTPUT_MAX_BYTES} bytes.`));
          return;
        }
        stdout += chunk;
        return;
      }
      stderrBytes += bytes;
      if (stderrBytes > AUTOMATION_CODEX_OUTPUT_MAX_BYTES) {
        stopWithError(new Error(`Codex exec stderr exceeded ${AUTOMATION_CODEX_OUTPUT_MAX_BYTES} bytes.`));
        return;
      }
      stderr += chunk;
    };

    child.once("error", (error) => settleReject(error));
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new AutomationCancelledError());
        return;
      }
      if (stoppingError) {
        reject(stoppingError);
        return;
      }
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : signal ? 128 : 1 });
    });
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
    childStderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
    childStdin.end(input.stdin);
  });
}

function parseCodexJsonLines(stdout: string, node: AutomationNode): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error(`Node ${node.id} Codex JSONL output contained a non-object event.`);
    }
    events.push(parsed);
  }
  return events;
}

function finalMessageFromCodexEvents(events: Record<string, unknown>[]): string {
  for (const event of [...events].reverse()) {
    if (event.type !== "item.completed" || !isPlainObject(event.item)) {
      continue;
    }
    if (event.item.type === "agent_message" && typeof event.item.text === "string") {
      return event.item.text;
    }
  }
  return "";
}
