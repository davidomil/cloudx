import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface ResolvedCodexStateSource {
  sourceId: string;
  home: string;
  dev: string;
  ino: string;
}

interface SourceDependencies {
  fs: Pick<
    typeof fs,
    | "lstat"
    | "stat"
    | "realpath"
    | "access"
    | "open"
    | "mkdir"
    | "rename"
    | "unlink"
  >;
  now: () => number;
  uid: () => number;
}

const BINDING = ".cloudx-source.json";
const DEADLINE_MS = 30_000;

/** Shared configuration and durable source binding; never opens databases or owns a child. */
export class CodexStateSources {
  readonly originalHome: string;
  private readonly dependencies: SourceDependencies;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private disposal: Promise<void> | undefined;
  private cleanupFailed = false;

  constructor(
    readonly dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
    dependencies: Partial<SourceDependencies> = {},
  ) {
    this.originalHome = path.resolve(
      env.CODEX_HOME?.trim() ||
        path.join(env.HOME?.trim() || os.homedir(), ".codex"),
    );
    this.dependencies = {
      fs,
      now: Date.now,
      uid: () => process.getuid!(),
      ...dependencies,
    };
  }

  private async work<T>(
    signal: AbortSignal | undefined,
    task: (check: () => void) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    timer.unref();
    const combined = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    const started = this.dependencies.now();
    const check = () => {
      if (combined.aborted || this.dependencies.now() - started >= DEADLINE_MS)
        throw new Error("Codex source operation cancelled or timed out.");
    };
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () =>
        reject(new Error("Codex source operation cancelled or timed out."));
      combined.addEventListener("abort", interrupt, { once: true });
      if (combined.aborted) interrupt();
    });
    const operation = (async () => {
      check();
      const result = await task(check);
      check();
      return result;
    })();
    // Caller settlement does not relinquish eventual handles or late failures.
    const supervised = operation.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(supervised);
    void supervised.then(() => this.active.delete(supervised));
    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", interrupt);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.shutdown.abort();
    let timer: NodeJS.Timeout;
    const incomplete = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("Codex source cleanup incomplete after deadline.")),
        DEADLINE_MS,
      );
      timer.unref();
    });
    const quiescent = Promise.all([...this.active]).then(() => {
      if (this.cleanupFailed) throw new Error("Codex source cleanup failed.");
    });
    this.disposal = Promise.race([quiescent, incomplete]).finally(() =>
      clearTimeout(timer),
    );
    return this.disposal;
  }

  private async cleanup(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch {
      this.cleanupFailed = true;
      throw new Error("Codex source cleanup failed.");
    }
  }

  resolve(signal?: AbortSignal): Promise<ResolvedCodexStateSource> {
    return this.work(signal, (check) => this.resolveChecked(check));
  }

  async readConfig(
    source: ResolvedCodexStateSource,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return this.work(signal, async (check) => {
      await this.requireIdentity(source, check);
      check();
      const config = await this.readText(
        path.join(source.home, "config.toml"),
        1_048_576,
        check,
        true,
      );
      await this.requireIdentity(source, check);
      check();
      return config;
    });
  }

  async assertCurrent(
    source: ResolvedCodexStateSource,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.resolve(signal);
    if (!sameSource(source, current))
      throw new Error("Codex source binding is stale: source changed.");
  }

  replaceConfig(
    source: ResolvedCodexStateSource,
    expected: string | undefined,
    replacement: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (Buffer.byteLength(replacement) > 1_048_576)
      return Promise.reject(new Error("Codex configuration exceeds size limit."));
    return this.work(signal, async (check) => {
      await this.requireIdentity(source, check);
      const lockPath = path.join(source.home, ".cloudx-config.lock");
      let lock;
      try {
        check();
        lock = await this.dependencies.fs.open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("Shared Codex settings are being edited. Reload before saving again. If a previous writer stopped unexpectedly, remove .cloudx-config.lock from the Codex home after confirming no save is running.");
        throw error;
      }
      const target = path.join(source.home, "config.toml");
      const staging = path.join(source.home, `.cloudx-config-${randomUUID()}.tmp`);
      let staged = false;
      try {
        check();
        if (await this.readText(target, 1_048_576, check, true) !== expected)
          throw new Error("Shared Codex settings changed. Reload before saving again.");
        const file = await this.dependencies.fs.open(staging, "wx", 0o600);
        staged = true;
        try {
          check();
          await file.writeFile(replacement, "utf8");
          check();
          await file.sync();
        } finally {
          await this.cleanup(() => file.close());
        }
        if (!sameSource(source, await this.resolveChecked(check)))
          throw new Error("Codex source changed.");
        if (await this.readText(target, 1_048_576, check, true) !== expected)
          throw new Error("Shared Codex settings changed. Reload before saving again.");
        check();
        await this.dependencies.fs.rename(staging, target);
        staged = false;
      } finally {
        try {
          if (staged) await this.cleanup(() => this.dependencies.fs.unlink(staging));
        } finally {
          try { await this.cleanup(() => lock.close()); }
          finally { await this.cleanup(() => this.dependencies.fs.unlink(lockPath)); }
        }
      }
    });
  }

  viewPath(tabId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(tabId))
      throw new Error("Invalid Codex launch tab id.");
    return path.join(this.dataDir, "codex-launches", tabId);
  }

  readBinding(
    tabId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedCodexStateSource | undefined> {
    return this.work(signal, (check) => this.bindingChecked(tabId, check));
  }

  async bind(
    tabId: string,
    source: ResolvedCodexStateSource,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.work(signal, async (check) => {
      const view = this.viewPath(tabId);
      const shared = await this.resolveChecked(check);
      if (!sameSource(source, shared)) throw new Error("Codex launch requires the shared session store.");
      const existing = await this.bindingChecked(tabId, check);
      check();
      if (existing) {
        if (!sameSource(existing, source))
          throw new Error(
            "Codex source selection conflicts with existing binding.",
          );
        return view;
      }
      check();
      await this.dependencies.fs.mkdir(this.dataDir, {
        recursive: true,
        mode: 0o700,
      });
      await this.directory(this.dataDir, check);
      await this.createDirectory(path.dirname(view), check);
      check();
      await this.dependencies.fs.mkdir(view, { mode: 0o700 });
      await this.directory(view, check);
      const staging = path.join(view, `.cloudx-binding-${randomUUID()}.tmp`);
      let owned = false;
      try {
        check();
        const handle = await this.dependencies.fs.open(staging, "wx", 0o600);
        owned = true;
        try {
          check();
          await handle.writeFile(
            `${JSON.stringify({ version: 1, ...source })}\n`,
          );
          check();
        } finally {
          await this.cleanup(() => handle.close());
        }
        check();
        await this.requireIdentity(source, check);
        check();
        await this.dependencies.fs.rename(staging, path.join(view, BINDING));
        owned = false;
        check();
      } finally {
        if (owned)
          await this.cleanup(() => this.dependencies.fs.unlink(staging));
      }
      return view;
    });
  }

  private async bindingChecked(
    tabId: string,
    check: () => void,
  ): Promise<ResolvedCodexStateSource | undefined> {
    const view = this.viewPath(tabId);
    if (!(await this.optionalStat(view, check))) {
      return undefined;
    }
    await this.directory(this.dataDir, check);
    await this.directory(path.dirname(view), check);
    await this.directory(view, check);
    let value: unknown;
    try {
      value = JSON.parse(
        (await this.readText(path.join(view, BINDING), 4096, check))!,
      );
    } catch {
      check();
      throw new Error("Codex launch source binding is missing or invalid.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Codex source binding.");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "dev,home,ino,sourceId,version" ||
      record.version !== 1 ||
      record.sourceId !== "shared" ||
      ![record.home, record.sourceId, record.dev, record.ino].every(
        (item) => typeof item === "string",
      )
    )
      throw new Error("Invalid Codex source binding.");
    const selected = await this.resolveChecked(check);
    if (!sameSource(record as unknown as ResolvedCodexStateSource, selected))
      throw new Error("Codex source binding is stale: source changed.");
    return selected;
  }

  private async resolveChecked(
    check: () => void,
  ): Promise<ResolvedCodexStateSource> {
    const source = await this.directory(this.originalHome, check);
    for (const name of ["sessions", "archived_sessions"]) {
      const candidate = path.join(source.home, name);
      const stat = await this.optionalStat(candidate, check);
      if (!stat) continue;
      check();
      const target = await this.dependencies.fs.realpath(candidate);
      check();
      const targetStat = await this.dependencies.fs.stat(candidate);
      check();
      if (
        !targetStat.isDirectory() ||
        targetStat.uid !== this.dependencies.uid() ||
        target !== candidate
      )
        throw new Error("Invalid Codex source history link.");
    }
    await this.requireIdentity(source, check);
    return source;
  }

  private async directory(
    directory: string,
    check: () => void,
  ): Promise<ResolvedCodexStateSource> {
    check();
    const before = await this.dependencies.fs.lstat(directory);
    check();
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("Codex source must be a real directory.");
    if (before.uid !== this.dependencies.uid())
      throw new Error("Codex source has a different owner.");
    const home = await this.dependencies.fs.realpath(directory);
    check();
    await this.dependencies.fs.access(
      home,
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
    check();
    const after = await this.dependencies.fs.lstat(directory);
    check();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !after.isDirectory()
    )
      throw new Error("Codex source directory changed.");
    return {
      sourceId: "shared",
      home,
      dev: String(after.dev),
      ino: String(after.ino),
    };
  }

  private async requireIdentity(
    source: ResolvedCodexStateSource,
    check: () => void,
  ): Promise<void> {
    const current = await this.directory(source.home, check);
    if (!sameSource(source, current)) throw new Error("Codex source changed.");
  }

  private async optionalStat(
    target: string,
    check: () => void,
  ): Promise<Stats | undefined> {
    check();
    try {
      const stat = await this.dependencies.fs.lstat(target);
      check();
      return stat;
    } catch (error) {
      check();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async createDirectory(
    target: string,
    check: () => void,
  ): Promise<void> {
    check();
    try {
      await this.dependencies.fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      check();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.directory(target, check);
  }

  private async readText(
    target: string,
    cap: number,
    check: () => void,
    optional = false,
  ): Promise<string | undefined> {
    check();
    let handle;
    try {
      handle = await this.dependencies.fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      check();
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    try {
      check();
      const before = await handle.stat();
      check();
      if (!before.isFile() || before.uid !== this.dependencies.uid())
        throw new Error("Invalid Codex source metadata owner or type.");
      if (before.size > cap)
        throw new Error("Codex source metadata exceeds size limit.");
      const buffer = Buffer.alloc(Math.min(before.size, cap));
      let offset = 0;
      while (offset < buffer.length) {
        check();
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        check();
        if (!bytesRead) break;
        offset += bytesRead;
      }
      check();
      const after = await handle.stat();
      check();
      const named = await this.dependencies.fs.lstat(target);
      check();
      if (
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        offset !== buffer.length
      )
        throw new Error("Codex source metadata changed during read.");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } finally {
      await this.cleanup(() => handle.close());
    }
  }
}

function sameSource(
  left: ResolvedCodexStateSource,
  right: ResolvedCodexStateSource,
): boolean {
  return (
    left.sourceId === right.sourceId && left.home === right.home && left.dev === right.dev && left.ino === right.ino
  );
}
