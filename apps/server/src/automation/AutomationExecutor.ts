import { randomUUID } from "node:crypto";

import type { HookRegistry } from "../hooks/HookRegistry.js";
import type { AutomationCatalogResponse, AutomationEdge, AutomationGroup, AutomationNode, AutomationNodeCatalogEntry, AutomationRunSummary, AutomationRunTraceEntry, TriggerEvent } from "@cloudx/shared";
import { AUTOMATION_FSTRING_TYPE_ID, automationEntryWithDynamicPorts, automationFStringInputNames } from "@cloudx/shared";

export interface AutomationExecutorOptions {
  activeTabId?: string;
  maxSteps?: number;
  maxDurationMs?: number;
  maxTraceEntries?: number;
}

type OutputMap = Map<string, Record<string, unknown>>;

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
      await runtime.execute();
      run.status = "succeeded";
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      runtime.trace("error", run.error);
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
    this.trace("info", `Running ${entry.title}.`, node.id);
    if (entry.kind === "trigger") {
      this.outputs.set(node.id, this.triggerOutputs());
      await this.executeNext(node, "exec");
      return;
    }
    if (entry.kind === "function") {
      const input = await this.inputObject(node, entry);
      const result = await this.hooks.call(entry.hookId!, input, {
        caller: { kind: "automation", pluginId: "automation", automationGroupId: this.group.id },
        targetTabId: optionalString(node.config?.targetTabId),
        activeTabId: this.options.activeTabId
      });
      this.outputs.set(node.id, { result, ...result, ...flattenObject(result) });
      this.trace("info", `${entry.title} completed.`, node.id);
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:if") {
      const condition = Boolean(await this.inputValue(node, "condition"));
      this.outputs.set(node.id, { condition });
      await this.executeNext(node, condition ? "true" : "false");
      return;
    }
    if (node.typeId === "primitive:while") {
      let iterations = 0;
      while (Boolean(await this.inputValue(node, "condition"))) {
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
      this.outputs.set(node.id, { value });
      await this.executeNext(node, "exec");
      return;
    }
    if (node.typeId === "primitive:variables.set") {
      const name = requireConfigString(node, "name");
      const value = await this.inputValue(node, "value");
      this.variables.set(name, value);
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
      if (node.config && portId in node.config) {
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
      return node.config?.value === true;
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
      if (Boolean(await this.optionalInputValue(node, "regex"))) {
        return text.replace(new RegExp(search, textValue(await this.optionalInputValue(node, "flags"))), replacement);
      }
      return search ? text.split(search).join(replacement) : text;
    }
    if (node.typeId === "primitive:string.regex.test") {
      return new RegExp(textValue(await this.inputValue(node, "pattern")), textValue(await this.optionalInputValue(node, "flags"))).test(textValue(await this.inputValue(node, "text")));
    }
    if (node.typeId === "primitive:string.regex.extract") {
      const match = new RegExp(textValue(await this.inputValue(node, "pattern")), textValue(await this.optionalInputValue(node, "flags"))).exec(textValue(await this.inputValue(node, "text")));
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
      return JSON.parse(value) as Record<string, unknown>;
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
        return stringify(this.event.payload[trimmed.slice("payload.".length)]);
      }
      return stringify(node.config?.[trimmed] ?? this.variables.get(trimmed));
    });
  }

  private async renderFString(node: AutomationNode): Promise<string> {
    const template = typeof node.config?.template === "string" ? node.config.template : "Hello {value}";
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
    return { exec: true, payload: this.event.payload, ...this.event.payload };
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

  private guard(nodeId: string): void {
    this.steps += 1;
    if (this.steps > (this.options.maxSteps ?? 1000)) {
      throw new Error(`Automation step limit exceeded near node ${nodeId}.`);
    }
    if (Date.now() - this.startedAt > (this.options.maxDurationMs ?? 5 * 60 * 1000)) {
      throw new Error(`Automation duration limit exceeded near node ${nodeId}.`);
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

function textValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

interface FStringField {
  expression: string;
  debug: boolean;
  conversion?: "s" | "r" | "a";
  formatSpec?: string;
}

function renderFStringTemplate(template: string, resolve: (expression: string) => unknown): string {
  let result = "";
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    const next = template[index + 1];
    if (char === "{" && next === "{") {
      result += "{";
      index += 1;
      continue;
    }
    if (char === "}" && next === "}") {
      result += "}";
      index += 1;
      continue;
    }
    if (char === "}") {
      throw new Error("F-string template contains an unmatched closing brace.");
    }
    if (char !== "{") {
      result += char;
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
    result += field.debug ? `${field.expression}=${rendered}` : rendered;
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
    const width = Number.parseInt(formatSpec.replace(/s$/, ""), 10);
    return Number.isFinite(width) && width > converted.length ? converted.padStart(width) : converted;
  }
  throw new Error(`Unsupported f-string format specifier: ${formatSpec}.`);
}

function formatNumber(value: number, formatSpec: string): string {
  const match = /^(?<comma>,)?(?:(?<width>\d+))?(?:\.(?<precision>\d+))?(?<type>[fFgGd%])?$/.exec(formatSpec);
  if (!match?.groups) {
    throw new Error(`Unsupported f-string format specifier: ${formatSpec}.`);
  }
  const precision = match.groups.precision === undefined ? undefined : Number(match.groups.precision);
  const type = match.groups.type ?? "g";
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
  const width = match.groups.width === undefined ? undefined : Number(match.groups.width);
  return width && width > rendered.length ? rendered.padStart(width) : rendered;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
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
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
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
