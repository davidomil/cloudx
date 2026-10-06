import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import Fastify from "fastify";
import type { ForgeCheckoutEvidenceReceipt } from "@cloudx/shared";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import { ForgeCheckoutEvidence } from "./ForgeCheckoutEvidence.js";
import { registerForgeCheckoutEvidenceRoutes } from "./ForgeCheckoutEvidenceRoutes.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-checkout-evidence-"));
  onTestFinished(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "checkout");
  await fs.mkdir(path.join(source, "reports"), { recursive: true });
  await fs.writeFile(path.join(source, "reports/run.log"), "Validation passed\n");
  const identity = await readDirectoryIdentity(source);
  const archive = new ForgeCheckoutEvidence(path.join(root, "data"));
  let receipt: ForgeCheckoutEvidenceReceipt = { archiveId: randomUUID(), attemptId: "attempt-1", commitSha: "a".repeat(40), paths: ["reports"] };
  const save = async (intent: ForgeCheckoutEvidenceReceipt) => {
    receipt = intent;
    await new JsonStateFile(path.join(root, "data"), "forge-workers/workspaces/worker-1.json", "Fixture ownership").write({ worktree: identity, checkoutEvidence: receipt });
  };
  return { root, source, identity, archive, save, get receipt() { return receipt; } };
}

describe("Durable checkout evidence", () => {
  it("preserves regular evidence files named build and dist instead of treating them as directories", async () => {
    const fixtureState = await fixture();
    for (const file of ["build", "dist"])
      await fs.writeFile(path.join(fixtureState.source, "reports", file), "Handwritten evidence");
    const manifest = await fixtureState.archive.export("worker-1", fixtureState.identity, fixtureState.receipt, fixtureState.save);
    expect(manifest.files.map(file => file.path)).toEqual(["reports/build", "reports/dist", "reports/run.log"]);
    await fixtureState.archive.removeExported(fixtureState.identity, manifest);
    const chunks: Buffer[] = [];
    for await (const chunk of await fixtureState.archive.fileStream(manifest.archiveId, "reports/build")) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("Handwritten evidence");
  });

  it("blocks a generated directory on a different filesystem before any destructive cleanup", async () => {
    const fixtureState = await fixture();
    await fs.mkdir(path.join(fixtureState.source, "reports/node_modules"));
    const originalStat = fs.lstat.bind(fs);
    const crossedFilesystem = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await originalStat(...args);
      return String(args[0]).endsWith("/node_modules")
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: BigInt(stat.dev) + 1n })
        : stat;
    });
    try { await expect(fixtureState.archive.planSelection(fixtureState.identity, ["reports"])).rejects.toThrow(/filesystem boundary/); }
    finally { crossedFilesystem.mockRestore(); }
    expect(await fs.readFile(path.join(fixtureState.source, "reports/run.log"), "utf8")).toBe("Validation passed\n");
  });

  it("streams manifest-listed downloads through real HTTP routes after the disposable source is gone", async () => {
    const f = await fixture();
    const manifest = await f.archive.export("worker-1", f.identity, f.receipt, f.save);
    await f.archive.removeExported(f.identity, manifest);
    await fs.rm(f.source, { recursive: true });
    const app = Fastify(); registerForgeCheckoutEvidenceRoutes(app, path.join(f.root, "data"));
    onTestFinished(() => app.close());
    const list = await app.inject({ method: "GET", url: "/api/forge/checkout-evidence" });
    expect(list.statusCode).toBe(200); expect(list.json().archives).toEqual([manifest]);
    const file = await app.inject({ method: "GET", url: `/api/forge/checkout-evidence/${manifest.archiveId}/file?path=reports%2Frun.log` });
    expect(file.statusCode).toBe(200); expect(file.body).toBe("Validation passed\n");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "GET", url: `/api/forge/checkout-evidence/${manifest.archiveId}/file?path=..%2Foutside` })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/forge/checkout-evidence/${manifest.archiveId}/file` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/forge/checkout-evidence/${manifest.archiveId}` })).json()).toEqual(manifest);
  });

  it("verifies durable contents before release and preserves source on tampering", async () => {
    const f = await fixture(); const manifest = await f.archive.export("worker-1", f.identity, f.receipt, f.save);
    const blob = createHash("sha256").update("reports/run.log").digest("hex") + ".data";
    await fs.writeFile(path.join(f.root, "data/forge-checkout-evidence", manifest.archiveId, blob), "Broken evidence");
    await expect(f.archive.removeExported(f.identity, manifest)).rejects.toThrow(/verification failed/);
    expect(await fs.readFile(path.join(f.source, "reports/run.log"), "utf8")).toBe("Validation passed\n");
  });

  it("recovers a durable intent after interruption, protects edited source, and resumes partial source removal", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "reports/second.log"), "Second report");
    const manifest = await f.archive.export("worker-1", f.identity, f.receipt, f.save);
    await expect(f.archive.export("worker-1", f.identity, { ...f.receipt, commitSha: "b".repeat(40) }, f.save)).rejects.toThrow(/receipt/);
    expect(await f.archive.export("worker-1", f.identity, f.receipt, f.save)).toEqual(manifest);
    await fs.writeFile(path.join(f.source, "reports/run.log"), "New unpublished investigation");
    await expect(f.archive.removeExported(f.identity, manifest)).rejects.toThrow(/changed after export/);
    expect(await fs.readFile(path.join(f.source, "reports/run.log"), "utf8")).toBe("New unpublished investigation");
    await fs.writeFile(path.join(f.source, "reports/run.log"), "Validation passed\n");
    await fs.unlink(path.join(f.source, "reports/second.log"));
    await f.archive.removeExported(f.identity, manifest);
    expect(await fs.readdir(path.join(f.source, "reports"))).toEqual([]);
    expect(await f.archive.read(f.receipt.archiveId)).toEqual(manifest);
  });

  it("does not remove source when the durable intent cannot be recorded", async () => {
    const f = await fixture();
    await expect(f.archive.export("worker-1", f.identity, f.receipt, async () => { throw new Error("Receipt write interrupted"); })).rejects.toThrow("Receipt write interrupted");
    expect(await fs.readFile(path.join(f.source, "reports/run.log"), "utf8")).toBe("Validation passed\n");
    expect(await f.archive.list()).toEqual([]);
    expect(await f.archive.export("worker-1", f.identity, f.receipt, f.save)).toMatchObject({ bytes: 18 });
  });

  it.each(["selected", "nested"])("preserves a moved %s evidence directory when its name is replaced during source verification", async location => {
    const f = await fixture();
    if (location === "nested") {
      await fs.mkdir(path.join(f.source, "reports/nested"));
      await fs.rename(path.join(f.source, "reports/run.log"), path.join(f.source, "reports/nested/run.log"));
    }
    const manifest = await f.archive.export("worker-1", f.identity, f.receipt, f.save);
    const selected = path.join(f.source, location === "selected" ? "reports" : "reports/nested");
    const moved = path.join(f.root, "moved-evidence");
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (!replaced && String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/run.log")) {
        await fs.rename(selected, moved);
        await fs.mkdir(selected);
        await fs.writeFile(path.join(selected, "new-source.txt"), "Unpublished replacement");
        replaced = true;
      }
      return handle;
    });
    await expect(f.archive.removeExported(f.identity, manifest)).rejects.toThrow(/identity changed/);
    expect(replaced).toBe(true);
    expect(await fs.readFile(path.join(moved, "run.log"), "utf8")).toBe("Validation passed\n");
    expect(await fs.readFile(path.join(selected, "new-source.txt"), "utf8")).toBe("Unpublished replacement");
  });

  it.each(["oversized", "too many files", "symbolic link", "symbolic-link parent", "Git history", "dependency tree", "escaping path"])("rejects %s selections before publication can accept them", async invalid => {
    const f = await fixture();
    let paths = ["reports"];
    if (invalid === "oversized") { const h = await fs.open(path.join(f.source, "reports/huge.json"), "w"); await h.truncate(256 * 1024 * 1024 + 1); await h.close(); }
    if (invalid === "too many files") for (let i = 0; i < 512; i++) await fs.writeFile(path.join(f.source, `reports/${i}.log`), "");
    if (invalid === "symbolic link") await fs.symlink("run.log", path.join(f.source, "reports/link"));
    if (invalid === "symbolic-link parent") { await fs.symlink(path.join(f.source, "reports"), path.join(f.source, "link")); paths = ["link/run.log"]; }
    if (invalid === "Git history") for (const name of ["HEAD", "objects", "refs"]) await fs.writeFile(path.join(f.source, "reports", name), "");
    if (invalid === "dependency tree") { await fs.mkdir(path.join(f.source, "node_modules")); paths = ["node_modules"]; }
    if (invalid === "escaping path") paths = ["../outside"];
    await expect(f.archive.validateSelection(f.identity, paths)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.source, "reports/run.log"), "utf8")).toBe("Validation passed\n");
  });

  it("exports specific reports in mixed trees while leaving generated siblings outside the evidence inventory", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.source, "reports/node_modules"));
    await fs.writeFile(path.join(f.source, "reports/node_modules/reproducible.bin"), "Disposable");
    const manifest = await f.archive.export("worker-1", f.identity, f.receipt, f.save);
    expect(manifest.files.map(file => file.path)).toEqual(["reports/run.log"]);
    await f.archive.removeExported(f.identity, manifest);
    expect(await fs.readFile(path.join(f.source, "reports/node_modules/reproducible.bin"), "utf8")).toBe("Disposable");
  });
});
