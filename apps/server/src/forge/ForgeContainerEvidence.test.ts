import { Header, type types } from "tar";
import { describe, expect, it } from "vitest";
import { readContainerEvidenceTar, validEvidencePaths } from "./ForgeContainerEvidence.js";

function evidenceTar(entries: { path: string; data?: string; type?: types.EntryTypeName; linkpath?: string; size?: number }[]): Buffer {
  return Buffer.concat([...entries.flatMap(entry => {
    const data = Buffer.from(entry.data ?? "");
    const header = new Header({ path: entry.path, type: entry.type ?? "File", size: entry.size ?? data.length, mode: 0o600, linkpath: entry.linkpath });
    header.encode();
    return [header.block!, data, Buffer.alloc((512 - data.length % 512) % 512)];
  }), Buffer.alloc(1024)]);
}

describe("specific compact Docker evidence archive parsing", () => {
  it("reads regular reports while excluding generated siblings and repository history", async () => {
    const archive = evidenceTar([
      { path: "evidence", type: "Directory" },
      { path: "evidence/tests.log", data: "tests passed" },
      { path: "evidence/reproduction/input.json", data: "{}" },
      { path: "evidence/node_modules/generated", data: "disposable" },
      { path: "evidence/dist/build.js", data: "disposable" },
      { path: "evidence/build.tsbuildinfo", data: "disposable" },
      { path: "evidence/.git/config", data: "history" },
    ]);
    const files = await readContainerEvidenceTar("/work/evidence", archive);
    expect(files.map(item => [item.path, item.data.toString()])).toEqual([["work/evidence/tests.log", "tests passed"], ["work/evidence/reproduction/input.json", "{}"]]);
  });
  it.each(["../outside", "/outside", "evidence/../outside", "other/log", "evidence\\outside"])("rejects archive path %s without extracting it", async file => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: file, data: "private" }]))).rejects.toThrow("unsafe or unexpected path");
  });
  it.each(["SymbolicLink", "Link", "FIFO", "CharacterDevice"] as const)("rejects %s evidence entries", async type => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", type, ...(["SymbolicLink", "Link"].includes(type) ? { linkpath: "/etc/passwd" } : {}) }]))).rejects.toThrow("links, special files");
  });
  it("rejects duplicate entries and truncated or corrupted archives", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "first" }, { path: "evidence/log", data: "second" }]))).rejects.toThrow("duplicate paths");
    const archive = evidenceTar([{ path: "evidence/log", data: "normal log" }]);
    archive[0] = 0;
    await expect(readContainerEvidenceTar("/work/evidence", archive)).rejects.toThrow();
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/log", data: "missing body", size: 9999 }]))).rejects.toThrow();
  });
  it("rejects oversized evidence before buffering its entry body", async () => {
    await expect(readContainerEvidenceTar("/work/evidence", evidenceTar([{ path: "evidence/large", size: 16 * 1024 * 1024 + 1 }]))).rejects.toThrow("compact archive limit");
  });
  it("accepts concrete absolute paths and rejects overlapping or generated selections", () => {
    expect(validEvidencePaths(["/work/evidence/log", "/work/reproduction.json"])).toBe(true);
    expect(validEvidencePaths(["/work/evidence", "/work/evidence/log"])).toBe(false);
    expect(validEvidencePaths(["/work/node_modules/pkg/log"])).toBe(false);
    expect(validEvidencePaths(["/work/evidence/.git/log"])).toBe(false);
  });
});
