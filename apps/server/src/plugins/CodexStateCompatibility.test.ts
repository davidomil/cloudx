import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storage from "../../../../scripts/managed-update-store.mjs";
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
    const launches = Array.from({ length: 10001 }, (_, index) => path.join(data, "codex-launches", `launch-${index}-${"x".repeat(40)}`));
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

  it("covers more than 16 retained schemas and more than 32 databases in one home", async () => {
    const f = await fixture();
    const data = path.join(f.root, "data");
    for (let index = 0; index < 17; index++) {
      const home = index ? path.join(data, "codex-launches", String(index)) : f.home;
      await fs.mkdir(home, { recursive: true });
      database(path.join(home, "state_5.sqlite"), `db.execute('CREATE TABLE generation_${index} (payload TEXT)')`);
    }
    for (let index = 0; index < 32; index++) database(path.join(f.home, `history_${index}.sqlite`));
    const snapshots = await f.compatibility.snapshots(f.home, data, f.destination);
    expect(snapshots).toHaveLength(17);
    expect((await fs.readdir(snapshots[0]!)).filter(name => name.endsWith(".sqlite"))).toHaveLength(33);
    for (const snapshot of snapshots) await expect(f.compatibility.verifyConversation(snapshot, "original")).resolves.toBeUndefined();
  });

  it("copies each transcript once while rewriting an indexed rollout path", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.home, "sessions"));
    for (const name of ["first", "second", "third"]) await fs.writeFile(path.join(f.home, "sessions", `${name}.jsonl`), name);
    execFileSync("python3", ["-I", "-S", "-c", `import pathlib, sqlite3, sys
home = pathlib.Path(sys.argv[1])
with sqlite3.connect(home / 'state_5.sqlite') as db:
 db.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
 db.execute('CREATE INDEX indexed_paths ON threads (rollout_path, id)')
 for name in ['first', 'second', 'third']:
  db.execute('INSERT INTO threads VALUES (?, ?)', (name, str(home / 'sessions' / (name + '.jsonl'))))
`, f.home]);
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    const transcripts = path.join(snapshot!, "retained-transcripts/state_5.sqlite");
    expect((await fs.readdir(transcripts)).length).toBe(3);
    expect((await Promise.all((await fs.readdir(transcripts)).map(name => fs.readFile(path.join(transcripts, name), "utf8")))).sort()).toEqual(["first", "second", "third"]);
    await expect(f.compatibility.verifyConversation(snapshot!, "first")).resolves.toBeUndefined();
  });

  it("rewrites indexed retained paths across batches when the SQLite writer cache spills", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination);
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    const result = execFileSync("python3", ["-I", "-S", "-c", `
import json, pathlib, runpy, sqlite3, sys
module = runpy.run_path(sys.argv[1])
home = pathlib.Path(sys.argv[2])
destination = pathlib.Path(sys.argv[3])
count = 2049
with sqlite3.connect(home / 'state_5.sqlite') as database:
 database.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
 database.execute('CREATE INDEX indexed_paths ON threads (rollout_path, id)')
 database.executemany('INSERT INTO threads VALUES (?, ?)', [
  ('' if index == 0 else f'{index:05}', str(home / 'sessions' / ('x' * 180 + str(index) + '.jsonl')))
  for index in range(count)
 ])
connect = sqlite3.connect
def small_cache(*args, **kwargs):
 kwargs['timeout'] = 0.2
 database = connect(*args, **kwargs)
 database.execute('PRAGMA cache_size=16')
 return database
module['sqlite3'].connect = small_cache
snapshot, = module['snapshot']([str(home)], str(destination))
with connect(pathlib.Path(snapshot) / 'state_5.sqlite') as database:
 rows = database.execute('SELECT id, rollout_path FROM threads').fetchall()
 assert len(rows) == count
 assert len({rollout for _, rollout in rows}) == count
 assert all(pathlib.Path(rollout).is_relative_to(pathlib.Path(snapshot)) for _, rollout in rows)
assert len(json.loads((pathlib.Path(snapshot) / 'retained-identities.json').read_text())['threads']['state_5.sqlite']) == count
assert module['verify'](snapshot, '') is True
with connect(home / 'state_5.sqlite') as database:
 assert all(pathlib.Path(rollout).is_relative_to(home) for rollout, in database.execute('SELECT rollout_path FROM threads'))
print('bounded indexed rewrite passed')
`, helper, f.home, f.destination], { encoding: "utf8", timeout: 20_000 });
    expect(result.trim()).toBe("bounded indexed rewrite passed");
  }, 30_000);

  it("accepts empty fresh state and rejects corrupt or symlinked databases without activation", async () => {
    const f = await fixture();
    expect(await f.compatibility.snapshots(f.home, undefined, f.destination)).toEqual([]);
    await fs.writeFile(path.join(f.home, "state_5.sqlite"), "not a database");
    await expect(f.compatibility.snapshots(f.home, undefined, `${f.destination}-corrupt`)).rejects.toThrow("snapshot preparation failed");
    expect(await fs.readdir(`${f.destination}-corrupt`)).toEqual([]);
    await fs.rm(path.join(f.home, "state_5.sqlite"));
    database(path.join(f.root, "private.sqlite"));
    await fs.symlink(path.join(f.root, "private.sqlite"), path.join(f.home, "state_5.sqlite"));
    await expect(f.compatibility.snapshots(f.home, undefined, `${f.destination}-link`)).rejects.toThrow("snapshot preparation failed");
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
source = pathlib.Path(sys.argv[5])
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

  it("rejects invalid directory input in the Python helper", async () => {
    const f = await fixture();
    const input = path.join(f.root, "directories.json");
    await fs.writeFile(input, '[42]');
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    expect(() => execFileSync("python3", ["-I", "-S", helper, "snapshot", input, f.destination, "0"], { stdio: "pipe" })).toThrow('"code": "directory-list"');
    await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights all retained databases, including WAL pages, before copying", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination);
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    const result = execFileSync("python3", ["-I", "-S", "-c", `
import pathlib, runpy, sqlite3, sys, types
module = runpy.run_path(sys.argv[1])
module["os"].statvfs = lambda _: types.SimpleNamespace(f_bavail=50000, f_frsize=1)
home = pathlib.Path(sys.argv[2])
db = sqlite3.connect(home / "state_5.sqlite")
db.execute("PRAGMA page_size=16384")
db.execute("PRAGMA journal_mode=WAL")
db.execute("CREATE TABLE threads (id TEXT, payload TEXT)")
db.execute("INSERT INTO threads VALUES ('retained', ?)", ('x' * 40000,))
db.commit()
assert (home / "state_5.sqlite").stat().st_size < 50000
try:
 module["snapshot"]([str(home)], sys.argv[3])
except module["SnapshotPreparationError"] as error:
 assert error.code == "disk-space"
 assert error.observed_bytes > error.limit_bytes == 50000
 assert list(pathlib.Path(sys.argv[3]).iterdir()) == []
 print("capacity checked")
else:
 raise AssertionError("WAL contents bypassed capacity preflight")
finally:
 db.close()
`, helper, f.home, f.destination], { encoding: "utf8" });
    expect(result.trim()).toBe("capacity checked");
  });

  it("copies retained history larger than the former 1 GiB limit without changing the source", async () => {
    const f = await fixture();
    const original = path.join(f.home, "thread_history_1.sqlite");
    database(original, "db.execute(\"CREATE TABLE history (payload TEXT)\"); db.execute(\"INSERT INTO history VALUES ('retained history')\")");
    const retainedBytes = await fs.readFile(original);
    await fs.truncate(original, 1_313_394_688);

    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);

    expect((await fs.stat(original)).size).toBe(1_313_394_688);
    const source = await fs.open(original, "r");
    try {
      const prefix = Buffer.alloc(retainedBytes.length);
      await source.read(prefix, 0, prefix.length, 0);
      expect(prefix).toEqual(retainedBytes);
    } finally { await source.close(); }
    for (const file of [original, path.join(snapshot!, "thread_history_1.sqlite")]) {
      execFileSync("python3", ["-I", "-S", "-c", "import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: assert db.execute('SELECT payload FROM history').fetchone() == ('retained history',)", file]);
    }
  });

  it("accepts databases above 8 GiB when their logical backup fits destination capacity", async () => {
    const f = await fixture();
    const original = path.join(f.home, "state_5.sqlite");
    database(original);
    await fs.truncate(original, 8 * 1024 ** 3 + 1);
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    await expect(f.compatibility.verifyConversation(snapshot!, "original")).resolves.toBeUndefined();
    expect((await fs.stat(original)).size).toBe(8 * 1024 ** 3 + 1);
  });

  it.runIf(process.env.CLOUDX_LARGE_SNAPSHOT_TEST === "1")("copies and verifies retained transcripts above 8 GiB with bounded memory", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.home, "sessions"));
    const original = path.join(f.home, "sessions", "retained.jsonl");
    await fs.writeFile(original, '{"retained":true}\n');
    const size = 8 * 1024 ** 3 + 1;
    await fs.truncate(original, size);
    execFileSync("python3", ["-I", "-S", "-c", `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")
 db.execute("INSERT INTO threads VALUES ('original', ?)", (sys.argv[2],))
`, path.join(f.home, "state_5.sqlite"), original]);
    const output: string[] = [];
    const compatibility = new CodexStateCompatibility({ PATH: process.env.PATH }, undefined, text => output.push(text));
    const [snapshot] = await compatibility.snapshots(f.home, undefined, f.destination);
    expect((await fs.stat(path.join(snapshot!, "retained-transcripts/state_5.sqlite/0.jsonl"))).size).toBe(size);
    await expect(compatibility.verifyConversation(snapshot!, "original")).resolves.toBeUndefined();
    expect((await fs.stat(original)).size).toBe(size);
    expect(output.join("")).toContain("bytes copied");
  }, 180_000);

  it("rejects a destination quota shortfall before creating a copied database", async () => {
    const f = await fixture();
    for (const name of ["state_5.sqlite", "thread_history_1.sqlite"]) database(path.join(f.home, name), "db.execute('CREATE TABLE payload (data BLOB)'); db.execute('INSERT INTO payload VALUES (zeroblob(20000))')");
    const capacity = vi.spyOn(storage, "filesystemCapacity").mockReturnValue({ availableBytes: 50000, availableInodes: Infinity, blockSize: 4096, quotaStatus: "user checked" });
    try {
      const failure = await f.compatibility.snapshots(f.home, undefined, f.destination).catch(error => error);
      expect(failure.diagnostic).toMatchObject({ code: "disk-space", limitBytes: 50000 });
      expect(failure.diagnostic.observedBytes).toBeGreaterThan(50000);
      expect(await fs.readdir(f.destination)).toEqual([]);
    } finally { capacity.mockRestore(); }
  });

  it("preflights inode quota for snapshots and pristine copies", async () => {
    const f = await fixture();
    database(path.join(f.home, "state_5.sqlite"));
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    const realCapacity = storage.filesystemCapacity(f.root);
    const capacity = vi.spyOn(storage, "filesystemCapacity").mockReturnValue({ ...realCapacity, availableInodes: 0 });
    try {
      const failure = await f.compatibility.snapshots(f.home, undefined, `${f.destination}-no-inodes`).catch(error => error);
      expect(failure.diagnostic).toMatchObject({ code: "disk-inodes", availableInodes: 0 });
      expect(failure.diagnostic.requiredInodes).toBeGreaterThan(0);
      expect(await fs.readdir(`${f.destination}-no-inodes`)).toEqual([]);
      await expect(f.compatibility.preserveSnapshot(snapshot!, path.join(f.root, "no-inodes"))).rejects.toMatchObject({ diagnostic: { code: "disk-inodes", availableInodes: 0 } });
      await expect(fs.stat(path.join(f.root, "no-inodes"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { capacity.mockRestore(); }
  });

  it("checks available disk space before copying retained state", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination);
    const file = path.join(f.home, "state_5.sqlite");
    database(file);
    const before = await fs.readFile(file);
    const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));
    const result = execFileSync("python3", ["-I", "-S", "-c", `
import json, runpy, sys, types
module = runpy.run_path(sys.argv[1])
module["os"].statvfs = lambda _: types.SimpleNamespace(f_bavail=0, f_frsize=4096)
try:
 module["snapshot"]([sys.argv[2]], sys.argv[3])
except module["SnapshotPreparationError"] as error:
 print(json.dumps(error.diagnostic()))
else:
 raise AssertionError("Snapshot bypassed disk-space preflight")
`, helper, f.home, f.destination], { encoding: "utf8" });
    expect(JSON.parse(result)).toMatchObject({ stage: "snapshot", code: "disk-space", limitBytes: 0 });
    expect(JSON.parse(result).observedBytes).toBeGreaterThanOrEqual(before.length);
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(f.destination)).toEqual([]);
  });

  it("keeps private configuration and raw subprocess failures out of preparation diagnostics", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.home, "config.toml"), "private-secret = [invalid-private-secret");
    const failure = await f.compatibility.snapshots(f.home, undefined, f.destination).catch(error => error);
    expect(failure.diagnostic).toEqual({ stage: "snapshot", code: "configuration" });
    expect(failure.message).toContain("snapshot preparation failed");
    expect(failure.message).not.toContain("private-secret");
    await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a pristine baseline and treats baseline copy failures as preparation errors", async () => {
    const f = await fixture();
    database(path.join(f.home, "state_5.sqlite"));
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    const pristine = path.join(f.root, "pristine");
    await f.compatibility.preserveSnapshot(snapshot!, pristine);
    await expect(f.compatibility.verifyConversation(pristine, "original")).resolves.toBeUndefined();
    const copy = vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error("private-secret"), { code: "ENOSPC" }));
    try {
      const failure = await f.compatibility.preserveSnapshot(snapshot!, path.join(f.root, "no-space")).catch(error => error);
      expect(failure.diagnostic).toEqual({ stage: "snapshot", code: "disk-full" });
      expect(failure.message).toContain("disk space");
      expect(failure.message).not.toContain("private-secret");
    } finally { copy.mockRestore(); }
  });

  it("checks space for the pristine baseline before beginning a copy", async () => {
    const f = await fixture();
    database(path.join(f.home, "state_5.sqlite"));
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    const statfs = vi.spyOn(storage, "filesystemCapacity").mockReturnValue({ availableBytes: 0, availableInodes: Infinity, blockSize: 4096, quotaStatus: "user checked" });
    try {
      await expect(f.compatibility.preserveSnapshot(snapshot!, path.join(f.root, "no-space"))).rejects.toMatchObject({ diagnostic: { stage: "snapshot", code: "disk-space", limitBytes: 0 } });
      await expect(fs.stat(path.join(f.root, "no-space"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { statfs.mockRestore(); }
  });

  it("cancels pristine preservation between streamed writes", async () => {
    const f = await fixture();
    database(path.join(f.home, "state_5.sqlite"));
    const [snapshot] = await f.compatibility.snapshots(f.home, undefined, f.destination);
    const controller = new AbortController();
    const compatibility = new CodexStateCompatibility({ PATH: process.env.PATH }, controller.signal, () => controller.abort());
    await expect(compatibility.preserveSnapshot(snapshot!, path.join(f.root, "cancelled-pristine"))).rejects.toMatchObject({ name: "AbortError" });
    await expect(f.compatibility.verifyConversation(snapshot!, "original")).resolves.toBeUndefined();
  });
});
