import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { materializeClaudeHomeOverlay } from "./ClaudeHomeOverlay.js";

it("keeps the writer's installed tools and outputs in the catalog across Claude tabs and refreshes", async ({ onTestFinished }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-writing-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    dataDir: path.join(root, "data"), tabId: "tab-1", providerHome: path.join(root, "provider"),
    accountHome: path.join(root, "account"), executionId: "execution-1", cwd: path.join(root, "task")
  };
  await Promise.all([options.providerHome, options.accountHome, options.cwd].map(directory => fs.mkdir(directory, { recursive: true })));
  const first = await materializeClaudeHomeOverlay(options);
  const skillDir = path.join(first.rulesSkillsRoot, "system-skills", "source-grounded-writing");
  const files = [".venv/local-install", ".tools/local-tool", "node_modules/local-package/index.js", "build/report.md"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(skillDir, file)), { recursive: true });
    await fs.writeFile(path.join(skillDir, file), file);
  }
  const originalFiles = await Promise.all(files.map(file => fs.stat(path.join(skillDir, file))));

  await materializeClaudeHomeOverlay({ ...options, executionId: "execution-2" });
  const second = await materializeClaudeHomeOverlay({ ...options, tabId: "tab-2", executionId: "execution-3" });

  for (const overlay of [first, second]) {
    const entry = path.join(overlay.configDir, "skills", "cloudx-system-source-grounded-writing");
    expect(await fs.readdir(entry)).toEqual(["SKILL.md"]);
    expect((await fs.lstat(path.join(entry, "SKILL.md"))).isFile()).toBe(true);
    const instructions = await fs.readFile(path.join(entry, "SKILL.md"), "utf8");
    expect(instructions).toContain('name: "source-grounded-writing"');
    expect(instructions).toContain(`Read the original instructions at ${JSON.stringify(path.join(skillDir, "SKILL.md"))}`);
    expect(instructions).toContain(`against ${JSON.stringify(skillDir)}`);
    expect(instructions).toContain("Resolve task input and output paths from the task working directory");
  }
  for (const [index, file] of files.entries()) {
    expect(await fs.readFile(path.join(skillDir, file), "utf8")).toBe(file);
    expect((await fs.stat(path.join(skillDir, file))).ino).toBe(originalFiles[index]!.ino);
  }
});
