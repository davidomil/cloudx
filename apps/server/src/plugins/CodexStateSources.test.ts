import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexStateSources, legacySourceId } from "./CodexStateSources.js";

const roots: string[] = [];
afterEach(async () => {
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
  it("lists separate owners from bounded generated headings and resolves directly without scanning", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.legacy, "AGENTS.override.md"),
      "# CloudX Codex Session Instructions\n\n## CloudX Template: Review\n\nprivate content\n",
    );
    await fs.mkdir(path.join(f.data, "codex-homes", "old-b"));
    const result = await f.sources.list();
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({
      sourceId: "shared",
      kind: "shared",
      label: "Shared sessions",
    });
    expect(
      result.sources.find(
        (source) => source.sourceId === legacySourceId("old-a"),
      )?.label,
    ).toBe("Review");
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(JSON.stringify(result)).not.toContain(f.home);
    const scan = vi.spyOn(fs, "opendir");
    expect((await f.sources.resolve(legacySourceId("old-a"))).home).toBe(
      await fs.realpath(f.legacy),
    );
    expect(scan).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "../old-a",
    "legacy:Li4",
    "legacy:Lw",
    "legacy:XA",
    "legacy:wA",
    "legacy:b2xkLWE=",
    "legacy:b2xkLWF",
    "legacy:AA",
    "legacy:Li",
  ])("rejects noncanonical or escaped source %s", async (key) => {
    const f = await fixture();
    await expect(f.sources.resolve(key)).rejects.toThrow();
  });

  it("binds one canonical owner and rejects conflicting, missing, corrupt and stale bindings", async () => {
    const f = await fixture();
    const source = await f.sources.resolve(legacySourceId("old-a"));
    const view = await f.sources.bind("tab-1", source);
    expect(view).toContain("codex-launches/tab-1");
    expect(await f.sources.readBinding("tab-1")).toEqual(source);
    await expect(
      f.sources.bind("tab-1", await f.sources.resolve("shared")),
    ).rejects.toThrow(/conflict/i);
    await fs.rename(f.legacy, `${f.legacy}-retained`);
    await fs.mkdir(f.legacy);
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(
      /changed|stale/i,
    );
    await fs.writeFile(path.join(view, ".cloudx-source.json"), "{}");
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(/binding/i);
    await fs.unlink(path.join(view, ".cloudx-source.json"));
    await expect(f.sources.readBinding("tab-1")).rejects.toThrow(/binding/i);
    await expect(f.sources.bind("../escape", source)).rejects.toThrow();
  });

  it("preserves correct-owner wide permissions but rejects wrong UID and symlink homes or roots", async () => {
    const f = await fixture();
    await fs.chmod(f.legacy, 0o777);
    await f.sources.resolve(legacySourceId("old-a"));
    expect((await fs.stat(f.legacy)).mode & 0o777).toBe(0o777);
    await expect(
      new CodexStateSources(
        f.data,
        { CODEX_HOME: f.home },
        { uid: () => -1 },
      ).resolve("shared"),
    ).rejects.toThrow(/owner/i);
    await fs.symlink(f.home, path.join(f.data, "codex-homes", "alias"));
    await expect(f.sources.resolve(legacySourceId("alias"))).rejects.toThrow();
    await fs.rename(
      path.join(f.data, "codex-homes"),
      path.join(f.data, "saved-homes"),
    );
    await fs.symlink(
      path.join(f.data, "saved-homes"),
      path.join(f.data, "codex-homes"),
    );
    await expect(f.sources.list()).rejects.toThrow();
  });

  it("rejects oversized config, cap overflow, and broken history without opening SQLite", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.legacy, "config.toml"),
      "x".repeat(1_048_577),
    );
    await expect(
      f.sources.readConfig(await f.sources.resolve(legacySourceId("old-a"))),
    ).rejects.toThrow(/limit/i);
    await fs.unlink(path.join(f.legacy, "config.toml"));
    await fs.symlink(
      path.join(f.root, "absent"),
      path.join(f.legacy, "sessions"),
    );
    await expect(f.sources.resolve(legacySourceId("old-a"))).rejects.toThrow();
    await fs.unlink(path.join(f.legacy, "sessions"));
    await Promise.all(
      Array.from({ length: 512 }, (_, i) =>
        fs.mkdir(path.join(f.data, "codex-homes", `source-${i}`)),
      ),
    );
    await expect(f.sources.list()).rejects.toThrow(/512/);
  });

  it("cancels request admission and shutdown without accepting late work", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    const open = vi.spyOn(fs, "open");
    await expect(f.sources.list(controller.signal)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await f.sources.dispose();
    await expect(f.sources.list()).rejects.toThrow();
  });

  it("bounds heading prefixes and has at most four metadata handles in flight", async () => {
    const f = await fixture();
    for (let index = 0; index < 8; index += 1) {
      const home = path.join(f.data, "codex-homes", `bounded-${index}`);
      await fs.mkdir(home);
      await fs.writeFile(
        path.join(home, "AGENTS.override.md"),
        "# CloudX Codex Session Instructions\n" +
          "x".repeat(20_000) +
          "\n## CloudX Template: Hidden beyond cap\n",
      );
    }
    let active = 0;
    let peak = 0;
    let closed = 0;
    const sizes: number[] = [];
    const sources = new CodexStateSources(
      f.data,
      { CODEX_HOME: f.home },
      {
        fs: {
          ...fs,
          open: async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args);
            active += 1;
            peak = Math.max(peak, active);
            const originalRead = handle.read.bind(handle);
            const originalClose = handle.close.bind(handle);
            handle.read = (async (
              ...readArgs: Parameters<typeof handle.read>
            ) => {
              sizes.push((readArgs[0] as unknown as Buffer).byteLength);
              return originalRead(...readArgs);
            }) as typeof handle.read;
            handle.close = async () => {
              closed += 1;
              active -= 1;
              await originalClose();
            };
            return handle;
          },
        },
      },
    );
    const result = await sources.list();
    expect(result.sources).toHaveLength(10);
    expect(JSON.stringify(result)).not.toContain("Hidden beyond cap");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(closed).toBe(8);
    expect(active).toBe(0);
    expect(sizes).toEqual(Array(8).fill(16 * 1024));
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

  it("keeps unbound retained tab restarts explicit and observes request deadlines", async () => {
    const f = await fixture();
    await expect(f.sources.readBinding("old-a")).rejects.toThrow(
      /explicit session source/,
    );
    let now = 0;
    const timed = new CodexStateSources(
      f.data,
      { CODEX_HOME: f.home },
      { now: () => (now += 30_001) },
    );
    await expect(timed.list()).rejects.toThrow(/timed out/);
  });
});
