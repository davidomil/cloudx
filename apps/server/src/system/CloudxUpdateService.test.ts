import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudxUpdateService } from "./CloudxUpdateService.js";

describe("CloudxUpdateService", () => {
  it.each(["status", "start"] as const)("runs the source updater with bounded %s arguments", async action => {
    const status = { available: false, unavailableReason: "Open the installed CloudX service." };
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(status) }));
    const service = new CloudxUpdateService("/workspace with spaces/data", execute);
    expect(await service[action]()).toEqual(status);
    expect(execute).toHaveBeenCalledWith(process.execPath, [
      path.resolve("scripts/settings-update.mjs"), action, "/workspace with spaces/data", String(process.pid)
    ], { cwd: path.resolve("."), timeout: 30_000, maxBuffer: 65536, encoding: "utf8" });
  });

  it.each(["invalid JSON", '{"available":"yes"}'])("rejects unverifiable runner output", async stdout => {
    const service = new CloudxUpdateService("/data", async () => ({ stdout }));
    await expect(service.status()).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("could not be verified") });
  });

  it("does not disclose subprocess output or attempt a second start when launch is uncertain", async () => {
    const execute = vi.fn(async () => { throw new Error("secret from stderr"); });
    const service = new CloudxUpdateService("/data", execute);
    await expect(service.start()).rejects.toMatchObject({ statusCode: 503, message: expect.not.stringContaining("secret") });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
