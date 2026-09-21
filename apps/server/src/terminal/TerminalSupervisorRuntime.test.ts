import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe("terminal supervisor runtime", () => {
  it("pins the helper and its identity when imported, before any terminal launches", async () => {
    const fixture = await runtimeFixture();
    const source = 'CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "execution-json-v1"\n';
    await fs.writeFile(fixture.helper, source);
    const { stdout } = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from 'node:fs';
      import { terminalSupervisorSource, terminalSupervisorRuntime } from ${JSON.stringify(fixture.module)};
      fs.writeFileSync(${JSON.stringify(fixture.helper)}, 'incompatible replacement');
      const loadedAgain = await import(${JSON.stringify(fixture.module)});
      console.log(JSON.stringify({ source: loadedAgain.terminalSupervisorSource, runtime: terminalSupervisorRuntime }));
    `]);
    expect(JSON.parse(stdout)).toEqual({
      source,
      runtime: { contract: "execution-json-v1", sourceSha256: createHash("sha256").update(source).digest("hex"), pinned: true }
    });
  });

  it.each([
    [undefined, "bundled terminal-supervisor.py helper is required"],
    ["", "helper declares no contract"],
    ['CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "execution-json-v2"\n', "helper declares execution-json-v2"]
  ])("refuses startup with a missing or incompatible helper: %s", async (source, message) => {
    const fixture = await runtimeFixture();
    if (source !== undefined) await fs.writeFile(fixture.helper, source);
    await expect(execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(fixture.module)})`]))
      .rejects.toThrow(message);
  });
});

async function runtimeFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-supervisor-runtime-test-"));
  directories.push(directory);
  const modules = path.join(directory, "src", "terminal");
  await fs.mkdir(modules, { recursive: true });
  await fs.mkdir(path.join(directory, "helpers"));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const module = path.join(modules, "TerminalSupervisorRuntime.ts");
  await fs.copyFile(new URL("./TerminalSupervisorRuntime.ts", import.meta.url), module);
  return { helper: path.join(directory, "helpers", "terminal-supervisor.py"), module: pathToFileURL(module).href };
}
