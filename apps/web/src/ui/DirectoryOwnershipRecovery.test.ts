// @vitest-environment jsdom
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DirectoryOwnershipAvailability, DirectoryOwnershipPreview, DirectoryOwnershipReconciliation } from "@cloudx/shared";
import { DirectoryOwnershipRecovery } from "./DirectoryOwnershipRecovery.js";

interface Source extends Record<string, unknown> { sourceId: string; home: string; dev: string; ino: string }
interface Sources {
  resolve(): Promise<Source>;
  bind(tabId: string, source: Source): Promise<string>;
  readBinding(tabId: string): Promise<Source | undefined>;
  ownershipAvailability(tabId: string): Promise<DirectoryOwnershipAvailability>;
  previewOwnership(tabId: string): Promise<DirectoryOwnershipPreview>;
  reconcileOwnership(tabId: string, input: DirectoryOwnershipReconciliation): Promise<void>;
  dispose(): Promise<void>;
}

// Keep the server outside the web TypeScript project while exercising its real binding path.
const { CodexStateSources } = await vi.importActual<{ CodexStateSources: new (data: string, env: NodeJS.ProcessEnv) => Sources }>("../../../server/src/plugins/CodexStateSources.js");
vi.mock("../../../server/src/filesystemIdentity.js", () => ({
  filesystemIdentity: async (fd: number) => ({
    filesystemType: "ef53",
    filesystemId: (await fs.realpath(`/proc/self/fd/${fd}`)).startsWith("/dev/shm/") ? "bbbb" : "aaaa",
  }),
}));

const directories: string[] = [];
let root: Root | undefined;
let sources: Sources | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  await sources?.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

it("reconciles the UI's verified source mapping when its old device number is reused by the launch filesystem", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-source-home-"));
  directories.push(home);
  const data = await fs.mkdtemp("/dev/shm/cloudx-source-view-");
  directories.push(data);
  sources = new CodexStateSources(data, { CODEX_HOME: home });
  const source = await sources.resolve();
  const view = await sources.bind("saved-tab", source);
  const reusedDevice = (await fs.stat(view)).dev.toString();
  expect(source.dev).not.toBe(reusedDevice);
  const binding = path.join(view, ".cloudx-source.json");
  await fs.writeFile(binding, JSON.stringify({ version: 1, sourceId: source.sourceId, home, ino: source.ino, dev: reusedDevice }));
  const preview = await sources.previewOwnership("saved-tab");
  const reconcile = vi.fn((input: DirectoryOwnershipReconciliation) => sources!.reconcileOwnership("saved-tab", input));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const availability = vi.fn(() => sources!.ownershipAvailability("saved-tab"));
  await act(async () => root!.render(createElement(DirectoryOwnershipRecovery, { availability, preview: async () => preview, reconcile })));
  await act(async () => { await availability.mock.results[0]!.value; });

  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent === label)!;
  await act(async () => button("Inspect directory ownership").click());
  await act(async () => {
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.click();
  });
  await act(async () => {
    button("Reconcile verified ownership").click();
    await reconcile.mock.results[0]!.value;
  });

  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Directory ownership reconciled. Resume when ready.");
  expect(reconcile).toHaveBeenCalledExactlyOnceWith({
    fingerprint: preview.fingerprint,
    attestations: [{ device: reusedDevice, filesystemId: "aaaa", filesystemType: "ef53" }],
  });
  expect(preview.directories.map(directory => directory.path)).toEqual([home]);
  await expect(sources.readBinding("saved-tab")).resolves.toEqual(source);
});


it.each(["not_needed", "unavailable"] as const)("hides the entire recovery section when availability is %s", async status => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const preview = vi.fn(); const reconcile = vi.fn();
  await act(async () => root!.render(createElement(DirectoryOwnershipRecovery, {
    availability: async () => status === "not_needed" ? { status } : { status, reason: "Original directory was replaced." }, preview, reconcile,
  })));
  expect(container.children).toHaveLength(0);
  expect(preview).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});

it("removes a stale empty inspection without presenting an attestation flow", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const reconcile = vi.fn();
  await act(async () => root!.render(createElement(DirectoryOwnershipRecovery, {
    availability: async () => ({ status: "available" as const, reason: "Device changed." }),
    preview: async () => ({ fingerprint: "a".repeat(64), directories: [] }), reconcile,
  })));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("No directory ownership repair is needed");
  expect(container.querySelector("section")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
  expect(reconcile).not.toHaveBeenCalled();
});

it("refreshes applicability on focus and clears an inspection when the process becomes active", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const availability = vi.fn<() => Promise<DirectoryOwnershipAvailability>>().mockResolvedValue({ status: "available", reason: "Device changed." });
  const reconcile = vi.fn();
  await act(async () => root!.render(createElement(DirectoryOwnershipRecovery, {
    availability, preview: async () => ({ fingerprint: "a".repeat(64), directories: [{ path: "/source", device: "1", currentDevice: "2", filesystemId: "aaaa", filesystemType: "ef53" }] }), reconcile,
  })));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  availability.mockResolvedValue({ status: "unavailable", reason: "Process is active." });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.children).toHaveLength(0); expect(reconcile).not.toHaveBeenCalled();
});
