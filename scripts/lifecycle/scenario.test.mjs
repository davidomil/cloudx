import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { request } from "@playwright/test";
import { afterEach, expect, it } from "vitest";
import { verifyServedFrontend } from "./scenario.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function frontendFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-lifecycle-frontend-"),
  );
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dist = path.join(root, "apps/web/dist");
  await fs.mkdir(path.join(dist, "assets"), { recursive: true });
  const index =
    '<html><script type="module" src="/assets/application.js"></script></html>';
  await fs.writeFile(path.join(dist, "index.html"), index);
  await fs.writeFile(
    path.join(dist, "assets/application.js"),
    "window.candidate = true",
  );
  const responses = {
    "/": index,
    "/assets/application.js": "window.candidate = true",
  };
  const server = createServer((req, res) => res.end(responses[req.url]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const client = await request.newContext();
  cleanups.push(() => client.dispose());
  const host = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    evidence: root,
    repoRoot: root,
  };
  const page = { evaluate: async () => ["/assets/application.js"] };
  return { host, client, page, responses };
}

it("compares served frontend bytes against the installed build", async () => {
  const { host, client, page } = await frontendFixture();
  await verifyServedFrontend(host, client, page, "target");
  const evidence = JSON.parse(
    await fs.readFile(path.join(host.evidence, "target-frontend.json"), "utf8"),
  );
  expect(evidence.assets["/assets/application.js"]).toMatch(/^[0-9a-f]{64}$/);
});

it.each(["/", "/assets/application.js"])(
  "fails when an old frontend response survives at %s",
  async (resource) => {
    const { host, client, page, responses } = await frontendFixture();
    responses[resource] = "old deployment";
    await expect(
      verifyServedFrontend(host, client, page, "target"),
    ).rejects.toThrow(/Served frontend index|Wrong frontend asset/);
  },
);

it("fails when installed and served frontend both remain old after the target is prepared", async () => {
  const { host, client, page } = await frontendFixture();
  const prepared = path.join(host.repoRoot, "prepared-target");
  await fs.mkdir(path.join(prepared, "apps/web/dist/assets"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(prepared, "apps/web/dist/index.html"),
    '<html><script type="module" src="/assets/target.js"></script></html>',
  );
  await expect(
    verifyServedFrontend(host, client, page, "target", prepared),
  ).rejects.toThrow("Installed frontend differs from the prepared target");
});
