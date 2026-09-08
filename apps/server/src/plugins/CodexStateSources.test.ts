import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexStateSources } from "./CodexStateSources.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-state-sources-"),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const legacy = path.join(data, "codex-homes", "old-a");
  await fs.mkdir(home);
  await fs.mkdir(legacy, { recursive: true });
  return {
    root,
    home,
    data,
    legacy,
    sources: new CodexStateSources(data, { CODEX_HOME: home }),
  };
}

describe("CodexStateSources", () => {
  it.each([
    "lstat",
    "open",
    "file.stat",
    "file.read",
    "file.close",
  ])(
    "settles the deadline before held %s returns and retains eventual cleanup ownership",
    async (stage) => {
      const f = await heldSourceFixture(stage);
      vi.useFakeTimers();
      const result = f.start().then(
        () => "accepted",
        (error: Error) => error.message,
      );
      let outcome: string | undefined;
      void result.then((value) => {
        outcome = value;
      });
      try {
        await f.entered;
        await vi.advanceTimersByTimeAsync(29_999);
        expect(outcome).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toMatch(/cancelled or timed out/);
        expect(f.released()).toBe(false);
        const first = f.sources.dispose();
        const cleanup = first.then(
          () => "clean",
          (error: Error) => error.message,
        );
        let disposal: string | undefined;
        void cleanup.then((value) => {
          disposal = value;
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.sources.dispose()).toBe(first);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(disposal).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(disposal).toMatch(/cleanup.*incomplete/i);
        expect(f.released()).toBe(false);
        const calls = [...f.calls];
        f.release();
        await f.finished;
        await vi.advanceTimersByTimeAsync(0);
        expect(
          f.calls.slice(calls.length).every((call) => call.endsWith("close")),
        ).toBe(true);
        expect(f.closes()).toBe(stage === "lstat" ? 0 : 1);
        expect(outcome).toMatch(/cancelled or timed out/);
        expect(f.sources.dispose()).toBe(first);
      } finally {
        f.release();
        await f.finished;
        await f.sources.dispose().catch(() => undefined);
        vi.useRealTimers();
      }
    },
  );

  it.each(["request", "shutdown"])(
    "settles %s cancellation before held metadata returns, then disposes cleanly",
    async (kind) => {
      const f = await heldSourceFixture("lstat");
      const controller = new AbortController();
      vi.useFakeTimers();
      let outcome: string | undefined;
      void f.start(controller.signal).then(
        () => {
          outcome = "accepted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );
      let cleanup: Promise<void> | undefined;
      try {
        await f.entered;
        if (kind === "request") controller.abort();
        else cleanup = f.sources.dispose();
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toMatch(/cancelled/);
        expect(f.released()).toBe(false);
        f.release();
        await f.finished;
        await (cleanup ?? f.sources.dispose());
        expect(f.calls).toEqual(["lstat"]);
      } finally {
        f.release();
        await f.finished;
        await (cleanup ?? f.sources.dispose());
        vi.useRealTimers();
      }
    },
  );

  it("observes a delayed metadata rejection after caller cancellation", async () => {
    const f = await heldSourceFixture("lstat", true);
    const controller = new AbortController();
    const result = f
      .start(controller.signal)
      .catch((error: Error) => error.message);
    await f.entered;
    controller.abort();
    f.release();
    await f.finished;
    expect(await result).toMatch(/cancelled/);
    await f.sources.dispose();
  });

  it.each(["file.close"])(
    "reports sanitized %s failure even after its task has settled",
    async (stage) => {
      const f = await heldSourceFixture(stage, true);
      const result = f.start().catch((error: Error) => error.message);
      await f.entered;
      f.release();
      await result;
      await f.finished;
      await expect(f.sources.dispose()).rejects.toThrow(/cleanup.*failed/i);
      await expect(f.sources.dispose()).rejects.not.toThrow(/private/);
      expect(f.closes()).toBe(1);
    },
  );

  it("resolves only the shared home without discovering retained sources", async () => {
    const f = await fixture();
    const scan = vi.spyOn(fs, "opendir");
    const source = await f.sources.resolve();
    expect(source).toMatchObject({ sourceId: "shared", home: await fs.realpath(f.home) });
    expect(scan).not.toHaveBeenCalled();
    expect(await f.sources.readBinding("old-a")).toBeUndefined();
    expect(await fs.readdir(f.legacy)).toEqual([]);
  });

  it.each(["legacy:b2xkLWE", "../old-a", "", null])("rejects a retained or invalid persisted binding %s", async (sourceId) => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("old-binding", source);
    await fs.writeFile(path.join(view, ".cloudx-source.json"), JSON.stringify({ version: 1, ...source, sourceId }));
    await expect(f.sources.readBinding("old-binding")).rejects.toThrow(/binding/);
  });

  it("binds one canonical owner and rejects conflicting, missing, corrupt and stale bindings", async () => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("tab-1", source);
    expect(view).toContain("codex-launches/tab-1");
    expect(await f.sources.readBinding("tab-1")).toEqual(source);
    await expect(
      f.sources.bind("tab-1", { ...source, home: await fs.realpath(f.legacy) }),
    ).rejects.toThrow(/shared session store/i);
    await fs.rename(f.home, `${f.home}-retained`);
    await fs.mkdir(f.home);
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(
      /changed|stale/i,
    );
    await fs.writeFile(path.join(view, ".cloudx-source.json"), "{}");
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(/binding/i);
    await fs.unlink(path.join(view, ".cloudx-source.json"));
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(/binding/i);
    await expect(f.sources.bind("../escape", source)).rejects.toThrow();
  });

  it("preserves owned permissions but rejects wrong UID and symlink homes", async () => {
    const f = await fixture();
    await fs.chmod(f.home, 0o777);
    await f.sources.resolve();
    expect((await fs.stat(f.home)).mode & 0o777).toBe(0o777);
    await expect(new CodexStateSources(f.data, { CODEX_HOME: f.home }, { uid: () => -1 }).resolve()).rejects.toThrow(/owner/i);
    const alias = path.join(f.root, "alias");
    await fs.symlink(f.home, alias);
    await expect(new CodexStateSources(f.data, { CODEX_HOME: alias }).resolve()).rejects.toThrow(/real directory/);
  });

  it("rejects oversized config and redirected history", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.home, "config.toml"), "x".repeat(1_048_577));
    await expect(f.sources.readConfig(await f.sources.resolve())).rejects.toThrow(/limit/i);
    await fs.mkdir(path.join(f.legacy, "sessions"));
    await fs.symlink(path.join(f.legacy, "sessions"), path.join(f.home, "sessions"));
    await expect(f.sources.resolve()).rejects.toThrow(/history link/);
  });

  it("cancels request admission and shutdown without accepting late work", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    const open = vi.spyOn(fs, "open");
    await expect(f.sources.resolve(controller.signal)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await f.sources.dispose();
    await expect(f.sources.resolve()).rejects.toThrow();
  });

  it.each(["cancel", "replace"])(
    "rejects %s during an opened metadata read and closes once",
    async (action) => {
      const f = await fixture();
      const config = path.join(f.home, "config.toml");
      await fs.writeFile(config, 'model = "synthetic"');
      const controller = new AbortController();
      let closed = 0;
      const sources = new CodexStateSources(
        f.data,
        { CODEX_HOME: f.home },
        {
          fs: {
            ...fs,
            open: async (...args: Parameters<typeof fs.open>) => {
              const handle = await fs.open(...args);
              const originalRead = handle.read.bind(handle);
              const originalClose = handle.close.bind(handle);
              handle.read = (async (
                ...readArgs: Parameters<typeof handle.read>
              ) => {
                if (action === "cancel") controller.abort();
                else {
                  await fs.rename(config, `${config}.retained`);
                  await fs.writeFile(config, 'model = "replacement"');
                }
                return originalRead(...readArgs);
              }) as typeof handle.read;
              handle.close = async () => {
                closed += 1;
                await originalClose();
              };
              return handle;
            },
          },
        },
      );
      const selected = await sources.resolve();
      await expect(
        sources.readConfig(selected, controller.signal),
      ).rejects.toThrow(/cancelled|changed/);
      await sources.dispose();
      expect(closed).toBe(1);
    },
  );

  it.each(["EPERM", "ENOSPC"])(
    "retains a diagnosed view and cleans only owned binding staging after %s",
    async (code) => {
      const f = await fixture();
      const sources = new CodexStateSources(
        f.data,
        { CODEX_HOME: f.home },
        {
          fs: {
            ...fs,
            rename: async () => {
              throw Object.assign(new Error("synthetic rename failure"), {
                code,
              });
            },
          },
        },
      );
      await expect(
        sources.bind("binding-failure", await sources.resolve()),
      ).rejects.toMatchObject({ code });
      expect(
        await fs.readdir(
          path.join(f.data, "codex-launches", "binding-failure"),
        ),
      ).toEqual([]);
      expect(await fs.readdir(f.home)).toEqual([]);
      await expect(sources.readBinding("binding-failure")).rejects.toThrow(
        /binding/,
      );
    },
  );

  it("observes request deadlines", async () => {
    const f = await fixture();
    let now = 0;
    const timed = new CodexStateSources(
      f.data,
      { CODEX_HOME: f.home },
      { now: () => (now += 30_001) },
    );
    await expect(timed.resolve()).rejects.toThrow(/timed out/);
  });
});

async function heldSourceFixture(stage: string, failLate = false) {
  const f = await fixture();
  await fs.writeFile(path.join(f.home, "config.toml"), 'model = "synthetic"');
  const selected = await f.sources.resolve();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let released = false;
  let closes = 0;
  let held = false;
  const calls: string[] = [];
  const hold = async (name: string) => {
    calls.push(name);
    if (name === stage && !held) {
      held = true;
      enter();
      await gate;
      if (failLate) throw new Error("private delayed filesystem failure");
    }
  };
  const sources = new CodexStateSources(
    f.data,
    { CODEX_HOME: f.home },
    {
      fs: {
        ...fs,
        lstat: (async (...args: Parameters<typeof fs.lstat>) => {
          try {
            await hold("lstat");
            return await fs.lstat(...args);
          } finally {
            if (stage === "lstat" && released) finish();
          }
        }) as typeof fs.lstat,
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          const stat = handle.stat.bind(handle);
          const read = handle.read.bind(handle);
          const close = handle.close.bind(handle);
          handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
            await hold("file.stat");
            return stat(...args);
          }) as typeof handle.stat;
          handle.read = (async (...args: Parameters<typeof handle.read>) => {
            await hold("file.read");
            return read(...args);
          }) as typeof handle.read;
          handle.close = async () => {
            closes += 1;
            try {
              await close();
              await hold("file.close");
            } finally {
              finish();
            }
          };
          await hold("open");
          return handle;
        },
      },
    },
  );
  return {
    sources,
    entered,
    finished,
    calls,
    closes: () => closes,
    released: () => released,
    release: () => {
      released = true;
      releaseGate();
    },
    start: (signal?: AbortSignal) =>
      sources.readConfig(selected, signal),
  };
}
