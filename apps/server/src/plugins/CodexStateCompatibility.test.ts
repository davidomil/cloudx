import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexStateCompatibility } from "./CodexStateCompatibility.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-state-compatibility-"));
  roots.push(root);
  const home = path.join(root, "home");
  await fs.mkdir(home);
  return { root, home, destination: path.join(root, "snapshots"), compatibility: new CodexStateCompatibility({ PATH: process.env.PATH, HOME: root }) };
}
function database(file: string, extra = "") {
  execFileSync("python3", ["-I", "-S", "-c", `import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute('CREATE TABLE threads (id TEXT PRIMARY KEY)')\n db.execute(\"INSERT INTO threads VALUES ('original')\")\n ${extra || 'pass'}`, file]);
}

describe("isolated Codex shared-state compatibility", () => {
  it("copies retained databases and verifies conversation writes without changing the original", async () => {
    const f = await fixture();
    const original = path.join(f.home, "state_5.sqlite");
    database(original);
    const before = await fs.readFile(original);
    await fs.writeFile(path.join(f.home, "auth.json"), "never-copy-auth");
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    expect(snapshot).toBeDefined();
    expect(await fs.readdir(snapshot!)).toEqual(["retained-identities.json", "state_5.sqlite"]);
    await expect(f.compatibility.verifyConversation(snapshot!, "original")).resolves.toBeUndefined();
    await expect(f.compatibility.verifyConversation(snapshot!, "missing")).rejects.toThrow("shared-state compatibility verification failed");
    execFileSync("python3", ["-I", "-S", "-c", "import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute('DELETE FROM threads')", path.join(snapshot!, "state_5.sqlite")]);
    execFileSync("python3", ["-I", "-S", "-c", "import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.execute(\"INSERT INTO threads VALUES ('new-native-session')\")", path.join(snapshot!, "state_5.sqlite")]);
    await expect(f.compatibility.verifyConversation(snapshot!, "new-native-session")).rejects.toThrow("shared-state compatibility verification failed");
    expect(await fs.readFile(original)).toEqual(before);
    expect((await fs.stat(path.join(snapshot!, "state_5.sqlite"))).mode & 0o777).toBe(0o600);
  });

  it("covers custom sqlite_home and each distinct retained launch schema", async () => {
    const f = await fixture();
    const shared = path.join(f.root, "custom-sqlite");
    const data = path.join(f.root, "data");
    const launch = path.join(data, "codex-launches", "tab");
    const duplicate = path.join(data, "codex-launches", "duplicate");
    await Promise.all([shared, launch, duplicate].map(directory => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(f.home, "config.toml"), 'sqlite_home = "../custom-sqlite"\n');
    database(path.join(shared, "state_5.sqlite"));
    database(path.join(launch, "state_5.sqlite"), "db.execute('ALTER TABLE threads ADD COLUMN future_version TEXT')");
    database(path.join(duplicate, "state_5.sqlite"));
    expect(await f.compatibility.snapshots(f.home, data, f.destination)).toHaveLength(2);
  });

  it("snapshots retained launches when their directory list exceeds the operating system argument limit", async () => {
    const f = await fixture();
    const data = path.join(f.root, "data");
    const launches = Array.from({ length: 1500 }, (_, index) => path.join(data, "codex-launches", `launch-${index}-${"x".repeat(40)}`));
    expect(launches.length).toBeLessThan(10_000);
    expect(Buffer.byteLength(JSON.stringify([f.home, ...launches]))).toBeGreaterThan(128 * 1024);
    await Promise.all(launches.map(directory => fs.mkdir(directory, { recursive: true })));
    const original = path.join(launches.at(-1)!, "state_5.sqlite");
    database(original);
    const before = await fs.readFile(original);

    const snapshots = await f.compatibility.snapshots(f.home, data, f.destination);

    expect(snapshots).toHaveLength(1);
    await expect(f.compatibility.verifyConversation(snapshots[0]!, "original")).resolves.toBeUndefined();
    expect(await fs.readFile(original)).toEqual(before);
    expect(await fs.readdir(f.destination)).toEqual(["0"]);
  });

  it("preserves identities and distinct transcripts in every retained database generation", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.home, "sessions"));
    for (const generation of [4, 5]) {
      const transcript = path.join(f.home, "sessions", `${generation}.jsonl`);
      await fs.writeFile(transcript, JSON.stringify({ generation }));
      execFileSync("python3", ["-I", "-S", "-c", `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
 db.execute('INSERT INTO threads VALUES (?, ?)', (sys.argv[2], sys.argv[3]))
`, path.join(f.home, `state_${generation}.sqlite`), `retained-${generation}`, transcript]);
    }
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    for (const generation of [4, 5]) {
      expect(await fs.readFile(path.join(snapshot!, "retained-transcripts", `state_${generation}.sqlite`, "0.jsonl"), "utf8")).toBe(JSON.stringify({ generation }));
    }
    execFileSync("python3", ["-I", "-S", "-c", `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db: db.execute("INSERT INTO threads VALUES ('new-native-session', 'isolated-new-rollout')")
`, path.join(snapshot!, "state_5.sqlite")]);
    await expect(f.compatibility.verifyConversation(snapshot!, "new-native-session")).resolves.toBeUndefined();
    await fs.rm(path.join(snapshot!, "state_4.sqlite"));
    await expect(f.compatibility.verifyConversation(snapshot!, "new-native-session")).rejects.toThrow("shared-state compatibility verification failed");
  });

  it("accepts empty fresh state and rejects corrupt or symlinked databases without activation", async () => {
    const f = await fixture();
    expect(await f.compatibility.snapshots(f.home, undefined, f.destination)).toEqual([]);
    await fs.writeFile(path.join(f.home, "state_5.sqlite"), "not a database");
    await expect(f.compatibility.snapshots(f.home, undefined, `${f.destination}-corrupt`)).rejects.toThrow("shared-state compatibility verification failed");
    expect(await fs.readdir(`${f.destination}-corrupt`)).toEqual([]);
    await fs.rm(path.join(f.home, "state_5.sqlite"));
    database(path.join(f.root, "private.sqlite"));
    await fs.symlink(path.join(f.root, "private.sqlite"), path.join(f.home, "state_5.sqlite"));
    await expect(f.compatibility.snapshots(f.home, undefined, `${f.destination}-link`)).rejects.toThrow("shared-state compatibility verification failed");
  });

  it("checks the shared SQLite environment override and rejects ambiguous relative overrides", async () => {
    const f = await fixture();
    const overridden = path.join(f.root, "overridden-state ");
    await fs.mkdir(overridden);
    database(path.join(overridden, "state_5.sqlite"));
    const env = { PATH: process.env.PATH, CODEX_SQLITE_HOME: overridden };
    expect(await new CodexStateCompatibility(env).snapshots(f.home, undefined, f.destination)).toHaveLength(1);
    await expect(new CodexStateCompatibility({ ...env, CODEX_SQLITE_HOME: "relative" }).snapshots(f.home, undefined, `${f.destination}-relative`)).rejects.toThrow("CODEX_SQLITE_HOME must be absolute");
  });

  it("rejects invalid sqlite_home and cancelled checks", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.home, "config.toml"), "sqlite_home = 42\n");
    await expect(f.compatibility.snapshots(f.home, undefined, f.destination)).rejects.toThrow("sqlite_home must be a string");
    await fs.rm(path.join(f.home, "config.toml"));
    const controller = new AbortController();
    controller.abort();
    await expect(new CodexStateCompatibility({ PATH: process.env.PATH }, controller.signal).snapshots(f.home, undefined, `${f.destination}-cancelled`)).rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(`${f.destination}-cancelled`)).toEqual([]);
  });

  it("keeps the directory list private and removes it when an active helper is cancelled", async () => {
    const f = await fixture();
    const bin = path.join(f.root, "bin");
    const ready = path.join(f.root, "helper-ready");
    const python = execFileSync("python3", ["-I", "-S", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "python3"), `#!${python}
import json, os, pathlib, sys, time
source = pathlib.Path(sys.argv[-2])
assert source.stat().st_mode & 0o777 == 0o600
assert source.parent.stat().st_mode & 0o777 == 0o700
assert json.loads(source.read_text()) == [${JSON.stringify(f.home)}]
pathlib.Path(${JSON.stringify(ready)}).write_text(str(os.getpid()))
time.sleep(30)
`, { mode: 0o700 });
    const controller = new AbortController();
    const compatibility = new CodexStateCompatibility({ PATH: bin }, controller.signal);
    const cancelled = expect(compatibility.snapshots(f.home, undefined, f.destination)).rejects.toMatchObject({ name: "AbortError" });
    try {
      await vi.waitFor(async () => expect(await fs.readFile(ready, "utf8")).toMatch(/^\d+$/));
    } finally {
      controller.abort();
    }
    await cancelled;
    expect(await fs.readdir(f.destination)).toEqual([]);
    const pid = Number(await fs.readFile(ready, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("rejects oversized directory input before creating snapshots", async () => {
    const f = await fixture();
    const compatibility = new CodexStateCompatibility({ CODEX_SQLITE_HOME: `/${"x".repeat(16_777_216)}` });
    await expect(compatibility.snapshots(f.home, undefined, f.destination)).rejects.toThrow("directory list exceeds the 16 MiB limit");
    await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["oversized", "too-many", "invalid-type"])("rejects %s directory input in the Python helper", async kind => {
    const f = await fixture();
    const input = path.join(f.root, "directories.json");
    await fs.writeFile(input, kind === "invalid-type" ? '[42]' : JSON.stringify(Array(10004).fill(f.home)));
    if (kind === "oversized") await fs.truncate(input, 16_777_217);
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    expect(() => execFileSync("python3", ["-I", "-S", helper, "snapshot", input, f.destination], { stdio: "pipe" })).toThrow("Codex shared-state compatibility check failed");
    await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts WAL pages and the actual SQLite page size against the snapshot budget", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination);
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    const result = execFileSync("python3", ["-I", "-S", "-c", `
import pathlib, runpy, sqlite3, sys
snapshot = runpy.run_path(sys.argv[1])["snapshot"]
snapshot.__globals__["MAX_BYTES"] = 50000
home = pathlib.Path(sys.argv[2])
db = sqlite3.connect(home / "state_5.sqlite")
db.execute("PRAGMA page_size=16384")
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE threads (id TEXT, payload TEXT)")
db.execute("INSERT INTO threads VALUES ('retained', ?)", ('x' * 40000,))
db.commit()
assert (home / "state_5.sqlite").stat().st_size < 50000
try:
 snapshot([str(home)], sys.argv[3])
except ValueError as error:
 assert "1 GiB limit" in str(error)
 print("bounded")
else:
 raise AssertionError("WAL contents bypassed the snapshot limit")
finally:
 db.close()
`, helper, f.home, f.destination], { encoding: "utf8" });
    expect(result.trim()).toBe("bounded");
  });
});
