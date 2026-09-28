import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
