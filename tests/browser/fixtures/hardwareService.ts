import { randomUUID } from "node:crypto";
import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type {
  HardwareItem,
  HardwareItemDraft,
  HardwareMutationResult,
  HardwareOwner,
  HardwareTypeDescriptor,
  JsonObject,
  OperationReceipt,
  ProviderOutcome,
} from "@cloudx/shared";
import { HardwareService } from "../../../apps/server/src/hardware/HardwareService.js";
import { PathPolicy } from "../../../apps/server/src/pathPolicy.js";
import {
  SshHardwareProvider,
  sshHardwareDescriptor,
} from "../../../apps/server/src/hardware/transports/SshHardwareProvider.js";
import {
  UartHardwareProvider,
  uartHardwareDescriptor,
} from "../../../apps/server/src/hardware/transports/UartHardwareProvider.js";

export const operator: HardwareOwner = { kind: "user", userId: "local" };
export const worker: HardwareOwner = {
  kind: "agent",
  tabId: "fixture-claude",
  providerId: "claude",
  executionId: "execution-1",
  ownerPluginId: "forge",
  logicalRunId: "validation-run",
  workerId: "worker-1",
  attemptId: "attempt-1",
};
export interface Invocation {
  operationId: string;
  input: JsonObject;
}

/** Real persistence, admission, hooks and HTTP routes; deterministic device I/O only. */
export class HardwareBrowserService {
  readonly invocations: Invocation[] = [];
  readonly service: HardwareService;
  ssh!: HardwareItem;
  uart!: HardwareItem;
  constructor(readonly root: string) {
    const pathPolicy = new PathPolicy([root]);
    const ssh = new SshHardwareProvider({ pathPolicy });
    const uart = new UartHardwareProvider({ pathPolicy });
    const providers = [
      this.provider(
        sshHardwareDescriptor,
        (value) => ssh.parseConfig(value) as unknown as JsonObject,
      ),
      this.provider(
        uartHardwareDescriptor,
        (value) => uart.parseConfig(value) as unknown as JsonObject,
      ),
    ];
    this.service = new HardwareService({
      dataDir: root,
      pathPolicy,
      registry: {
        values: () => providers,
        get: (id) => {
          const provider = providers.find(
            (value) => value.descriptor.id === id,
          );
          if (!provider) throw new Error(`Missing provider ${id}`);
          return provider;
        },
      },
      ownerState: () => "active",
    });
  }
  private provider(
    descriptor: HardwareTypeDescriptor,
    parseConfig: (value: unknown) => JsonObject,
  ): HardwareTypeProvider<JsonObject> {
    return {
      descriptor,
      parseConfig,
      inspectEndpoint: async (config) => ({
        resourceKeys: [
          `${descriptor.id}:${String(config.host ?? config.devicePath)}:${config.port ?? ""}`,
        ],
        ready: config.host !== "offline.example",
        blockers:
          config.host === "offline.example"
            ? ["Fixture endpoint unavailable"]
            : [],
      }),
      describeAccess: () => ({
        summary: "Controlled browser-test endpoint",
        details: {},
      }),
      connect: async (_config, context) => {
        const close = async () => ({
          state: "completed" as const,
          value: null,
        });
        context.registerCleanup(close);
        return {
          state: "completed",
          value: {
            close,
            invoke: async (operationId, input) =>
              this.invoke(operationId, input),
          },
        };
      },
    };
  }
  private async invoke(
    operationId: string,
    input: JsonObject,
  ): Promise<ProviderOutcome<JsonObject>> {
    this.invocations.push({ operationId, input: structuredClone(input) });
    if (input.script === "uncertain")
      return {
        state: "unknown",
        error: { code: "FIXTURE_LOST", message: "Remote result is unknown." },
      };
    if (operationId === "ssh.exec")
      return {
        state: "completed",
        value: {
          exitCode: input.script === "exit 7" ? 7 : 0,
          stdout: "aarch64\n",
          stderr: "",
          truncated: false,
          durationMs: 2,
        },
      };
    if (operationId === "ssh.upload" || operationId === "ssh.download")
      return {
        state: "completed",
        value: {
          bytesTransferred: 8,
          destination:
            operationId === "ssh.upload" ? input.remotePath : input.localPath,
          completed: true,
        },
      };
    if (operationId === "uart.read")
      return {
        state: "completed",
        value: {
          dataBase64: Buffer.from("Boot ready\nµart").toString("base64"),
          bytesRead: Buffer.byteLength("Boot ready\nµart"),
          timedOut: true,
          truncated: false,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      };
    if (operationId === "uart.write")
      return {
        state: "completed",
        value: {
          bytesWritten: Buffer.from(String(input.dataBase64), "base64").length,
          drained: true,
        },
      };
    return {
      state: "completed",
      value: { rts: input.rts ?? false, dtr: input.dtr ?? false },
    };
  }
  async mutate(
    action: string,
    input: Record<string, unknown>,
    owner = operator,
  ): Promise<HardwareMutationResult> {
    return this.service.execute(
      action,
      { requestId: randomUUID(), ...input },
      owner,
    ) as Promise<HardwareMutationResult>;
  }
  async settled(receipt: OperationReceipt, owner = operator) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = (await this.service.execute(
        "hardware.receipt.get",
        { requestId: receipt.requestId },
        owner,
      )) as { receipt: OperationReceipt };
      if (result.receipt.state !== "running") return result.receipt;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Operation ${receipt.requestId} remained pending.`);
  }
  async addItem(patch: Partial<HardwareItemDraft>) {
    const state = await this.service.snapshot(operator);
    const { receipt } = await this.mutate("hardware.items.create", {
      item: {
        name: "Additional item",
        description: "",
        enabled: true,
        physicalResourceId: state.groups[0]!.id,
        typeId: "hardware.ssh",
        configVersion: 1,
        config: this.sshConfig("additional.example"),
        tagIds: [],
        notes: "",
        statuses: [],
        hooks: {},
        ...patch,
      },
    });
    return receipt.result!.item as unknown as HardwareItem;
  }
  sshConfig(host = "atlas.example"): JsonObject {
    return {
      host,
      port: 22,
      username: "root",
      auth: { kind: "agent", socketPath: `${this.root}/agent.sock` },
      knownHostsFile: `${this.root}/known_hosts`,
      connectTimeoutMs: 5000,
    };
  }
  async init() {
    await this.service.init();
    for (const name of ["Rack A", "Rack B"])
      await this.mutate("hardware.groups.create", { name });
    for (const label of ["ARM64", "Linux", "Serial"])
      await this.mutate("hardware.tags.create", {
        label,
        description: `${label} capability`,
      });
    for (const [label, valueType] of [
      ["Up", "boolean"],
      ["Busy", "boolean"],
      ["OS", "text"],
      ["Health", "enum"],
    ])
      await this.mutate("hardware.statuses.create", {
        label,
        valueType,
        ...(valueType === "enum" ? { enumValues: ["ready", "blocked"] } : {}),
      });
    const state = await this.service.snapshot(operator);
    this.ssh = await this.addItem({
      name: "Atlas SSH",
      description: "ARM validation node",
      config: this.sshConfig(),
      tagIds: state.tags.slice(0, 2).map((tag) => tag.id),
      notes: "Do not reboot. Run uname -m to validate.",
      statuses: state.statusDefinitions.slice(0, 2).map((definition, i) => ({
        revision: 1,
        definitionId: definition.id,
        source: "manual",
        value: i === 0,
      })),
    });
    this.uart = await this.addItem({
      name: "Orion UART",
      physicalResourceId: state.groups[1]!.id,
      typeId: "hardware.uart",
      config: {
        devicePath: `${this.root}/serial-orion`,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      },
      tagIds: [state.tags[2]!.id],
      notes: "RTS/DTR can reset this board.",
    });
  }
}
