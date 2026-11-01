import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./update.py", import.meta.url));

it("detects reference drift and extracts defaults, scope and version facts without invoking a provider", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-claude-catalog-"));
  const table = (header, rows) => `<table><tr>${header.map(cell => `<th>${cell}</th>`).join("")}</tr>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`;
  try {
    const settings = path.join(directory, "settings.html");
    const environment = path.join(directory, "environment.html");
    const cli = path.join(directory, "cli.html");
    const output = path.join(directory, "inventory.json");
    const original = table(["Key", "Description", "Topic", "Scope"], [["fixture", "Fixture", "Interface and terminal", "Any file"]]) + '<h3 id="fixture">fixture</h3><p>Requires Claude Code v2.1.251 or later.</p><ul><li>Type: Boolean</li><li>Default: true</li></ul>';
    await fs.writeFile(settings, original);
    await fs.writeFile(environment, table(["Variable", "Purpose"], [["FAKE_API_KEY", "Credential"]]));
    await fs.writeFile(cli, table(["Flag", "Description", "Example"], [["--fixture", "Session action", "claude --fixture"]]));
    const args = [script, "--settings", settings, "--environment", environment, "--cli", cli, "--output", output];
    execFileSync("python3", [...args, "--write"]);
    expect(JSON.parse(await fs.readFile(output, "utf8")).entries.find(entry => entry.name === "fixture"))
      .toMatchObject({ type: "boolean", nativeDefault: true, scope: "Any file", minimumVersion: "2.1.251" });
    expect(() => execFileSync("python3", args)).not.toThrow();
    await fs.writeFile(settings, original.replace("Default: true", "Default: false"));
    expect(() => execFileSync("python3", args, { stdio: "pipe" })).toThrow("Claude reference drift");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
