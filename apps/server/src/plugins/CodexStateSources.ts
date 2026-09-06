import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  codexStateSourceBasename,
  parseCodexStateSourcesResponse,
  type CodexStateSource,
  type CodexStateSourcesResponse,
} from "@cloudx/shared";

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
    | "opendir"
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

/** Metadata and durable source binding only; never opens databases or owns a child. */
export class CodexStateSources {
  readonly originalHome: string;
  private readonly dependencies: SourceDependencies;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

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
    const operation = (async () => {
      check();
      const result = await task(check);
      check();
      return result;
    })();
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      clearTimeout(timer);
      this.active.delete(operation);
    }
  }

  async dispose(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.active]);
  }

  async list(signal?: AbortSignal): Promise<CodexStateSourcesResponse> {
    return this.work(signal, async (check) => {
      const shared = await this.resolveChecked("shared", check);
      const root = await this.legacyRoot(check, true);
      const sources: CodexStateSource[] = [
        {
          sourceId: "shared",
          kind: "shared",
          label: "Shared sessions",
          updatedAt: null,
        },
      ];
      if (!root) return { sources };
      const directory = await this.dependencies.fs.opendir(root.home);
      const names: string[] = [];
      try {
        while (true) {
          check();
          const entry = await directory.read();
          check();
          if (!entry) break;
          if (!entry.isDirectory()) continue;
          legacySourceId(entry.name);
          names.push(entry.name);
          if (names.length > 512)
            throw new Error(
              "Codex source inventory exceeds 512 retained sources.",
            );
        }
      } finally {
        await directory.close();
      }
      let next = 0;
      let failure: unknown;
      await Promise.all(
        Array.from({ length: Math.min(4, names.length) }, async () => {
          try {
            while (!failure && next < names.length) {
              check();
              const name = names[next++]!;
              const source = await this.resolveChecked(
                legacySourceId(name),
                check,
              );
              const heading = await this.readText(
                path.join(source.home, "AGENTS.override.md"),
                16 * 1024,
                check,
                true,
                true,
              );
              check();
              const stat = await this.directory(source.home, check);
              if (!sameSource(source, stat))
                throw new Error("Codex source changed during inventory.");
              const match = heading?.startsWith(
                "# CloudX Codex Session Instructions\n",
              )
                ? /^## CloudX Template: ([^\r\n]{1,256})\r?\n/mu.exec(heading)
                : null;
              const label = match?.[1]?.trim();
              sources.push({
                sourceId: source.sourceId,
                kind: "legacy",
                label:
                  label && !/[\p{Cc}]/u.test(label)
                    ? label
                    : "Retained session source",
                updatedAt: new Date(
                  (await this.dependencies.fs.stat(source.home)).mtimeMs,
                ).toISOString(),
              });
            }
          } catch (error) {
            failure ??= error;
          }
        }),
      );
      if (failure) throw failure;
      await this.requireIdentity(root, check);
      await this.requireIdentity(shared, check);
      sources.sort((a, b) =>
        a.kind === "shared"
          ? -1
          : b.kind === "shared"
            ? 1
            : (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
              a.sourceId.localeCompare(b.sourceId),
      );
      return parseCodexStateSourcesResponse({ sources });
    });
  }

  resolve(
    sourceId = "shared",
    signal?: AbortSignal,
  ): Promise<ResolvedCodexStateSource> {
    return this.work(signal, (check) => this.resolveChecked(sourceId, check));
  }

  async readConfig(
    source: ResolvedCodexStateSource,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return this.work(signal, async (check) => {
      await this.requireIdentity(source, check);
      const config = await this.readText(
        path.join(source.home, "config.toml"),
        1_048_576,
        check,
        true,
      );
      await this.requireIdentity(source, check);
      return config;
    });
  }

  async assertCurrent(
    source: ResolvedCodexStateSource,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = await this.resolve(source.sourceId, signal);
    if (!sameSource(source, current))
      throw new Error("Codex source binding is stale: source changed.");
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
      await this.requireIdentity(source, check);
      const existing = await this.bindingChecked(tabId, check);
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
        } finally {
          await handle.close();
        }
        check();
        await this.requireIdentity(source, check);
        check();
        await this.dependencies.fs.rename(staging, path.join(view, BINDING));
        owned = false;
      } finally {
        if (owned) await this.dependencies.fs.unlink(staging);
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
      if (
        await this.optionalStat(
          path.join(this.dataDir, "codex-homes", tabId),
          check,
        )
      )
        throw new Error(
          "Retained Codex tab requires explicit session source selection in a new tab.",
        );
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
      throw new Error("Codex launch source binding is missing or invalid.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Codex source binding.");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "dev,home,ino,sourceId,version" ||
      record.version !== 1 ||
      ![record.home, record.sourceId, record.dev, record.ino].every(
        (item) => typeof item === "string",
      )
    )
      throw new Error("Invalid Codex source binding.");
    const selected = await this.resolveChecked(
      record.sourceId as string,
      check,
    );
    if (!sameSource(record as unknown as ResolvedCodexStateSource, selected))
      throw new Error("Codex source binding is stale: source changed.");
    return selected;
  }

  private async resolveChecked(
    sourceId: string,
    check: () => void,
  ): Promise<ResolvedCodexStateSource> {
    const basename = codexStateSourceBasename(sourceId);
    const shared = await this.directory(this.originalHome, check);
    let source = { ...shared, sourceId };
    if (basename !== undefined) {
      const root = await this.legacyRoot(check);
      source = {
        ...(await this.directory(path.join(root!.home, basename), check)),
        sourceId,
      };
      if (
        path.dirname(source.home) !== root!.home ||
        source.home === shared.home ||
        source.home === root!.home ||
        (source.dev === shared.dev && source.ino === shared.ino)
      )
        throw new Error("Invalid Codex source alias.");
      await this.requireIdentity(root!, check);
    }
    for (const name of ["sessions", "archived_sessions"]) {
      const candidate = path.join(source.home, name);
      const stat = await this.optionalStat(candidate, check);
      if (!stat) continue;
      check();
      const target = await this.dependencies.fs.realpath(candidate);
      const targetStat = await this.dependencies.fs.stat(candidate);
      check();
      if (
        !targetStat.isDirectory() ||
        targetStat.uid !== this.dependencies.uid() ||
        (target !== candidate && target !== path.join(shared.home, name))
      )
        throw new Error("Invalid Codex source history link.");
    }
    await this.requireIdentity(source, check);
    return source;
  }

  private async legacyRoot(
    check: () => void,
    optional = false,
  ): Promise<ResolvedCodexStateSource | undefined> {
    const root = path.join(this.dataDir, "codex-homes");
    if (optional && !(await this.optionalStat(root, check))) return undefined;
    await this.directory(this.dataDir, check);
    const identity = await this.directory(root, check);
    return { ...identity, sourceId: "root" };
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
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !after.isDirectory()
    )
      throw new Error("Codex source directory changed.");
    return {
      sourceId: "",
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.directory(target, check);
  }

  private async readText(
    target: string,
    cap: number,
    check: () => void,
    optional = false,
    prefix = false,
  ): Promise<string | undefined> {
    check();
    let handle;
    try {
      handle = await this.dependencies.fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    try {
      check();
      const before = await handle.stat();
      if (!before.isFile() || before.uid !== this.dependencies.uid())
        throw new Error("Invalid Codex source metadata owner or type.");
      if (!prefix && before.size > cap)
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
        if (!bytesRead) break;
        offset += bytesRead;
      }
      check();
      const after = await handle.stat();
      const named = await this.dependencies.fs.lstat(target);
      if (
        before.dev !== named.dev ||
        before.ino !== named.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        offset !== buffer.length
      )
        throw new Error("Codex source metadata changed during read.");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer,
        { stream: prefix && before.size > cap },
      );
    } finally {
      await handle.close();
    }
  }
}

export function legacySourceId(basename: string): string {
  const sourceId = `legacy:${Buffer.from(basename, "utf8").toString("base64url")}`;
  if (codexStateSourceBasename(sourceId) !== basename)
    throw new Error("Invalid Codex source basename.");
  return sourceId;
}

function sameSource(
  left: ResolvedCodexStateSource,
  right: ResolvedCodexStateSource,
): boolean {
  return (
    left.home === right.home && left.dev === right.dev && left.ino === right.ino
  );
}
