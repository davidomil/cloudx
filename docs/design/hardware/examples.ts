// Compile-only design examples. No hardware is accessed by this file.
import type {
  CapabilityTag, HardwareFilter, HardwareItem, HardwareReservation,
  PhysicalResource, ReserveHardware, SshConfig, StatusDefinition, UartConfig
} from "./contracts.js";

export const tags = [
  { id: "tag-arm64", revision: 1, label: "arm64", description: "64-bit ARM" },
  { id: "tag-deploy", revision: 1, label: "deploy", description: "Deployment target" },
  { id: "tag-uart", revision: 1, label: "uart", description: "Serial console" }
] satisfies CapabilityTag[];

export const physicalResource = {
  id: "lab-server-01", revision: 1, name: "ARM64 validation server"
} satisfies PhysicalResource;

export const statusDefinitions = [
  { id: "status-up", revision: 1, label: "Up", valueType: "boolean" },
  { id: "status-free", revision: 1, label: "Free to use", valueType: "boolean" }
] satisfies StatusDefinition[];

export const sshConfig = {
  host: "10.0.0.24", port: 22, username: "lab",
  auth: { kind: "agent" },
  connectTimeoutMs: 5000
} satisfies SshConfig;

export const uartConfig = {
  devicePath: "/dev/serial/by-id/usb-Lab_console_01",
  baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none"
} satisfies UartConfig;

export const sshItem = {
  id: "web-01", revision: 7, name: "web-01", description: "ARM64 validation server",
  enabled: true, physicalResourceId: physicalResource.id,
  typeId: "hardware.ssh", configVersion: 1, config: sshConfig,
  tagIds: ["tag-arm64", "tag-deploy"],
  notes: "Username: lab. Use /srv/validation. Do not reboot this machine.",
  notesRevision: 3,
  statuses: [{
    revision: 1, definitionId: "status-free", source: "manual", value: true,
    requiredForReserve: { equals: true }
  }],
  hooks: {}
} satisfies HardwareItem;

// This is another access path to the same machine, so it shares the group.
export const uartItem = {
  ...sshItem, id: "console-01", name: "console-01", revision: 1,
  description: "UART console for web-01", typeId: "hardware.uart", config: uartConfig,
  tagIds: ["tag-arm64", "tag-uart"], notesRevision: 1,
  notes: "Console login: lab. Do not reboot. Opening this adapter may change DTR."
} satisfies HardwareItem;

export const filter = {
  typeIds: ["hardware.ssh"],
  tags: { all: ["tag-arm64", "tag-deploy"], none: ["tag-uart"] },
  statuses: [{ definitionId: "status-free", equals: true, requireFresh: true }],
  availability: "available", limit: 50
} satisfies HardwareFilter;

export const acquisition = {
  requestId: "b1664ee2-b5c7-4c05-92d8-f567c185a9f2",
  hardwareId: sshItem.id, expectedItemRevision: 7, purpose: "Deployment validation"
} satisfies ReserveHardware;

export const reservation = {
  reservationId: "reservation-103", generation: 7, revision: 1, hardwareId: sshItem.id,
  owner: {
    kind: "agent", tabId: "tab-kernel-fix", providerId: "codex",
    executionId: "execution-12"
  },
  state: "active", resourceKeys: [
    "physical:lab-server-01", 'ssh:["10.0.0.24",22]',
    'uart-path:["local","/dev/serial/by-id/usb-Lab_console_01"]'
  ],
  purpose: acquisition.purpose, acquiredItemRevision: 7, acquiredNotesRevision: 3,
  acquiredAt: "2026-11-03T10:32:00Z", updatedAt: "2026-11-03T10:32:00Z",
  lastOwnerObservation: "active", lastOwnerObservedAt: "2026-11-03T10:32:05Z",
  activeOperationIds: []
} satisfies HardwareReservation;
