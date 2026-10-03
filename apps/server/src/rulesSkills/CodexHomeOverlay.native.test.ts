import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppServerClient, StdioAppServerTransport } from "../appServer/AppServerClient.js";
import { materializeCodexTemplate } from "../plugins/CodexTerminalPlugin.js";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import type { ResolvedPersonalityTemplate } from "./RulesSkillsCatalogService.js";

const codex = process.env.CLOUDX_NATIVE_CODEX;

it.skipIf(!codex)("discovers the exact selected/system/default catalog without traversing dependencies and keeps canonical resources usable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-skills-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex };
  const sources = new CodexStateSources(data, env);
  const skill = path.join(data, "rules-skills/skills/dependency-heavy");
  const builtin = path.join(home, "skills/.system/imagegen");
  const resolved: ResolvedPersonalityTemplate = {
    source: "tab", template: { id: "test", name: "Test", color: "green", ruleIds: [], skillIds: ["dependency-heavy"] }, rules: [],
    skills: [{ id: "dependency-heavy", name: "Dependency heavy", description: "Exercise bounded discovery.", scope: "user" }]
  };
  const children: Array<{ client: AppServerClient; stopped: Promise<unknown> }> = [];
  try {
    await fs.mkdir(cwd, { recursive: true });
    for (const source of [skill, builtin]) {
      await fs.mkdir(path.join(source, "scripts"), { recursive: true });
      await fs.mkdir(path.join(source, "assets"));
      await fs.mkdir(path.join(source, "references"));
      await fs.mkdir(path.join(source, "agents"));
      await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${path.basename(source)}\ndescription: Exercise bounded discovery.\n---\nRun scripts/check.cjs and read references/guide.md.\n`);
      await fs.writeFile(path.join(source, "agents/openai.yaml"), 'interface:\n  display_name: "Bounded skill"\n  short_description: "Exercise bounded discovery"\n  icon_small: "./assets/icon.svg"\npolicy:\n  allow_implicit_invocation: false\n');
      await fs.writeFile(path.join(source, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await fs.writeFile(path.join(source, "references/guide.md"), "Original reference");
      await fs.mkdir(path.join(source, "node_modules/runtime"), { recursive: true });
      await fs.writeFile(path.join(source, "node_modules/runtime/index.js"), 'module.exports = "runtime available";');
      await fs.writeFile(path.join(source, "scripts/check.cjs"), 'console.log(require("runtime") + ": " + require("fs").readFileSync(require("path").join(__dirname, "../references/guide.md"), "utf8"));');
    }
    // More directories than the native 2,000-directory budget, including a dependency-owned skill.
    for (let offset = 0; offset < 2100; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, async (_, index) => {
        const dir = path.join(skill, "node_modules", `dependency-${offset + index}`);
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");
      }));
    }
    await fs.writeFile(path.join(skill, "node_modules/dependency-0/SKILL.md"), "---\nname: unwanted\ndescription: Dependency owned.\n---\n");
    await fs.mkdir(path.join(skill, ".venv/lib"), { recursive: true });
    await fs.writeFile(path.join(skill, ".venv/lib/SKILL.md"), "---\nname: unwanted-env\ndescription: Environment owned.\n---\n");
    await fs.writeFile(path.join(home, "config.toml"), 'model_provider = "synthetic"\n[model_providers.synthetic]\nname = "No model calls"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');

    const inspect = async (tabId: string, resetCodexHome = true) => {
      const launch = await materializeCodexTemplate(resolved, env, { dataDir: data, sources, tabId, cwd, resetOverlay: resetCodexHome });
      const overlay = launch.overlay!;
      // No directory links may let native discovery walk into the source trees.
      const entries = await fs.readdir(path.join(overlay.codexHome, "skills"), { recursive: true });
      expect(entries.length).toBeLessThan(50);
      for (const entry of entries) {
        const file = path.join(overlay.codexHome, "skills", entry);
        if ((await fs.lstat(file)).isSymbolicLink()) expect((await fs.stat(file)).isFile()).toBe(true);
      }
      const stderrPath = path.join(root, `${tabId}.stderr`);
      const log = await fs.open(stderrPath, "w");
      const native = spawn(codex!, ["app-server", "--listen", "stdio://"], { cwd, env: { ...env, ...launch.env }, stdio: ["pipe", "pipe", log.fd] });
      await log.close();
      const stopped = new Promise(resolve => native.once("close", resolve));
      const transport = new StdioAppServerTransport({ process: native as ChildProcessByStdio<Writable, Readable, null>, stop: () => { native.kill("SIGKILL"); } });
      const client = new AppServerClient(transport);
      children.push({ client, stopped });
      await client.initialize();
      const inventory = await client.request("skills/list", { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: Array<{ name: string; path: string; interface: { displayName: string; iconSmall: string } }>; errors: unknown[] }> };
      expect(inventory.data).toHaveLength(1);
      expect(inventory.data[0].errors).toEqual([]);
      const expectedPaths = overlay.skillPaths;
      expect(inventory.data[0].skills.map(item => item.path).sort()).toEqual(expectedPaths.sort());
      expect(inventory.data[0].skills.map(item => item.name)).not.toContain("unwanted");
      for (const name of ["dependency-heavy", "imagegen"]) {
        const discovered = inventory.data[0].skills.find(item => item.name === name)!;
        expect(discovered.interface.displayName).toBe("Bounded skill");
        const source = name === "imagegen" ? builtin : skill;
        expect(await fs.readFile(discovered.path, "utf8")).toContain(JSON.stringify(path.join(source, "SKILL.md")));
        expect(await fs.readFile(discovered.interface.iconSmall, "utf8")).toContain("<svg");
        expect(await fs.readFile(path.join(source, "assets/icon.svg"), "utf8")).toContain("<svg");
        expect(execFileSync(process.execPath, [path.join(source, "scripts/check.cjs")], { encoding: "utf8" })).toBe("runtime available: Original reference\n");
      }
      client.close();
      await stopped;
      expect(await fs.readFile(stderrPath, "utf8")).not.toMatch(/traversal limit|failed to (walk|scan)/i);
      return overlay;
    };
    const first = await inspect("ordinary");
    await fs.writeFile(path.join(first.codexHome, ".cloudx-conversation.json"), "selection retained");
    await inspect("ordinary"); // exact-session recovery rematerializes the same owned view
    await inspect("ordinary", false); // template refresh
    await inspect("forge-worker"); // Forge uses the same materializer with its own tab binding
    expect(await fs.readFile(path.join(first.codexHome, ".cloudx-conversation.json"), "utf8")).toBe("selection retained");
    await fs.rm(path.join(first.codexHome, "skills"), { recursive: true });
    expect(await fs.readFile(path.join(skill, "node_modules/dependency-0/SKILL.md"), "utf8")).toContain("unwanted");
  } finally {
    for (const child of children) child.client.close();
    await Promise.all(children.map(child => child.stopped));
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
