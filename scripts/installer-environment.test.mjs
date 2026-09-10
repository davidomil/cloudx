import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseEnvironmentFile,
  updateEnvironmentFile,
} from "./installer-environment.mjs";
import { InstallerRunner, runInstaller } from "./install-cloudx.mjs";

const temporaryDirectories = [];
afterEach(() =>
  temporaryDirectories
    .splice(0)
    .forEach((directory) =>
      fs.rmSync(directory, { recursive: true, force: true }),
    ),
);

describe("saved systemd environment values", () => {
  it("rejects NUL characters and invalid names instead of writing unusable settings", () => {
    expect(() => parseEnvironmentFile("A=one\0B=two")).toThrow(/NUL/);
    expect(() => updateEnvironmentFile("", { A: "one\0two" })).toThrow(/NUL/);
    expect(() => updateEnvironmentFile("", { "9BAD": "one" })).toThrow(/name/);
  });

  it.each([
    ['PATH="/srv/cloudx data"\n', "/srv/cloudx data"],
    ["PATH='/srv/cloudx models'\n", "/srv/cloudx models"],
    [String.raw`PATH=/srv/cloudx\ data` + "\n", "/srv/cloudx data"],
    [' PATH =  "/srv/cloudx data" \t\r\n', "/srv/cloudx data"],
    ['PATH="/srv/a\\"b\\\\c\\$d\\`e\\q"\n', '/srv/a"b\\c$d`e\\q'],
    ["PATH='/srv/a\\b$HOME`command`'\n", "/srv/a\\b$HOME`command`"],
    ["PATH=/srv/a\"b'c\n", "/srv/a\"b'c"],
    ["PATH=\"/srv/a\" 'b'\n", "/srv/ab"],
    ["PATH=/srv/a\\\nb\n", "/srv/ab"],
    ['PATH="/srv/a\\\nb"\n', "/srv/ab"],
    ["PATH='/srv/a\nb'\n", "/srv/a\nb"],
    ['PATH="/srv/a\nb"\n', "/srv/a\nb"],
    ["PATH=  /srv/a b  \t\r\n", "/srv/a b"],
    ["PATH=/srv/a\\ \n", "/srv/a "],
    ['PATH="/srv/a "\n', "/srv/a "],
    ["PATH=\n", ""],
  ])("decodes %j without shell evaluation", (content, expected) => {
    expect(parseEnvironmentFile(content)).toEqual({ PATH: expected });
  });

  it("ignores comments and invalid names and lets the final assignment win", () => {
    expect(
      parseEnvironmentFile(
        ' # comment=one\n; comment=two\ninvalid line\n9BAD=no\nOK=before\nOK="after"\n',
      ),
    ).toEqual({ OK: "after" });
  });

  it("keeps a quoted multiline assignment intact when updating another key", () => {
    const original =
      '# settings\nCLOUDX_TOOL_PATH="old\nCLOUDX_PORT=unrelated text"\n CLOUDX_PORT = \'3001\'\nCLOUDX_DATA_DIR="/srv/cloudx data"\n';
    const updated = updateEnvironmentFile(original, { CLOUDX_PORT: "3443" });
    expect(updated).toBe(
      '# settings\nCLOUDX_TOOL_PATH="old\nCLOUDX_PORT=unrelated text"\nCLOUDX_PORT=3443\nCLOUDX_DATA_DIR="/srv/cloudx data"\n',
    );
    expect(parseEnvironmentFile(updated)).toEqual({
      CLOUDX_TOOL_PATH: "old\nCLOUDX_PORT=unrelated text",
      CLOUDX_PORT: "3443",
      CLOUDX_DATA_DIR: "/srv/cloudx data",
    });
  });

  it("replaces a complete multiline value and preserves unrelated choices", () => {
    const original =
      "CLOUDX_TOOL_PATH=\"/old\n/path\"\n# keep this\nCLOUDX_DATA_DIR='/srv/data'\n";
    const value = '/srv/a "quote"\\path:$literal:`command`\nnext';
    const updated = updateEnvironmentFile(original, {
      CLOUDX_TOOL_PATH: value,
      CLOUDX_PORT: "3001",
    });
    expect(updated).toContain("# keep this\nCLOUDX_DATA_DIR='/srv/data'\n");
    expect(parseEnvironmentFile(updated)).toEqual({
      CLOUDX_TOOL_PATH: value,
      CLOUDX_DATA_DIR: "/srv/data",
      CLOUDX_PORT: "3001",
    });
  });

  it("updates every duplicate assignment so an old later value cannot override it", () => {
    expect(
      parseEnvironmentFile(
        updateEnvironmentFile('A=old\nA="older"', { A: "/new path" }),
      ),
    ).toEqual({ A: "/new path" });
  });

  it("recognizes CR and CRLF record boundaries without changing quoted carriage returns", () => {
    const original = '# comment\rA=one\rB="two\rinside"\r\nC=three\r';
    expect(parseEnvironmentFile(original)).toEqual({
      A: "one",
      B: "two\rinside",
      C: "three",
    });
    expect(updateEnvironmentFile(original, { B: "/new path" })).toBe(
      '# comment\rA=one\rB="/new path"\nC=three\r',
    );
  });

  it("consumes an escaped CR outside quotes and retains it inside double quotes", () => {
    expect(parseEnvironmentFile('A=one\\\rtwo\rB="one\\\rtwo"\r')).toEqual({
      A: "onetwo",
      B: "one\\\rtwo",
    });
  });

  it.each(["A=one", "A=one\\", "A=one\\\n", 'A="one', "A='one", 'A="one\\'])(
    "finishes the final record %j before adding a new setting",
    (original) => {
      expect(
        parseEnvironmentFile(
          updateEnvironmentFile(original, { CLOUDX_HOST: "127.0.0.1" }),
        ),
      ).toEqual({ A: "one", CLOUDX_HOST: "127.0.0.1" });
    },
  );

  it("does not let an ignored invalid assignment absorb appended settings", () => {
    expect(
      parseEnvironmentFile(
        updateEnvironmentFile('A=one\n9BAD="unfinished', {
          CLOUDX_HOST: "127.0.0.1",
        }),
      ),
    ).toEqual({ A: "one", CLOUDX_HOST: "127.0.0.1" });
  });

  it("does not enter a quoted value when a line starts with an equals sign", () => {
    expect(parseEnvironmentFile('="ignored\nCLOUDX_DATA_DIR=/saved\n')).toEqual(
      { CLOUDX_DATA_DIR: "/saved" },
    );
  });

  it.each(["\u00a0", "\f", "\v"])(
    "does not strip non-systemd whitespace %j from names",
    (character) => {
      expect(
        parseEnvironmentFile(
          `${character}CLOUDX_DATA_DIR=/different\nCLOUDX_HOST${character}=::1\nOK=one\n`,
        ),
      ).toEqual({ OK: "one" });
    },
  );
});

describe("updating an installation with quoted saved paths", () => {
  it.each(['"', "'"])(
    "uses decoded %s-quoted model and data directories throughout the update",
    async (quote) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "cloudx-quoted-config-"),
      );
      temporaryDirectories.push(root);
      const fixtureHome = path.join(root, "user");
      const envPath = path.join(fixtureHome, ".config/cloudx/cloudx.env");
      const modelDir = path.join(root, "existing model");
      const dataDir = path.join(root, "existing data");
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.mkdirSync(modelDir);
      fs.mkdirSync(dataDir);
      fs.writeFileSync(path.join(modelDir, "config.json"), "{}");
      const saved = `CLOUDX_ASR_MODEL_PATH=${quote}${modelDir}${quote}\nCLOUDX_DATA_DIR=${quote}${dataDir}${quote}\nCLOUDX_PORT=${quote}3443${quote}\nCLOUDX_DOCUMENTATION_PORT=${quote}9000${quote}\n`;
      fs.writeFileSync(envPath, saved);
      const runner = new InstallerRunner({
        dryRun: true,
        cwd: root,
        log: () => {},
      });
      runner.inspect = (command, args) => {
        if (command === "systemctl") return "LoadState=not-found";
        if (args.includes("--show-toplevel")) return root;
        if (args[0] === "status") return "";
        if (args[0] === "remote") return "/fixture/origin.git";
        return "a".repeat(40);
      };
      const result = await runInstaller({
        repoRoot: root,
        home: fixtureHome,
        env: { PATH: "/usr/bin" },
        dryRun: true,
        yes: true,
        update: true,
        runner,
        osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
      });
      expect(result.paths).toMatchObject({ modelDir, dataDir });
      expect(result.port).toBe(3443);
      expect(
        runner.commands.some(
          (command) => path.basename(command.command) === "hf",
        ),
      ).toBe(false);
      expect(
        runner.commands.find((command) => command.args.includes("cert:create"))
          .env.CLOUDX_DATA_DIR,
      ).toBe(dataDir);
      const updated = runner.writes.find(
        (write) => write.path === envPath,
      ).contents;
      expect(updated).toContain(`CLOUDX_DATA_DIR=${quote}${dataDir}${quote}`);
      expect(parseEnvironmentFile(updated).CLOUDX_DOCUMENTATION_DATA_DIR).toBe(
        path.join(dataDir, "documentation"),
      );
      expect(fs.readFileSync(envPath, "utf8")).toBe(saved);
    },
  );
});
