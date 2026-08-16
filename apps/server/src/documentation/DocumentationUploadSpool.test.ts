import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { reapDocumentationUploadSpool, spoolDocumentationUpload } from "./DocumentationUploadSpool.js";

describe("DocumentationUploadSpool", () => {
  it("writes the exact declared body to an exclusive temporary file and removes it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-"));
    const upload = await spoolDocumentationUpload(Readable.from([Buffer.from("first"), Buffer.from("second")]), root, 11, 12);

    expect(upload.bytes).toBe(11);
    await expect(fs.readFile(upload.path, "utf8")).resolves.toBe("firstsecond");

    await upload.dispose();
    await upload.dispose();
    await expect(fs.stat(upload.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a body that differs from the declared length and leaves no spool file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-mismatch-"));

    await expect(spoolDocumentationUpload(Readable.from([Buffer.from("too long")]), root, 3, 10)).rejects.toMatchObject({
      code: "DOCUMENTATION_UPLOAD_LENGTH_MISMATCH",
      statusCode: 400
    });

    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("aborts an upload that makes no progress before its inactivity deadline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-inactive-"));
    const body = new PassThrough();

    await expect(spoolDocumentationUpload(body, root, 5, 10, { inactivityTimeoutMs: 20 })).rejects.toMatchObject({
      code: "DOCUMENTATION_UPLOAD_INACTIVITY_TIMEOUT",
      statusCode: 408
    });

    expect(body.destroyed).toBe(true);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("removes a partial private spool before an admission-owned abort settles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-admission-abort-"));
    const body = new PassThrough();
    const controller = new AbortController();
    const stopped = new Error("Documentation ingest queue was stopped.");
    const upload = spoolDocumentationUpload(body, root, 12, 12, { signal: controller.signal });
    body.write("partial");
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort(stopped);

    await expect(upload).rejects.toBe(stopped);
    expect(body.destroyed).toBe(true);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("reaps interrupted upload directories without deleting unrelated spool-root entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-reap-"));
    await fs.mkdir(path.join(root, "upload-interrupted"));
    await fs.writeFile(path.join(root, "upload-interrupted", "payload"), "partial", "utf8");
    await fs.mkdir(path.join(root, "operator-note"));

    await reapDocumentationUploadSpool(root);

    await expect(fs.stat(path.join(root, "upload-interrupted"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "operator-note"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});
