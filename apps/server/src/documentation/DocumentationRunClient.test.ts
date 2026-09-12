import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentationClient } from "./DocumentationClient.js";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
async function server(handler: (method: string, url: string, body: Record<string, unknown>, headers: http.IncomingHttpHeaders) => unknown) {
  const instance = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(handler(request.method!, request.url!, body ? JSON.parse(body) : {}, request.headers)));
  });
  servers.push(instance); await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address(); if (!address || typeof address === "string") throw new Error("Missing listener address.");
  return new DocumentationClient(`http://127.0.0.1:${address.port}/docs?token=local`);
}

describe("documentation run HTTP contracts", () => {
  it("sends opaque lease tokens and stable batch fingerprints through every durable operation", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const revision = "e".repeat(32); const output = { summary: "", spans: [], metadata: {}, warnings: [] };
    const client = await server((method, url, body) => {
      calls.push({ method, url, body });
      if (url.includes("/enrichment-runs?")) return { run: { runId: "run/1", status: "running", extractionRevision: revision, leaseToken: "aabb" } };
      if (url.includes("/lookup?")) return { batch: { status: "complete", output } };
      if (url.includes("/complete?")) return { chunkCount: 0, warnings: [] };
      if (url.includes("/media-evidence?")) return { chunks: [], artifacts: [] };
      return {};
    });
    const run = await client.beginEnrichmentRun("doc/1", { extractionRevision: revision, processorFingerprint: "a".repeat(64), ownerId: "owner-1", resume: true, force: false });
    await client.lookupEnrichmentBatch(run.runId, 2, { leaseToken: run.leaseToken, inputFingerprint: "b".repeat(64), model: "text-model" });
    await client.checkpointEnrichmentBatch(run.runId, 2, { leaseToken: run.leaseToken, inputFingerprint: "b".repeat(64), model: "text-model", output });
    await client.heartbeatEnrichmentRun(run.runId, run.leaseToken);
    await client.retainMediaEvidence("doc/1", { runId: run.runId, leaseToken: run.leaseToken, extractionRevision: revision, transcript: { text: "speech", locator: "00:01" } });
    await client.completeEnrichmentRun(run.runId, { leaseToken: run.leaseToken, batchCount: 3, skillIds: [], evidence: { chunkCount: 1, artifactCount: 0, keyframeCount: 0, mediaTranscriptChars: 6 } });
    await client.recordEnrichmentRunOutcome(run.runId, { leaseToken: run.leaseToken, status: "failed", code: "unavailable", error: "model unavailable" });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /docs/documents/doc%2F1/enrichment-runs?token=local", "POST /docs/enrichment-runs/run%2F1/batches/2/lookup?token=local", "PUT /docs/enrichment-runs/run%2F1/batches/2?token=local", "POST /docs/enrichment-runs/run%2F1/heartbeat?token=local", "POST /docs/documents/doc%2F1/media-evidence?token=local", "POST /docs/enrichment-runs/run%2F1/complete?token=local", "POST /docs/enrichment-runs/run%2F1/outcome?token=local"
    ]);
    expect(calls.slice(1).every(({ body }) => body.leaseToken === "aabb")).toBe(true);
    expect(calls[0]!.body).toMatchObject({ resume: true, force: false, ownerId: "owner-1" });
  });

  it.each([{}, { batch: { status: "complete", output: {} } }, { batch: { status: "complete", output: { summary: "", spans: [{ text: "fact", locator: "ai:test", kind: "content", supportAnchors: [] }], metadata: {}, warnings: [] } } }])("rejects malformed cached output: %j", async (response) => {
    const client = await server(() => response);
    await expect(client.lookupEnrichmentBatch("run", 0, { leaseToken: "aa", inputFingerprint: "b".repeat(64), model: "model" })).rejects.toThrow("Invalid documentation enrichment batch");
  });

  it("rejects a cached span whose kind is an array", async () => {
    const client = await server(() => ({ batch: { status: "complete", output: { summary: "", metadata: {}, warnings: [], spans: [{ locator: "ai:bad", text: "Unsupported content", kind: ["content"], supportAnchors: [] }] } } }));
    await expect(client.lookupEnrichmentBatch("run", 0, { leaseToken: "aa", inputFingerprint: "b".repeat(64), model: "model" })).rejects.toThrow("Invalid documentation enrichment batch");
  });

  it("encodes exact source locators independently, including commas and punctuation", async () => {
    let url = ""; const client = await server((_method, requested) => { url = requested; return {}; });
    await client.getDocument({ documentId: "doc", chunkLocators: ["page 1, figure 2", "sheet A&B"], chunkLimit: 10 });
    expect(new URL(url, "http://local").searchParams.getAll("chunkLocators")).toEqual(["page 1, figure 2", "sheet A&B"]);
    expect(() => client.getDocument({ documentId: "doc", chunkLocators: ["p1"], chunkIds: [1] })).toThrow("cannot be combined");
    expect(() => client.getDocument({ documentId: "doc", chunkLocators: Array(101).fill("p1") })).toThrow("1 to 100");
  });

  it("sends bounded source campaign requests and rejects ambiguous selection", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const client = await server((method, url, body) => { calls.push([method, url, body]); return {}; });
    await client.startReanalysisCampaign(["doc-1", "doc-2"]);
    await client.getReanalysisCampaign("campaign/1", { offset: 100, limit: 200 });
    await client.resumeReanalysisCampaign("campaign/1");
    await client.cancelReanalysisCampaign("campaign/1");
    expect(calls).toEqual([
      ["POST", "/docs/reanalysis-campaigns?token=local", { documentIds: ["doc-1", "doc-2"] }],
      ["GET", "/docs/reanalysis-campaigns/campaign%2F1?token=local&offset=100&limit=200", {}],
      ["POST", "/docs/reanalysis-campaigns/campaign%2F1/resume?token=local", {}],
      ["POST", "/docs/reanalysis-campaigns/campaign%2F1/cancel?token=local", {}]
    ]);
    expect(() => client.startReanalysisCampaign(["doc-1", "doc-1"])).toThrow("distinct document IDs");
    expect(() => client.startReanalysisCampaign([])).toThrow("distinct document IDs");
    expect(() => client.getReanalysisCampaign("campaign", { limit: 201 })).toThrow("between 1 and 200");
  });

  it("selects source evidence separately from previously generated media", async () => {
    let url = "";
    const client = await server((_method, requested) => { url = requested; return {}; });
    await client.getDocument({ documentId: "doc", chunkOrigins: ["source"], artifactOrigins: ["source"] });
    const params = new URL(url, "http://local").searchParams;
    expect(params.getAll("chunkOrigins")).toEqual(["source"]);
    expect(params.getAll("artifactOrigins")).toEqual(["source"]);
    expect(() => client.getDocument({ documentId: "doc", chunkIds: [1], chunkOrigins: ["source"] })).toThrow("cannot be combined");
    expect(() => client.getDocument({ documentId: "doc", artifactOrigins: ["ai"] })).toThrow("source or media");
    expect(() => client.getDocument({ documentId: "doc", artifactOrigins: [] })).toThrow("source or media");
  });

  it("sends media lease credentials only in the authorization header", async () => {
    let request: { url: string; authorization?: string } | undefined;
    const client = await server((_method, url, _body, headers) => {
      request = { url, authorization: headers.authorization };
      return { complete: false, metadata: null, chunks: [], artifacts: [], window: { offset: 0, limit: 100, total: 0, hasMore: false } };
    });
    const token = "d".repeat(64);
    await client.getEnrichmentMedia("run", token);
    expect(request?.authorization).toBe(`Bearer ${token}`);
    expect(request?.url).not.toContain(token);
    expect(request?.url).not.toContain("leaseToken");
  });

  it("requires completed media metadata while permitting its explicit absence during retention", async () => {
    const client = await server((_method, url) => ({ complete: false, metadata: null, chunks: [], artifacts: [], window: { offset: 0, limit: 100, total: 0, hasMore: false } }));
    expect(await client.getEnrichmentMedia("run", "a".repeat(64))).toMatchObject({ complete: false, metadata: null });
    const invalid = await server(() => ({ complete: true, metadata: null, chunks: [], artifacts: [], window: { offset: 0, limit: 100, total: 0, hasMore: false } }));
    await expect(invalid.getEnrichmentMedia("run", "a".repeat(64))).rejects.toThrow("Invalid retained enrichment media page");
  });

  it("uses explicit revision, source-family and irreversible purge endpoints", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = []; const client = await server((method, url, body) => { calls.push([method, url, body]); return { ok: true }; });
    await client.listDocumentRevisions("doc/1"); await client.checkDocumentRevision("doc/1"); await client.refreshDocument("doc/1"); await client.assignDocumentSource("doc/1", "source:guide"); await client.purgeDocument("doc/1", "Replaced obsolete source");
    expect(calls).toEqual([
      ["GET", "/docs/documents/doc%2F1/revisions?token=local", {}], ["POST", "/docs/documents/doc%2F1/check-revision?token=local", {}], ["POST", "/docs/documents/doc%2F1/refresh?token=local", {}], ["PUT", "/docs/documents/doc%2F1/source?token=local", { sourceKey: "source:guide" }], ["POST", "/docs/documents/doc%2F1/purge?token=local", { reason: "Replaced obsolete source" }]
    ]);
    expect(() => client.purgeDocument("doc", " ")).toThrow("reason");
  });
});
