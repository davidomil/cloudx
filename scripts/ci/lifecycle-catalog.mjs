import fs from "node:fs/promises";
import https from "node:https";
import { pathToFileURL } from "node:url";

const repository = "https://api.github.com/repos/davidomil/cloudx";
const notFound = {
  statusCode: 404,
  body: { message: "Unpinned catalog request" },
};

function validateRevisions({ sourceSha, targetSha }) {
  for (const [name, sha] of Object.entries({ sourceSha, targetSha })) {
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
      throw new Error(`${name} must be a full lowercase commit SHA`);
  }
}

export function pinnedCatalogResponse(revisions, requestUrl) {
  validateRevisions(revisions);
  const { sourceSha, targetSha } = revisions;
  let url;
  try {
    url = new URL(requestUrl, "https://api.github.com").href;
  } catch {
    return notFound;
  }
  if (url === `${repository}/commits/main`)
    return { statusCode: 200, body: { sha: targetSha } };
  if (
    url ===
    `${repository}/compare/${sourceSha}...${targetSha}?per_page=100&page=1`
  )
    return {
      statusCode: 200,
      body: {
        status: "ahead",
        total_commits: 1,
        commits: [{ sha: targetSha }],
      },
    };
  if (
    url ===
    `${repository}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1`
  )
    return { statusCode: 200, body: [] };
  return notFound;
}

export async function startPinnedCatalog({
  key,
  cert,
  sourceSha,
  targetSha,
  port = 443,
}) {
  const revisions = { sourceSha, targetSha };
  validateRevisions(revisions);
  const server = https.createServer({ key, cert }, (request, response) => {
    const result =
      request.method === "GET"
        ? pinnedCatalogResponse(revisions, request.url)
        : notFound;
    const body = JSON.stringify(result.body);
    console.log(
      JSON.stringify({
        event: "catalog-request",
        method: request.method,
        path: request.url,
        statusCode: result.statusCode,
      }),
    );
    response.writeHead(result.statusCode, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [keyPath, certPath, sourceSha, targetSha, ...extra] =
    process.argv.slice(2);
  if (!keyPath || !certPath || !sourceSha || !targetSha || extra.length)
    throw new Error(
      "Usage: lifecycle-catalog.mjs KEY CERT SOURCE_SHA TARGET_SHA",
    );
  const [key, cert] = await Promise.all([
    fs.readFile(keyPath),
    fs.readFile(certPath),
  ]);
  const server = await startPinnedCatalog({ key, cert, sourceSha, targetSha });
  console.log(
    JSON.stringify({
      event: "catalog-ready",
      sourceSha,
      targetSha,
      ...server.address(),
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
