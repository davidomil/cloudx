import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentationClient } from "./DocumentationClient.js";

describe("DocumentationClient", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("posts search requests to a base path with JSON", async () => {
    let requestUrl = "";
    let requestBody = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ results: [{ title: "Reset datasheet" }] }));
      });
    });
    const client = new DocumentationClient(`${url}/docs/?token=local`);

    const result = await client.search({ query: "reset" });

    expect(result).toEqual({ results: [{ title: "Reset datasheet" }] });
    expect(requestUrl).toBe("/docs/search?token=local");
    expect(JSON.parse(requestBody)).toEqual({ query: "reset" });
  });

  it("forwards bounded document list parameters with base URL query strings", async () => {
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ documents: [] }));
    });
    const client = new DocumentationClient(`${url}/docs/?token=local`);

    await client.listDocuments({
      states: ["active", "stale"],
      limit: 25,
      offset: 50,
      query: "reset manual",
      collection: "board",
      sortDirection: "asc"
    });

    expect(requestUrl).toBe("/docs/documents?token=local&states=active%2Cstale&limit=25&offset=50&query=reset+manual&collection=board&sortDirection=asc");
  });

  it("forwards document detail window parameters", async () => {
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ document: { documentId: "doc-1", chunks: [] } }));
    });
    const client = new DocumentationClient(`${url}/docs/?token=local`);

    await client.getDocument({
      documentId: "doc-1",
      chunkOffset: 75,
      chunkLimit: 25,
      chunkTextMaxChars: 4000,
      artifactOffset: 100,
      artifactLimit: 50,
      includeEnrichments: false,
      includeEvents: false
    });

    expect(requestUrl).toBe("/docs/documents/doc-1?token=local&chunkOffset=75&chunkLimit=25&chunkTextMaxChars=4000&artifactOffset=100&artifactLimit=50&includeEnrichments=false&includeEvents=false");
  });

  it("forwards selected document chunk ids with context", async () => {
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ document: { documentId: "doc-1", chunks: [] } }));
    });
    const client = new DocumentationClient(`${url}/docs/?token=local`);

    await client.getDocument({
      documentId: "doc-1",
      chunkIds: [101, 102],
      chunkContext: 1,
      chunkTextMaxChars: 4000,
      artifactLimit: 0
    });

    expect(requestUrl).toBe("/docs/documents/doc-1?token=local&chunkIds=101%2C102&chunkContext=1&chunkTextMaxChars=4000&artifactLimit=0");
  });

  it("fetches document artifact bytes", async () => {
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="figure-001.png"'
      });
      response.end(Buffer.from([1, 2, 3]));
    });
    const client = new DocumentationClient(`${url}/docs`);

    const artifact = await client.getArtifact({ documentId: "doc-1", path: "figures/figure-001.png" });

    expect(requestUrl).toBe("/docs/documents/doc-1/artifact?path=figures%2Ffigure-001.png");
    expect(artifact.contentType).toBe("image/png");
    expect(artifact.filename).toBe("figure-001.png");
    expect(Array.from(artifact.content)).toEqual([1, 2, 3]);
  });

  it("streams document artifact bytes with range request headers", async () => {
    let requestUrl = "";
    let rangeHeader = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      rangeHeader = String(request.headers.range ?? "");
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": "bytes 0-2/12",
        "accept-ranges": "bytes"
      });
      response.end(Buffer.from([1, 2, 3]));
    });
    const client = new DocumentationClient(`${url}/docs`);

    const artifact = await client.streamArtifact({ documentId: "doc-1", path: "media/source.mp4" }, { range: "bytes=0-2" });

    expect(requestUrl).toBe("/docs/documents/doc-1/artifact?path=media%2Fsource.mp4");
    expect(rangeHeader).toBe("bytes=0-2");
    expect(artifact.statusCode).toBe(206);
    expect(artifact.headers.get("content-range")).toBe("bytes 0-2/12");
    expect(Array.from(new Uint8Array(await new Response(artifact.body).arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("streams archive export bytes", async () => {
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="cloudx-documentation-test.zip"'
      });
      response.end(Buffer.from([4, 5, 6]));
    });
    const client = new DocumentationClient(`${url}/docs`);

    const exported = await client.streamArchiveExport();

    expect(requestUrl).toBe("/docs/archive/export");
    expect(exported.statusCode).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/zip");
    expect(Array.from(new Uint8Array(await new Response(exported.body).arrayBuffer()))).toEqual([4, 5, 6]);
  });

  it("forwards archive import path requests", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const url = await startServer((request, response) => {
      let requestBody = "";
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body: JSON.parse(requestBody) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ import: { mode: "ok" } }));
      });
    });
    const client = new DocumentationClient(`${url}/docs`);

    await client.importArchiveReplacePath({ path: "/tmp/archive.zip", confirmation: "REPLACE_DOCUMENTATION_ARCHIVE" });
    await client.importArchiveMergePath({ path: "/tmp/archive.zip" });

    expect(requests).toEqual([
      { url: "/docs/archive/import/replace/path", body: { path: "/tmp/archive.zip", confirmation: "REPLACE_DOCUMENTATION_ARCHIVE" } },
      { url: "/docs/archive/import/merge/path", body: { path: "/tmp/archive.zip" } }
    ]);
  });

  it("uploads archive import packages as multipart form data", async () => {
    let requestUrl = "";
    let contentType = "";
    let requestBody = Buffer.alloc(0);
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      contentType = String(request.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ import: { mode: "replace" } }));
      });
    });
    const client = new DocumentationClient(`${url}/docs`);

    const result = await client.importArchiveReplaceUpload({
      filename: "archive.zip",
      content: new Uint8Array([7, 8, 9]),
      contentType: "application/zip",
      confirmation: "REPLACE_DOCUMENTATION_ARCHIVE"
    });

    expect(result).toEqual({ import: { mode: "replace" } });
    expect(requestUrl).toBe("/docs/archive/import/replace");
    expect(contentType).toContain("multipart/form-data");
    const bodyText = requestBody.toString("latin1");
    expect(bodyText).toContain('filename="archive.zip"');
    expect(bodyText).toContain('name="confirmation"');
    expect(bodyText).toContain("REPLACE_DOCUMENTATION_ARCHIVE");
  });

  it("returns service error details", async () => {
    const url = await startServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Search query is required." }));
    });
    const client = new DocumentationClient(url);

    await expect(client.search({ query: "" })).rejects.toThrow("Search query is required.");
  });

  it("posts AI enrichment spans to the document enrich endpoint", async () => {
    let requestUrl = "";
    let requestBody = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ document: { documentId: "doc-1" } }));
      });
    });
    const client = new DocumentationClient(`${url}/docs`);

    const result = await client.enrichDocument({
      documentId: "doc-1",
      spans: [{ locator: "ai:metadata", text: "Metadata summary." }],
      model: "gpt-test",
      skillIds: ["documentation-enrich-metadata"],
      summary: "Added metadata.",
      payload: { source: "test" }
    });

    expect(result).toEqual({ document: { documentId: "doc-1" } });
    expect(requestUrl).toBe("/docs/documents/doc-1/enrich");
    expect(JSON.parse(requestBody)).toEqual({
      spans: [{ locator: "ai:metadata", text: "Metadata summary." }],
      model: "gpt-test",
      skillIds: ["documentation-enrich-metadata"],
      summary: "Added metadata.",
      payload: { source: "test" }
    });
  });

  it("uploads files to the indexer as multipart form data", async () => {
    let requestUrl = "";
    let contentType = "";
    let requestBody = Buffer.alloc(0);
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      contentType = String(request.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on("end", () => {
        requestBody = Buffer.concat(chunks);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ document: { documentId: "uploaded-doc" } }));
      });
    });
    const client = new DocumentationClient(`${url}/docs`);

    const result = await client.ingestUpload({
      filename: "note.md",
      content: new TextEncoder().encode("UPLOAD-CLIENT-7"),
      contentType: "text/markdown",
      sourceType: "readme",
      collection: "client-test",
      acceptGeneratedCodeDocumentation: true,
      retainRawCodeArtifacts: false
    });

    expect(result).toEqual({ document: { documentId: "uploaded-doc" } });
    expect(requestUrl).toBe("/docs/ingest/upload");
    expect(contentType).toContain("multipart/form-data");
    const bodyText = requestBody.toString("utf8");
    expect(bodyText).toContain('filename="note.md"');
    expect(bodyText).toContain("UPLOAD-CLIENT-7");
    expect(bodyText).toContain('name="sourceType"');
    expect(bodyText).toContain("readme");
    expect(bodyText).toContain('name="collection"');
    expect(bodyText).toContain("client-test");
    expect(bodyText).toContain('name="acceptGeneratedCodeDocumentation"');
    expect(bodyText).toContain("true");
    expect(bodyText).toContain('name="retainRawCodeArtifacts"');
    expect(bodyText).toContain("false");
  });

  it("streams ingest URL progress and returns the final result", async () => {
    const progress: unknown[] = [];
    let requestUrl = "";
    const url = await startServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(JSON.stringify({ type: "progress", stage: "Transcribing video.", progress: 42, etaSeconds: 120, metrics: { transcribedSeconds: 60 }, channel: "transcript", channelLabel: "Transcript", channelProgress: 50 }) + "\n");
      response.end(JSON.stringify({ type: "result", result: { document: { documentId: "video-doc" } } }) + "\n");
    });
    const client = new DocumentationClient(`${url}/docs`);

    const result = await client.ingestUrl({ url: "https://youtube.example/watch?v=slides" }, { onProgress: (event) => progress.push(event) });

    expect(requestUrl).toBe("/docs/ingest/url?stream=1");
    expect(progress).toEqual([{ stage: "Transcribing video.", progress: 42, etaSeconds: 120, metrics: { transcribedSeconds: 60 }, channel: "transcript", channelLabel: "Transcript", channelProgress: 50 }]);
    expect(result).toEqual({ document: { documentId: "video-doc" } });
  });

  it("keeps streaming ingest URL requests alive while progress arrives", async () => {
    const progress: unknown[] = [];
    const url = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(JSON.stringify({ type: "progress", stage: "Transcribing video.", progress: 35 }) + "\n");
      setTimeout(() => {
        response.write(JSON.stringify({ type: "progress", stage: "Scanning video.", progress: 60 }) + "\n");
      }, 20);
      setTimeout(() => {
        response.end(JSON.stringify({ type: "result", result: { document: { documentId: "long-video-doc" } } }) + "\n");
      }, 40);
    });
    const client = new DocumentationClient(`${url}/docs`, { timeoutMs: 30 });

    const result = await client.ingestUrl({ url: "https://youtube.example/watch?v=long-slides" }, { onProgress: (event) => progress.push(event) });

    expect(progress).toEqual([
      { stage: "Transcribing video.", progress: 35, etaSeconds: undefined, metrics: undefined },
      { stage: "Scanning video.", progress: 60, etaSeconds: undefined, metrics: undefined }
    ]);
    expect(result).toEqual({ document: { documentId: "long-video-doc" } });
  });

  it("rejects oversized documentation service responses with the configured response limit", async () => {
    const url = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ body: "0123456789" }));
    });
    const client = new DocumentationClient(url, { responseMaxBytes: 8 });

    await expect(client.stats()).rejects.toThrow("Documentation service response exceeded 8 bytes.");
  });

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
