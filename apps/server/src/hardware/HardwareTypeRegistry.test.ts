import { describe, expect, it } from "vitest";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { JsonSchema } from "@cloudx/shared";
import { HardwareTypeRegistry } from "./HardwareTypeRegistry.js";

function provider(): HardwareTypeProvider<unknown> {
  return {
    descriptor: {
      id: "test.pcie", ownerPluginId: "test", apiVersion: 1, configVersion: 1, displayName: "Test PCIe", description: "An independent provider with a register operation.",
      configSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"], additionalProperties: false },
      operations: [{ id: "pcie.read", description: "Read a register.", inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 } }, required: ["offset"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }]
    },
    parseConfig: (value) => value,
    inspectEndpoint: async () => ({ resourceKeys: ["pcie:0"], ready: true, blockers: [] }),
    describeAccess: () => ({ summary: "PCIe test", details: {} }),
    connect: async () => ({ state: "failed", effects: "none", error: { code: "TEST", message: "Test descriptor." } })
  };
}

describe("HardwareTypeRegistry", () => {
  it("loads code contributions and validates independent configuration and operations", async () => {
    const contributed = provider();
    const registry = new HardwareTypeRegistry([{ id: "test", hardwareTypes: [contributed] }, { id: "empty" }]);
    expect(registry.values()).toEqual([contributed]);
    expect(registry.get("test.pcie")).toBe(contributed);
    expect(registry.parseConfig("test.pcie", 1, { address: "0000:01:00.0" })).toEqual({ address: "0000:01:00.0" });
    await expect(registry.inspectEndpoint("test.pcie", 1, { address: "0000:01:00.0" })).resolves.toMatchObject({ ready: true });
    expect(() => registry.validateInput("test.pcie", "pcie.read", { offset: 4 })).not.toThrow();
    expect(() => registry.validateOutput("test.pcie", "pcie.read", { value: 42 })).not.toThrow();
    expect(() => registry.parseConfig("test.pcie", 1, { address: 5 })).toThrow("/address");
    expect(() => registry.parseConfig("test.pcie", 2, { address: "x" })).toThrow("configuration version 2");
    expect(() => registry.validateInput("test.pcie", "pcie.read", { offset: -1 })).toThrow("/offset");
    expect(() => registry.validateOutput("test.pcie", "pcie.read", { value: "42" })).toThrow("/value");
    expect(() => registry.validateInput("test.pcie", "ssh.exec", {})).toThrow("does not provide");
    expect(() => registry.get("missing.type")).toThrow(expect.objectContaining({ code: "PROVIDER_UNAVAILABLE" }));
  });

  it.each(["owner", "namespace", "api", "version", "duplicate-operation", "missing-method"])("rejects invalid contribution %s at startup", (invalid) => {
    const contributed = provider();
    if (invalid === "owner") contributed.descriptor.ownerPluginId = "other";
    if (invalid === "namespace") contributed.descriptor.id = "other.pcie";
    if (invalid === "api") (contributed.descriptor as { apiVersion: number }).apiVersion = 2;
    if (invalid === "version") contributed.descriptor.configVersion = 0;
    if (invalid === "duplicate-operation") contributed.descriptor.operations.push(contributed.descriptor.operations[0]!);
    if (invalid === "missing-method") (contributed as unknown as { connect: unknown }).connect = null;
    expect(() => new HardwareTypeRegistry([{ id: "test", hardwareTypes: [contributed] }])).toThrow();
  });

  it("rejects duplicate IDs, invalid schemas, remote references, excessive schemas, and non-JSON input", () => {
    expect(() => new HardwareTypeRegistry([{ id: "test", hardwareTypes: [provider(), provider()] }])).toThrow("Duplicate hardware type");
    const schemas: JsonSchema[] = [
      { type: "object", properties: { x: { $ref: "https://example.com/schema" } } },
      { type: "object", properties: { x: { type: "bogus" } } },
      { type: "object", description: "x".repeat(65536) },
      { type: "object", $id: "local" }
    ];
    for (const schema of schemas) {
      const contributed = provider();
      contributed.descriptor.configSchema = schema;
      expect(() => new HardwareTypeRegistry([{ id: "test", hardwareTypes: [contributed] }])).toThrow();
    }
    const registry = new HardwareTypeRegistry([{ id: "test", hardwareTypes: [provider()] }]);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => registry.parseConfig("test.pcie", 1, cyclic)).toThrow("finite JSON");
    expect(() => registry.parseConfig("test.pcie", 1, { address: undefined })).toThrow("finite JSON");
  });

  it("supports bounded local JSON Schema references", () => {
    const contributed = provider();
    contributed.descriptor.configSchema = { type: "object", properties: { address: { $ref: "#/$defs/address" } }, $defs: { address: { type: "string", minLength: 1 } }, required: ["address"] };
    const registry = new HardwareTypeRegistry([{ id: "test", hardwareTypes: [contributed] }]);
    expect(() => registry.parseConfig("test.pcie", 1, { address: "" })).toThrow();
    expect(registry.parseConfig("test.pcie", 1, { address: "x" })).toEqual({ address: "x" });
  });
});
