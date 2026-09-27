import assert from "node:assert/strict";
import fs from "node:fs";

// An external catalog fixture, loaded by the isolated web service only. The
// installed source's catalog, selection cache, routes and updater stay intact.
export function pinnedCatalogFetch({ source, target }, networkFetch = fetch) {
  for (const commit of [source, target]) assert.match(commit, /^[a-f0-9]{40}$/);
  return async (input, options) => {
    const url = new URL(
      typeof input === "string" ? input : (input.url ?? input.href),
    );
    if (url.hostname !== "api.github.com") return networkFetch(input, options);
    const prefix = "/repos/davidomil/cloudx";
    assert.equal(
      options?.method ?? "GET",
      "GET",
      "Catalog fixture only serves reads",
    );
    let body;
    if (url.pathname === `${prefix}/commits/main`) body = { sha: target };
    else if (url.pathname === `${prefix}/compare/${source}...${target}`)
      body = { status: "ahead", total_commits: 1, commits: [{ sha: target }] };
    else if (url.pathname === `${prefix}/pulls`) body = [];
    else throw new Error(`Unexpected GitHub catalog request: ${url.pathname}`);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

if (process.env.CLOUDX_LIFECYCLE_REVISIONS) {
  const revisions = JSON.parse(
    fs.readFileSync(process.env.CLOUDX_LIFECYCLE_REVISIONS, "utf8"),
  );
  globalThis.fetch = pinnedCatalogFetch(revisions);
}
