import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentationClient } from "../documentation/DocumentationClient.js";
import { PathPolicy } from "../pathPolicy.js";
import { DocumentationPlugin } from "./DocumentationPlugin.js";

describe("DocumentationPlugin", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("exposes documentation hooks with conservative safety labels", () => {
    const plugin = new DocumentationPlugin(fakeClient(), new PathPolicy(["/tmp"]));

    expect(plugin.descriptor()).toMatchObject({
      id: "documentation",
      displayName: "Documentation",
      creatable: true
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.search")).toMatchObject({
      exposures: ["plugin", "ui", "http", "automation", "voice"],
      automationSafety: "read"
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.ingest.url")).toMatchObject({
      exposures: ["ui", "http", "automation"],
      automationSafety: "external"
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.invalidate")).toMatchObject({
      automationSafety: "write"
    });
  });

  it("resolves ingest paths through the CloudX path policy before calling the service", async () => {
    const root = await tempRoot();
    const allowedFile = path.join(root, "datasheet.pdf");
    await fs.writeFile(allowedFile, "data");
    const client = fakeClient();
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]));
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.path")!;

    await hook.execute({ path: allowedFile, sourceType: "datasheet" }, { caller: { kind: "http" } });

    expect(client.ingestPath).toHaveBeenCalledWith({ path: allowedFile, sourceType: "datasheet" });
    await expect(hook.execute({ path: "/etc/passwd" }, { caller: { kind: "http" } })).rejects.toThrow("Path is outside configured Cloudx roots");
  });

  it("declares default documentation skills as plugin system contributions", () => {
    const plugin = new DocumentationPlugin(fakeClient(), new PathPolicy(["/tmp"]));

    expect(plugin.hooks.some((hook) => hook.id === "documentation.skills.installDefaults")).toBe(false);
    expect(plugin.ruleContributions.map((rule) => rule.id)).toEqual([
      "documentation-ingest-evidence"
    ]);
    expect(plugin.ruleContributions[0]?.text).toContain("add it to the CloudX documentation knowledge base");
    expect(plugin.skillContributions.map((skill) => skill.id)).toEqual([
      "documentation-search",
      "documentation-ingest",
      "documentation-invalidate",
      "documentation-archive-control"
    ]);
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("CLOUDX_DOCUMENTATION_URL");
  });

  function fakeClient(): DocumentationClient {
    return {
      health: vi.fn(async () => ({ status: "ok" })),
      stats: vi.fn(async () => ({ activeDocumentCount: 1 })),
      portableManifest: vi.fn(async () => ({ files: [] })),
      listDocuments: vi.fn(async () => ({ documents: [] })),
      getDocument: vi.fn(async () => ({ document: { documentId: "doc" } })),
      remove: vi.fn(async () => ({ document: { documentId: "doc", state: "deleted" } })),
      search: vi.fn(async () => ({ results: [] })),
      ingestPath: vi.fn(async () => ({ documents: [] })),
      ingestUrl: vi.fn(async () => ({ document: { documentId: "doc" } })),
      ingestText: vi.fn(async () => ({ document: { documentId: "doc" } })),
      invalidate: vi.fn(async () => ({ document: { documentId: "doc", state: "stale" } })),
      rebuildIndex: vi.fn(async () => ({ manifest: {} }))
    } as unknown as DocumentationClient;
  }

  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-plugin-"));
    roots.push(root);
    return root;
  }
});
