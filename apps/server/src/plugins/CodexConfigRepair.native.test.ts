import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import { parse } from "smol-toml";

import { CodexConfigRepairService } from "./CodexConfigRepairService.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { materializeCodexTemplate } from "./CodexTerminalPlugin.js";

const codex = process.env.CLOUDX_NATIVE_CODEX_CONFIG_REPAIR;

it.skipIf(!codex)("native Codex 0.160.0 initializes with three ignored settings before reviewed source repair and none in new/restored overlays afterward", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-config-repair-"));
  const home = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const env = { HOME: home, CODEX_HOME: home, CLOUDX_ASSISTANT_BIN: codex!, PATH: process.env.PATH };
  const sources = new CodexStateSources(dataDir, env);
  try {
    await fs.mkdir(home);
    await fs.mkdir(cwd);
    const imagegen = path.join(home, "skills", ".system", "imagegen");
    await fs.mkdir(imagegen, { recursive: true });
    await fs.writeFile(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Isolated native test.\n---\n");
    const sourceConfig = 'model = "chosen-model"\nmodel_reasoning_effort = "high"\nhide_full_access_warning = true\n[features]\nghost_commit = true\nstreamable_shell = true\n';
    await fs.writeFile(path.join(home, "config.toml"), sourceConfig);
    const service = new CodexConfigRepairService(sources, env);
    const preview = await service.read();
    expect(preview.selectedVersion).toBe("0.160.0");
    expect(preview.selectedCommand).toBe(codex);
    const launch = (tabId: string, resetOverlay = true) => materializeCodexTemplate(undefined, env, { dataDir, tabId, sources, cwd, resetOverlay });
    const original = await launch("restored");
    const before = await initialize(original.command, original.env, cwd);
    expect(before.code).toBe(0);
    expect(before.stderr).toContain("ignoring 3 unrecognized configuration settings");
    for (const key of ["features.ghost_commit", "features.streamable_shell", "hide_full_access_warning"]) expect(before.stderr).toContain(key);
    await service.apply(preview.revision);
    const results = [];
    for (const [tabId, reset] of [["new", true], ["restored", false]] as const) {
      const repaired = await launch(tabId, reset);
      const after = await initialize(repaired.command, repaired.env, cwd);
      expect(after.code).toBe(0);
      expect(after.stderr).not.toMatch(/unrecognized configuration|ghost_commit|streamable_shell/);
      const config = parse(await fs.readFile(repaired.overlay!.configPath, "utf8"));
      expect(config).toMatchObject({ model: "chosen-model", model_reasoning_effort: "high", notice: { hide_full_access_warning: true } });
      expect(config).not.toHaveProperty("hide_full_access_warning");
      results.push({ tabId, ...after });
    }
    const evidenceDir = process.env.CLOUDX_CONFIG_REPAIR_EVIDENCE_DIR;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, "native-initialization.json"), JSON.stringify({ version: preview.selectedVersion, before, after: results }, null, 2));
      await fs.writeFile(path.join(evidenceDir, "source-before.toml"), sourceConfig);
      await fs.writeFile(path.join(evidenceDir, "source-after.toml"), await fs.readFile(path.join(home, "config.toml")));
    }
  } finally {
    await sources.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

function initialize(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let initialized = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.stderr.on("data", data => { stderr += data; });
    child.stdout.on("data", data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = JSON.parse(line);
        if (response.id === 1 && response.result) { initialized = true; child.stdin.end(); }
      }
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (!initialized) reject(new Error(`Native initialization did not complete: ${stderr}`));
      else resolve({ code, stderr });
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "cloudx_config_repair_regression", version: "0.1.0" }, capabilities: {} } })}\n`);
  });
}
