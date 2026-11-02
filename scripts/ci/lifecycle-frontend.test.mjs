import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { frontendEvidence } from "./lifecycle.mjs";

const fixtures = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { root, server } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function frontend(serve) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-frontend-evidence-"),
  );
  const directory = path.join(root, "apps/web/dist");
  await fs.mkdir(path.join(directory, "assets"), { recursive: true });
  const html = '<script type="module" src="/assets/main.js"></script>';
  const asset = Buffer.alloc(2 * 1024 * 1024 + 17, "a");
  asset[0] = 1;
  asset[asset.length - 1] = 2;
  await fs.writeFile(path.join(directory, "index.html"), html);
  await fs.writeFile(path.join(directory, "assets/main.js"), asset);
  const server = createServer((request, response) => {
    if (serve?.(request, response, { html, asset })) return;
    response.end(request.url === "/" ? html : asset);
  });
  fixtures.push({ root, server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { root, asset, origin: `http://127.0.0.1:${server.address().port}` };
}

it("hashes every served frontend byte beyond the sync subprocess output limit", async () => {
  const { root, origin, asset } = await frontend();
  const evidence = await frontendEvidence(root, origin);
  const sha256 = createHash("sha256").update(asset).digest("hex");
  expect(evidence).toEqual([
    {
      path: "/index.html",
      diskSha256: expect.any(String),
      servedSha256: expect.any(String),
    },
    { path: "/assets/main.js", diskSha256: sha256, servedSha256: sha256 },
  ]);
  expect(evidence[0].diskSha256).toBe(evidence[0].servedSha256);
});

it("retains evidence when the served bytes differ from the installed frontend", async () => {
  const { root, origin } = await frontend((request, response) => {
    if (request.url !== "/assets/main.js") return false;
    response.end("stale frontend");
    return true;
  });
  const evidence = await frontendEvidence(root, origin);
  expect(evidence[1].servedSha256).not.toBe(evidence[1].diskSha256);
});

it("fails if the server cannot serve an installed asset", async () => {
  const { root, origin } = await frontend((request, response) => {
    if (request.url !== "/assets/main.js") return false;
    response.writeHead(503).end("service unavailable");
    return true;
  });
  await expect(frontendEvidence(root, origin)).rejects.toThrow(
    "Frontend request failed",
  );
});

it("fails when the download executable cannot start", async () => {
  const { root, origin } = await frontend();
  vi.stubEnv("PATH", root);
  await expect(frontendEvidence(root, origin)).rejects.toThrow(
    "spawn curl ENOENT",
  );
});

it.each(["html", "asset"])(
  "bounds a streamed %s response and terminates the download",
  async (kind) => {
    const { root, origin } = await frontend((request, response) => {
      if (kind === "asset" && request.url === "/") return false;
      const chunk = Buffer.alloc(1024 * 1024, "x");
      const write = () => {
        while (!response.destroyed) if (!response.write(chunk)) return;
      };
      response.on("drain", write);
      write();
      return true;
    });
    await expect(frontendEvidence(root, origin)).rejects.toThrow(
      "Served frontend exceeds",
    );
  },
);
