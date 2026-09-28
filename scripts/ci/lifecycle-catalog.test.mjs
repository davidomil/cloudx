import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CloudxUpdateCatalog } from "../../apps/server/src/system/CloudxUpdateCatalog.ts";
import {
  pinnedCatalogResponse,
  startPinnedCatalog,
} from "./lifecycle-catalog.mjs";

const sourceSha = "1".repeat(40);
const targetSha = "2".repeat(40);
const revisions = { sourceSha, targetSha };
const repository = "/repos/davidomil/cloudx";
const comparison = `${repository}/compare/${sourceSha}...${targetSha}?per_page=100&page=1`;
let directory;
let cert;
let key;
let server;

beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-pinned-catalog-"),
  );
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=api.github.com",
      "-addext",
      "subjectAltName=DNS:api.github.com",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  [key, cert] = await Promise.all([
    fs.readFile(keyPath),
    fs.readFile(certPath),
  ]);
  server = await startPinnedCatalog({ ...revisions, key, cert, port: 0 });
});

afterAll(async () => {
  if (server)
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

function requestCatalog(url, options = {}) {
  const address = server.address();
  const parsed = new URL(url, "https://api.github.com");
  expect(parsed.origin).toBe("https://api.github.com");
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        servername: "api.github.com",
        port: address.port,
        ca: cert,
        path: parsed.pathname + parsed.search,
        method: "GET",
        agent: false,
        ...options,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers,
            }),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

it("pins the main target and forward comparison to immutable revisions", () => {
  expect(
    pinnedCatalogResponse(revisions, `${repository}/commits/main`),
  ).toEqual({
    statusCode: 200,
    body: { sha: targetSha },
  });
  expect(pinnedCatalogResponse(revisions, comparison)).toEqual({
    statusCode: 200,
    body: {
      status: "ahead",
      total_commits: 1,
      commits: [{ sha: targetSha }],
    },
  });
});

it.each([
  `${repository}/releases/latest`,
  `${repository}/commits/main?ignored=true`,
  `${repository}/compare/${sourceSha}...main?per_page=100&page=1`,
  comparison.replace("page=1", "page=2"),
  `${repository}/pulls`,
  `https://unexpected.example${repository}/commits/main`,
  "https://[malformed",
])("rejects unpinned catalog request %s", (url) => {
  expect(pinnedCatalogResponse(revisions, url).statusCode).toBe(404);
});

it.each([undefined, "main", "1".repeat(39), "G".repeat(40), "A".repeat(40)])(
  "requires full canonical source and target revisions (%s)",
  (sha) => {
    for (const name of ["sourceSha", "targetSha"])
      expect(() =>
        pinnedCatalogResponse({ ...revisions, [name]: sha }, "/"),
      ).toThrow(`${name} must be a full lowercase commit SHA`);
  },
);

it("serves the production catalog over verified TLS before and after an update", async () => {
  expect(server.address().address).toBe("127.0.0.1");
  const catalog = new CloudxUpdateCatalog(requestCatalog);
  expect(await catalog.preview("main", sourceSha)).toMatchObject({
    state: "available",
    currentCommit: sourceSha,
    target: { commit: targetSha },
    changelog: [],
    changelogComplete: true,
  });
  expect(await catalog.preview("main", targetSha)).toMatchObject({
    state: "current",
    currentCommit: targetSha,
    target: { commit: targetSha },
    changelogComplete: true,
  });
  expect(await catalog.preview("main", "3".repeat(40))).toMatchObject({
    state: "unavailable",
  });
});

it("rejects unexpected HTTP methods and paths without forwarding requests", async () => {
  const post = await requestCatalog(`${repository}/commits/main`, {
    method: "POST",
  });
  const missing = await requestCatalog("/unexpected");
  expect(post.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect(await missing.json()).toEqual({ message: "Unpinned catalog request" });
});

it("fails startup when its address is already owned", async () => {
  await expect(
    startPinnedCatalog({
      ...revisions,
      key,
      cert,
      port: server.address().port,
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
});

it("fails startup for invalid pinned revisions", async () => {
  await expect(
    startPinnedCatalog({ ...revisions, sourceSha: "main", key, cert, port: 0 }),
  ).rejects.toThrow("sourceSha must be a full lowercase commit SHA");
});
