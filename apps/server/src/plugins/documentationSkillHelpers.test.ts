import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DOCUMENTATION_HELPER_FILES, DOCUMENTATION_HELPER_SCRIPT_PATH } from "./documentationSkillHelpers.js";

const execFileAsync = promisify(execFile);

describe("documentation skill helper", () => {
  const roots: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("sends current workspace cwd when path ingest uses the CloudX server hook", async () => {
    const workspace = await tempRoot();
    let requestUrl = "";
    let requestBody = "";
    const serverUrl = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify({ type: "result", result: { documents: [] } })}\n`);
      });
    });

    const result = await runHelper(["ingest-path", "docs/reference.md", "--sourceType", "datasheet"], {
      cwd: workspace,
      env: { CLOUDX_SERVER_URL: serverUrl }
    });

    expect(JSON.parse(result.stdout)).toEqual({ documents: [] });
    expect(requestUrl).toBe("/api/hooks/documentation.ingest.path?stream=1");
    expect(JSON.parse(requestBody)).toEqual({
      input: {
        path: "docs/reference.md",
        cwd: workspace,
        sourceType: "datasheet"
      }
    });
  });

  it("rejects relative path ingest when only the raw indexer URL is available", async () => {
    const workspace = await tempRoot();
    let requests = 0;
    const documentationUrl = await startServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end("unexpected request");
    });

    await expect(runHelper(["ingest-path", "docs/reference.md"], {
      cwd: workspace,
      env: { CLOUDX_DOCUMENTATION_URL: documentationUrl }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("Relative ingest paths require CLOUDX_SERVER_URL")
    });
    expect(requests).toBe(0);
  });

  it("still posts absolute path ingest directly to the raw indexer", async () => {
    const workspace = await tempRoot();
    const source = path.join(workspace, "reference.md");
    let requestUrl = "";
    let requestBody = "";
    const documentationUrl = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ documents: [] }));
      });
    });

    const result = await runHelper(["ingest-path", source], {
      cwd: workspace,
      env: { CLOUDX_DOCUMENTATION_URL: documentationUrl }
    });

    expect(JSON.parse(result.stdout)).toEqual({ documents: [] });
    expect(requestUrl).toBe("/ingest/path");
    expect(JSON.parse(requestBody)).toEqual({ path: source });
  });

  it("prints archive size totals from raw indexer stats", async () => {
    const workspace = await tempRoot();
    let requestUrl = "";
    const archiveSize = {
      logicalBytes: 4096,
      allocatedBytes: 8192,
      fileCount: 4,
      databaseBytes: 1024,
      snapshotBytes: 1536,
      artifactBytes: 512,
      indexBytes: 1024,
      runtimeEstimateBytes: 1024,
      runtimeEstimateKind: "dense-index-file"
    };
    const documentationUrl = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ activeDocumentCount: 2, activeChunkCount: 9, archiveSize }));
    });

    const result = await runHelper(["stats"], {
      cwd: workspace,
      env: { CLOUDX_DOCUMENTATION_URL: documentationUrl }
    });

    expect(requestUrl).toBe("/stats");
    expect(JSON.parse(result.stdout)).toEqual({ activeDocumentCount: 2, activeChunkCount: 9, archiveSize });
  });

  it("passes bounded list options to the raw indexer", async () => {
    const workspace = await tempRoot();
    let requestUrl = "";
    const documentationUrl = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        documents: [{ documentId: "doc-1", title: "Reset Manual", sourceType: "datasheet", state: "active", chunkCount: 9 }],
        window: { offset: 50, limit: 25, total: 125, hasMore: true }
      }));
    });

    const result = await runHelper(["list", "--states", "active,stale", "--limit", "25", "--offset", "50", "--query", "reset manual", "--collection", "board", "--sortDirection", "asc"], {
      cwd: workspace,
      env: { CLOUDX_DOCUMENTATION_URL: documentationUrl }
    });

    expect(requestUrl).toBe("/documents?states=active%2Cstale&limit=25&offset=50&query=reset+manual&collection=board&sortDirection=asc");
    expect(result.stdout).toContain("Reset Manual [datasheet]");
    expect(result.stdout).toContain("Window offset=50 limit=25 total=125 hasMore=true");
  });

  it("prints schematic search results with saved image and description paths", async () => {
    const workspace = await tempRoot();
    const requests: string[] = [];
    const documentationUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url ?? ""}`);
      if (request.method === "POST" && request.url === "/search") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          results: [{
            documentId: "doc-schematic",
            title: "Power Schematic",
            sourceType: "datasheet",
            locator: "schematic schematic-001 page 1 figure-001",
            snippet: "Schematic image artifact schematic-001 includes R1 and VCC."
          }]
        }));
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/documents/doc-schematic?")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          document: {
            artifacts: [{
              type: "schematic",
              id: "schematic-001",
              locator: "schematic schematic-001 page 1 figure-001",
              imagePath: "figures/figure-001.png",
              descriptionPath: "schematics/schematic-001/description.md",
              jsonPath: "schematics/schematic-001/analysis.json"
            }]
          }
        }));
        return;
      }
      response.writeHead(404);
      response.end("missing");
    });

    const result = await runHelper(["schematics", "R1 VCC", "--limit", "3"], {
      cwd: workspace,
      env: { CLOUDX_DOCUMENTATION_URL: documentationUrl }
    });

    expect(requests[0]).toBe("POST /search");
    expect(requests[1]).toContain("GET /documents/doc-schematic?");
    expect(result.stdout).toContain("Power Schematic [datasheet]");
    expect(result.stdout).toContain("image=figures/figure-001.png");
    expect(result.stdout).toContain("description=schematics/schematic-001/description.md");
  });

  async function runHelper(args: string[], options: { cwd: string; env: Record<string, string> }): Promise<{ stdout: string; stderr: string }> {
    const script = await writeHelperScript();
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: { ...process.env, CLOUDX_SERVER_URL: "", CLOUDX_DOCUMENTATION_URL: "", ...options.env }
    });
    return { stdout, stderr };
  }

  async function writeHelperScript(): Promise<string> {
    const root = await tempRoot();
    const file = DOCUMENTATION_HELPER_FILES.find((candidate) => candidate.path === DOCUMENTATION_HELPER_SCRIPT_PATH);
    if (!file) {
      throw new Error("Documentation helper script contribution is missing.");
    }
    const script = path.join(root, "cloudx-doc.mjs");
    await fs.writeFile(script, file.content, "utf8");
    return script;
  }

  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-helper-"));
    roots.push(root);
    return root;
  }

  async function startServer(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not bind to a TCP port.");
    }
    return `http://127.0.0.1:${address.port}`;
  }
});
