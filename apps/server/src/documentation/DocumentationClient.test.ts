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

  it("returns service error details", async () => {
    const url = await startServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Search query is required." }));
    });
    const client = new DocumentationClient(url);

    await expect(client.search({ query: "" })).rejects.toThrow("Search query is required.");
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
      collection: "client-test"
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
