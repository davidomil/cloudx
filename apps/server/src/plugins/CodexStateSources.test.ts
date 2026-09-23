import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexStateSources } from "./CodexStateSources.js";
import { DirectoryOwnershipReconciler } from "../directoryOwnershipReconciliation.js";

vi.mock("../filesystemIdentity.js", () => ({ filesystemIdentity: async () => ({ filesystemType: "ef53", filesystemId: "f00d1234" }) }));

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

describe("durable Codex source ownership", () => {
  it("keeps the bound shared source after device renumbering with matching filesystem evidence", async () => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("durable", source);
    await fs.writeFile(path.join(view, ".cloudx-source.json"), JSON.stringify({ version: 1, ...source, dev: "1" }));
    await expect(f.sources.readBinding("durable")).resolves.toEqual(source);
    await expect(f.sources.assertCurrent({ ...source, dev: "1" })).resolves.toBeUndefined();
    await f.sources.dispose();
  });

  it("requires reviewed evidence to upgrade a blocked legacy binding and rejects stale previews", async () => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("legacy", source);
    const bindingPath = path.join(view, ".cloudx-source.json");
    const legacy = { version: 1, sourceId: source.sourceId, home: source.home, ino: source.ino, dev: "1" };
    await fs.writeFile(bindingPath, JSON.stringify(legacy));
    await expect(f.sources.readBinding("legacy")).rejects.toThrow(/device changed from 1.*reconcile/);
    const preview = await f.sources.previewOwnership("legacy");
    await expect(f.sources.reconcileOwnership("legacy", { fingerprint: preview.fingerprint, attestations: [] })).rejects.toThrow(/Confirm that saved device 1/);
    expect(JSON.parse(await fs.readFile(bindingPath, "utf8"))).toEqual(legacy);
    await expect(f.sources.reconcileOwnership("legacy", { fingerprint: "0".repeat(64), attestations: preview.directories })).rejects.toThrow(/changed after inspection/);
    const rename = vi.spyOn(fs, "rename");
    await f.sources.reconcileOwnership("legacy", { fingerprint: preview.fingerprint, attestations: preview.directories });
    expect(rename).toHaveBeenCalledOnce();
    const [staging, committedBinding] = rename.mock.calls[0]!.map(String);
    expect(staging).toMatch(/^\/proc\/self\/fd\/\d+\/\.cloudx-binding-.*\.tmp$/u);
    expect(committedBinding).toBe(path.join(path.dirname(staging!), ".cloudx-source.json"));
    await expect(f.sources.readBinding("legacy")).resolves.toEqual(source);
    expect(JSON.parse(await fs.readFile(bindingPath, "utf8"))).toMatchObject({ ...source, durable: source.durable });
    expect((await fs.stat(bindingPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(view)).toEqual([".cloudx-source.json"]);
    await f.sources.dispose();
  });

  it("does not permit attestation to override known filesystem replacement", async () => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("changed", source);
    await fs.writeFile(path.join(view, ".cloudx-source.json"), JSON.stringify({ version: 1, ...source, durable: { ...source.durable!, filesystemId: "ffff" } }));
    await expect(f.sources.previewOwnership("changed")).rejects.toThrow(/ownership changed/);
    await expect(f.sources.readBinding("changed")).rejects.toThrow(/ownership changed/);
    await f.sources.dispose();
  });

  it.each(["after inspection", "before writing", "during final binding read", "while staging binding"])("preserves a replaced launch directory %s instead of reconciling into it", async stage => {
    const f = await fixture();
    const source = await f.sources.resolve();
    const view = await f.sources.bind("replaced-view", source);
    const binding = path.join(view, ".cloudx-source.json");
    const legacy = { version: 1, sourceId: source.sourceId, home: source.home, ino: source.ino, dev: "1" };
    await fs.writeFile(binding, JSON.stringify(legacy));
    await fs.mkdir(path.join(f.home, "sessions"));
    await fs.symlink(path.join(f.home, "sessions"), path.join(view, "sessions"));
    const preview = await f.sources.previewOwnership("replaced-view");
    const replaceView = async () => {
      await fs.rename(view, `${view}-retained`);
      await fs.mkdir(view);
      await fs.writeFile(binding, JSON.stringify(legacy));
    };
    if (stage === "after inspection") await replaceView();
    else if (stage === "before writing") {
      const assertCurrent = DirectoryOwnershipReconciler.prototype.assertCurrent;
      vi.spyOn(DirectoryOwnershipReconciler.prototype, "assertCurrent").mockImplementationOnce(async function (this: DirectoryOwnershipReconciler) {
        await assertCurrent.call(this);
        await replaceView();
      });
    } else {
      const open = fs.open;
      let bindingReads = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (stage === "during final binding read" && path.basename(String(args[0])) === ".cloudx-source.json" && ++bindingReads === 2)
          await replaceView();
        const handle = await open(...args);
        if (stage === "while staging binding" && String(args[0]).endsWith(".tmp")) {
          const writeFile = handle.writeFile.bind(handle);
          handle.writeFile = async (...writeArgs) => {
            await writeFile(...writeArgs);
            await replaceView();
          };
        }
        return handle;
      });
    }

    await expect(f.sources.reconcileOwnership("replaced-view", { fingerprint: preview.fingerprint, attestations: preview.directories }))
      .rejects.toThrow(stage === "after inspection" ? /changed after inspection/ : /Codex launch ownership changed/);
    expect(JSON.parse(await fs.readFile(binding, "utf8"))).toEqual(legacy);
    expect(JSON.parse(await fs.readFile(path.join(`${view}-retained`, ".cloudx-source.json"), "utf8"))).toEqual(legacy);
    expect(await fs.readdir(view)).toEqual([".cloudx-source.json"]);
    expect(await fs.readdir(`${view}-retained`)).toEqual([".cloudx-source.json", "sessions"]);
    expect(await fs.realpath(path.join(`${view}-retained`, "sessions"))).toBe(path.join(f.home, "sessions"));
    await f.sources.dispose();
  });
});
