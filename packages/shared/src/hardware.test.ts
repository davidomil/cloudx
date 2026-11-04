import { describe, expect, it } from "vitest";
import { hardwareId, hardwareInteger, hardwareRecord, hardwareStatusPrimitive, hardwareText, parseHardwareItem, parseHardwareOwner, parseHardwareScript, validateHardwareJson, validateHardwareStatusValue, type HardwareItem } from "./hardware.js";

const script = { source: "printf true", cwd: "/tmp", timeoutMs: 1000, maxOutputBytes: 4096, credentialRefIds: [] };
const item: HardwareItem = { id: "target", revision: 1, name: "Target", description: "", enabled: true, physicalResourceId: "lab", typeId: "fixture", configVersion: 1, config: { endpoint: "target" }, tagIds: [], notes: "", notesRevision: 1, statuses: [], hooks: {} };

describe("Hardware serialized contract validation", () => {
  it("validates bounded records, identifiers, text, integers, and exact status primitives", () => {
    expect(hardwareRecord({ value: true })).toEqual({ value: true }); expect(() => hardwareRecord([])).toThrow(); expect(() => hardwareRecord(new Date())).toThrow();
    expect(hardwareId("target:uart-1")).toBe("target:uart-1"); expect(() => hardwareId("../../target")).toThrow();
    expect(hardwareText("", "Notes", 10, true)).toBe(""); expect(() => hardwareText("x\0y", "Notes")).toThrow(); expect(() => hardwareText(" ", "Label")).toThrow();
    expect(hardwareInteger(0, "Offset", 0)).toBe(0); expect(() => hardwareInteger(1.5, "Revision")).toThrow();
    expect(hardwareStatusPrimitive(false)).toBe(false); expect(hardwareStatusPrimitive("false")).toBe("false"); expect(() => hardwareStatusPrimitive(0)).toThrow();
  });

  it("keeps the complete execution and managed attempt owner identity", () => {
    const owner = { kind: "agent", providerId: "claude", tabId: "tab", executionId: "execution", ownerPluginId: "forge", logicalRunId: "run", workerId: "worker", attemptId: "attempt" };
    expect(parseHardwareOwner(owner)).toEqual(owner); expect(parseHardwareOwner({ kind: "user", userId: "local" })).toEqual({ kind: "user", userId: "local" });
    expect(() => parseHardwareOwner({ ...owner, attemptId: undefined })).toThrow(); expect(() => parseHardwareOwner({ ...owner, providerId: "other" })).toThrow();
  });

  it("requires explicit script bounds, an absolute cwd, and unique credential environment names", () => {
    expect(parseHardwareScript(script)).toEqual(script);
    for (const patch of [{ cwd: "relative" }, { timeoutMs: 0 }, { maxOutputBytes: 2 * 1024 * 1024 }, { credentialRefIds: ["foo-bar", "foo_bar"] }, { retry: true }]) expect(() => parseHardwareScript({ ...script, ...patch })).toThrow();
  });

  it("rejects malformed item JSON, duplicate bindings/tags, and unknown fields", () => {
    expect(parseHardwareItem(item)).toEqual(item);
    const binding = { revision: 1, definitionId: "ready", source: "manual", value: false, requiredForReserve: { equals: false } };
    expect(parseHardwareItem({ ...item, statuses: [binding] }).statuses[0]).toEqual(binding);
    for (const patch of [{ tagIds: ["tag", "tag"] }, { statuses: [binding, binding] }, { config: { invalid: Infinity } }, { hooks: { onConnect: script } }, { typo: true }, { statuses: [{ ...binding, maxAgeMs: 100 }] }]) expect(() => parseHardwareItem({ ...item, ...patch })).toThrow();
  });

  it("uses the declared exact status domain and rejects cyclic or oversized JSON", () => {
    const definition = { id: "ready", revision: 1, label: "Ready", valueType: "boolean" as const };
    expect(() => validateHardwareStatusValue(false, definition)).not.toThrow(); expect(() => validateHardwareStatusValue("false", definition)).toThrow();
    expect(() => validateHardwareStatusValue("READY", { ...definition, valueType: "enum", enumValues: ["ready"] })).toThrow();
    expect(() => validateHardwareStatusValue("ready", { ...definition, valueType: "enum", enumValues: ["ready"] })).not.toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => validateHardwareJson(cyclic)).toThrow(); expect(() => validateHardwareJson({ value: NaN })).toThrow(); expect(() => validateHardwareJson({ value: undefined })).toThrow(); expect(() => validateHardwareJson({ value: "x".repeat(1024 * 1024 + 1) })).toThrow();
  });
});
