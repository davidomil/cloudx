import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

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

  it.each(["before setup", "during setup"])("closes an upload cancelled %s without emitting another error", async (when) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-setup-abort-"));
    const body = new PassThrough();
    const controller = new AbortController();
    const stopped = new Error("Documentation ingest queue was stopped.");
    const emittedErrors: Error[] = [];
    body.on("error", (error) => emittedErrors.push(error));
    const closed = new Promise<void>((resolve) => body.once("close", resolve));
    if (when === "before setup") controller.abort(stopped);
    const upload = spoolDocumentationUpload(body, root, 12, 12, { signal: controller.signal });
    if (when === "during setup") controller.abort(stopped);

    try {
      await expect(upload).rejects.toBe(stopped);
      expect(body.destroyed).toBe(true);
      await closed;
      expect(body.readableDidRead).toBe(false);
      expect(emittedErrors).toEqual([]);
      await expect(fs.readdir(root)).resolves.toEqual([]);
    } finally {
      body.destroy();
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a partial private spool when cancelled while waiting for the remaining body", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-admission-abort-"));
    const body = new PassThrough();
    const controller = new AbortController();
    const stopped = new Error("Documentation ingest queue was stopped.");
    const waitingForRemainder = deferred();
    const iterator = body[Symbol.asyncIterator]();
    const next = iterator.next.bind(iterator);
    let reads = 0;
    vi.spyOn(iterator, "next").mockImplementation((...args) => {
      const pending = next(...args);
      if (++reads === 2) waitingForRemainder.resolve();
      return pending;
    });
    vi.spyOn(body, Symbol.asyncIterator).mockReturnValue(iterator);
    const upload = spoolDocumentationUpload(body, root, 12, 12, { signal: controller.signal });
    body.write("partial");

    try {
      await waitingForRemainder.promise;
      const directories = await fs.readdir(root);
      expect(directories).toHaveLength(1);
      await expect(fs.readFile(path.join(root, directories[0]!, "payload"), "utf8")).resolves.toBe("partial");

      controller.abort(stopped);

      await expect(upload).rejects.toBe(stopped);
      expect(body.destroyed).toBe(true);
      await expect(fs.readdir(root)).resolves.toEqual([]);
    } finally {
      controller.abort(stopped);
      await upload.catch(() => undefined);
      body.destroy();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("closes a body cancelled between reads and awaits disposal of its partial spool", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-spool-write-abort-"));
    const body = new PassThrough();
    const controller = new AbortController();
    const stopped = { code: "UPLOAD_STOPPED", message: "Documentation ingest queue was stopped." };
    const written = deferred();
    const finishWrite = deferred();
    const removing = deferred();
    const finishRemoval = deferred();
    const open = fs.open.bind(fs);
    const remove = fs.rm.bind(fs);
    let file: Awaited<ReturnType<typeof fs.open>>;
    let filePath: string;
    const openFile = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      filePath = String(args[0]);
      file = await open(...args);
      const writeFile = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementationOnce(async (...writeArgs) => {
        await writeFile(...writeArgs);
        written.resolve();
        await finishWrite.promise;
      });
      return file;
    });
    const removeDirectory = vi.spyOn(fs, "rm").mockImplementationOnce(async (...args) => {
      removing.resolve();
      await finishRemoval.promise;
      await remove(...args);
    });
    const upload = spoolDocumentationUpload(body, root, 12, 12, { signal: controller.signal });
    let settled = false;
    const outcome = upload.then(
      (result) => { settled = true; return result; },
      (error: unknown) => { settled = true; return error; }
    );
    body.write("partial");

    try {
      await written.promise;
      await expect(fs.readFile(filePath!, "utf8")).resolves.toBe("partial");
      controller.abort(stopped);
      finishWrite.resolve();

      await removing.promise;
      expect(file!.fd).toBe(-1);
      expect(settled).toBe(false);
      await expect(fs.readFile(filePath!, "utf8")).resolves.toBe("partial");
      finishRemoval.resolve();

      await expect(outcome).resolves.toBe(stopped);
      expect(body.destroyed).toBe(true);
      await expect(fs.readdir(root)).resolves.toEqual([]);
    } finally {
      finishWrite.resolve();
      finishRemoval.resolve();
      controller.abort(stopped);
      await outcome;
      body.destroy();
      openFile.mockRestore();
      removeDirectory.mockRestore();
      await remove(root, { recursive: true, force: true });
    }
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
