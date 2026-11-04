import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isOnlyIndexStatRefresh, isSnapshotIndexBaseline, snapshotIndexSemantics, type SnapshotIndexBaseline } from "./ForgeDiagnosticSnapshotIndex.js";

function indexFixture(version: number, objectHash: "sha1" | "sha256") {
  const hashBytes = objectHash === "sha1" ? 20 : 32;
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(1, 8);
  const metadata = Buffer.alloc(42 + hashBytes + (version === 3 ? 2 : 0));
  metadata.fill(1, 0, 24);
  metadata.writeUInt32BE(0o100644, 24);
  metadata.fill(2, 28, 40);
  metadata.fill(3, 40, 40 + hashBytes);
  metadata.writeUInt16BE(version === 3 ? 0x4004 : 4, 40 + hashBytes);
  const name = Buffer.from(version === 4 ? "\0file\0" : "file\0");
  const entry = Buffer.concat([metadata, name, Buffer.alloc(version === 4 ? 0 : (8 - (metadata.length + name.length) % 8) % 8)]);
  const extension = Buffer.concat([Buffer.from("TREE"), Buffer.from([0, 0, 0, 4]), Buffer.from("data")]);
  const content = Buffer.concat([header, entry, extension]);
  const seal = (bytes: Buffer) => Buffer.concat([bytes, createHash(objectHash).update(bytes).digest()]);
  const change = (offset: number, value: number) => { const altered = Buffer.from(content); altered[offset] = value; return seal(altered); };
  return { index: seal(content), content, seal, change, hashBytes };
}

describe("Diagnostic index stat-cache proof", () => {
  it.each([2, 3, 4].flatMap(version => ["sha1", "sha256"].map(objectHash => ({ version, objectHash: objectHash as "sha1" | "sha256" }))))(
    "allows only stat fields in version $version / $objectHash", ({ version, objectHash }) => {
      const { index, change, hashBytes, content } = indexFixture(version, objectHash);
      const baseline = snapshotIndexSemantics(index, objectHash);
      for (const statByte of [...Array.from({ length: 24 }, (_, offset) => offset), ...Array.from({ length: 12 }, (_, offset) => offset + 28)])
        expect(snapshotIndexSemantics(change(12 + statByte, 5), objectHash)).toBe(baseline);
      for (const meaningfulByte of [12 + 24, 12 + 40, 12 + 40 + hashBytes, 12 + 41 + hashBytes, content.length - 1])
        expect(snapshotIndexSemantics(change(meaningfulByte, 7), objectHash)).not.toBe(baseline);
      if (version === 3) expect(snapshotIndexSemantics(change(12 + 42 + hashBytes, 0x60), objectHash)).not.toBe(baseline);
    });

  it("retains pathname bytes and rejects a changed conflict stage", () => {
    const { index, content, seal, hashBytes } = indexFixture(2, "sha1");
    const renamed = Buffer.from(content);
    renamed[12 + 42 + hashBytes] = "n".charCodeAt(0);
    expect(snapshotIndexSemantics(seal(renamed), "sha1")).not.toBe(snapshotIndexSemantics(index, "sha1"));
    const conflict = Buffer.from(content);
    conflict.writeUInt16BE(0x3004, 12 + 40 + hashBytes);
    expect(snapshotIndexSemantics(seal(conflict), "sha1")).not.toBe(snapshotIndexSemantics(index, "sha1"));
  });

  it("rejects corrupt checksums, unsupported versions, truncated entries and oversized extension lengths", () => {
    const { index, content, seal } = indexFixture(2, "sha1");
    const checksum = Buffer.from(index);
    checksum[checksum.length - 1] ^= 1;
    const version = Buffer.from(content);
    version.writeUInt32BE(5, 4);
    const count = Buffer.from(content);
    count.writeUInt32BE(2, 8);
    const extension = Buffer.from(content);
    extension.writeUInt32BE(1000, content.length - 8);
    for (const invalid of [checksum, seal(version), seal(count), seal(extension), Buffer.alloc(4)])
      expect(() => snapshotIndexSemantics(invalid, "sha1")).toThrow(".git/index");
  });

  it("requires changed content and unchanged filesystem permissions and owners for a stat refresh", () => {
    const baseline: SnapshotIndexBaseline = { version: 1, contentSha256: "a".repeat(64), semanticsSha256: "b".repeat(64), mode: "33188", uid: "1000", gid: "1000" };
    const refreshed = { ...baseline, contentSha256: "c".repeat(64) };
    expect(isOnlyIndexStatRefresh(baseline, refreshed)).toBe(true);
    for (const current of [baseline, { ...refreshed, semanticsSha256: "d".repeat(64) }, { ...refreshed, mode: "33261" }, { ...refreshed, uid: "0" }, { ...refreshed, gid: "0" }])
      expect(isOnlyIndexStatRefresh(baseline, current)).toBe(false);
    expect(isSnapshotIndexBaseline(baseline)).toBe(true);
    for (const invalid of [null, {}, { ...baseline, version: 2 }, { ...baseline, uid: -1 }, { ...baseline, contentSha256: "unverified" }])
      expect(isSnapshotIndexBaseline(invalid)).toBe(false);
  });
});
