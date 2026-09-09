import fs from "node:fs/promises";
import path from "node:path";

export class DocumentationUploadLengthError extends Error {
  readonly code = "DOCUMENTATION_UPLOAD_LENGTH_MISMATCH";
  readonly statusCode = 400;

  constructor() {
    super("Documentation upload body does not match its declared Content-Length.");
    this.name = "DocumentationUploadLengthError";
  }
}

export class DocumentationUploadInactivityError extends Error {
  readonly code = "DOCUMENTATION_UPLOAD_INACTIVITY_TIMEOUT";
  readonly statusCode = 408;

  constructor(readonly timeoutMs: number) {
    super(`Documentation upload made no progress for ${timeoutMs} ms.`);
    this.name = "DocumentationUploadInactivityError";
  }
}

export const DEFAULT_DOCUMENTATION_UPLOAD_INACTIVITY_TIMEOUT_MS = 30_000;

export interface DocumentationUploadSpoolOptions {
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
}

export class DocumentationUploadSpool {
  private disposed = false;

  constructor(
    readonly path: string,
    readonly bytes: number,
    private readonly directory: string
  ) {}

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}

export async function spoolDocumentationUpload(
  body: NodeJS.ReadableStream,
  spoolRoot: string,
  expectedBytes: number,
  maxBytes: number,
  options: DocumentationUploadSpoolOptions = {}
): Promise<DocumentationUploadSpool> {
  requireByteCount(expectedBytes, "Content-Length");
  requireByteCount(maxBytes, "documentation upload byte limit");
  if (expectedBytes > maxBytes) {
    const error = new Error(`Documentation upload exceeds the ${maxBytes} byte limit.`) as Error & { statusCode: number };
    error.statusCode = 413;
    throw error;
  }
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_DOCUMENTATION_UPLOAD_INACTIVITY_TIMEOUT_MS;
  requirePositiveTimeout(inactivityTimeoutMs);

  await fs.mkdir(spoolRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(spoolRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Documentation upload spool root must be a real directory.");
  }
  await fs.chmod(spoolRoot, 0o700);
  const directory = await fs.mkdtemp(path.join(spoolRoot, "upload-"));
  await fs.chmod(directory, 0o700);
  const filePath = path.join(directory, "payload");
  const file = await fs.open(filePath, "wx", 0o600);
  let bytes = 0;
  try {
    const iterator = (body as AsyncIterable<Buffer | Uint8Array | string>)[Symbol.asyncIterator]();
    while (true) {
      const next = await nextUploadChunk(iterator, body, inactivityTimeoutMs, options.signal);
      if (next.done) {
        break;
      }
      const chunk = next.value;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength > expectedBytes - bytes) {
        throw new DocumentationUploadLengthError();
      }
      await file.writeFile(buffer);
      bytes += buffer.byteLength;
    }
    if (bytes !== expectedBytes) {
      throw new DocumentationUploadLengthError();
    }
    await file.close();
    return new DocumentationUploadSpool(filePath, bytes, directory);
  } catch (error) {
    await file.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function reapDocumentationUploadSpool(spoolRoot: string): Promise<void> {
  const rootStat = await fs.lstat(spoolRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!rootStat) {
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Documentation upload spool root must be a real directory.");
  }
  const entries = await fs.readdir(spoolRoot, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.name.startsWith("upload-")).map((entry) => fs.rm(path.join(spoolRoot, entry.name), { recursive: true, force: true })));
}

async function nextUploadChunk<T>(
  iterator: AsyncIterator<T>,
  body: NodeJS.ReadableStream,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal?.aborted) {
    (body as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy();
    throw signal.reason;
  }
  let timeout: NodeJS.Timeout | undefined;
  let disposeAbort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (error: unknown) => {
      (body as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(error instanceof Error ? error : new Error(String(error)));
      reject(error);
    };
    timeout = setTimeout(() => stop(new DocumentationUploadInactivityError(timeoutMs)), timeoutMs);
    timeout.unref?.();
    if (signal) {
      const abort = () => stop(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      disposeAbort = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    return await Promise.race([iterator.next(), interrupted]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    disposeAbort();
  }
}

function requireByteCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function requirePositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Documentation upload inactivity timeout must be a positive safe integer.");
  }
}
