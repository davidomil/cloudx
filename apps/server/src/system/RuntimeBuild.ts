import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface BuildReceipt {
  version: 1;
  commit: string;
  builtAt: string;
  sourceDirty: boolean;
  nodeVersion: string;
  lockSha256: string;
  artifactSha256: string;
}

/** Captures startup evidence once, before an updater can replace the checkout. */
export class RuntimeBuild {
  readonly identity;

  constructor(directory = fileURLToPath(new URL("../", import.meta.url))) {
    const processIdentity = {
      pid: process.pid,
      processStarted: process.platform === "linux"
        ? fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19]
        : null,
      bootId: process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : null,
      invocationId: process.env.INVOCATION_ID ?? null
    };
    try {
      const receipt: unknown = JSON.parse(fs.readFileSync(path.join(directory, "runtime-build.json"), "utf8"));
      if (!validReceipt(receipt)) throw new Error("The runtime build receipt is invalid.");
      const { artifacts, ...build } = receipt;
      if (sha256(JSON.stringify(artifacts)) !== build.artifactSha256) throw new Error("The runtime artifact manifest has changed.");
      for (const [relative, digest] of Object.entries(artifacts)) {
        const artifact = path.join(directory, relative);
        if (!fs.lstatSync(artifact).isFile() || sha256(fs.readFileSync(artifact)) !== digest) {
          throw new Error("Built runtime files no longer match their build receipt.");
        }
      }
      this.identity = Object.freeze({ verification: "verified" as const, build: Object.freeze(build), ...processIdentity });
    } catch (error) {
      this.identity = Object.freeze({ verification: "unverified" as const, build: null, ...processIdentity,
        reason: error instanceof Error && !('code' in error) ? error.message : "A complete runtime build receipt is unavailable. Rebuild and restart CloudX." });
    }
  }
}

function validReceipt(value: unknown): value is BuildReceipt & { artifacts: Record<string, string> } {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return receipt.version === 1 && typeof receipt.commit === "string" && /^[a-f0-9]{40}$/.test(receipt.commit)
    && typeof receipt.builtAt === "string" && Number.isFinite(Date.parse(receipt.builtAt))
    && typeof receipt.sourceDirty === "boolean" && typeof receipt.nodeVersion === "string"
    && isDigest(receipt.lockSha256) && isDigest(receipt.artifactSha256)
    && !!receipt.artifacts && typeof receipt.artifacts === "object" && !Array.isArray(receipt.artifacts)
    && Object.hasOwn(receipt.artifacts, "index.js")
    && Object.entries(receipt.artifacts).every(([relative, digest]) =>
      relative.endsWith(".js") && !path.isAbsolute(relative) && relative.split(/[\\/]/).every(part => part !== ".." && part !== "." && part !== "") && isDigest(digest));
}

function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export const runtimeBuild = new RuntimeBuild();
