import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTerminalUpgrade } from "./install-terminal-upgrade.mjs";

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function legacyWorkspace() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudx-terminal-upgrade-test-"),
  );
  directories.push(dataDir);
  const workspacePath = path.join(dataDir, "workspace.json");
  const workspace = Buffer.from(
    '{"windows":[{"id":"window-1","layout":{"root":{"type":"pane","id":"pane-1","tabIds":["old-codex","old-shell"]}}}],"templates":[]}\n',
  );
  fs.writeFileSync(workspacePath, workspace);
  const log = vi.fn();
  return { dataDir, workspacePath, workspace, log };
}

describe("preparing the first persistent terminal upgrade", () => {
  it("preserves exact legacy layout bytes in a private verified backup and explains its limits", () => {
    const fixture = legacyWorkspace();
    const backup = prepareTerminalUpgrade(fixture);
    expect(fs.readFileSync(backup)).toEqual(fixture.workspace);
    expect(fs.readFileSync(fixture.workspacePath)).toEqual(fixture.workspace);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(backup)).mode & 0o777).toBe(0o700);
    const instructions = fs.readFileSync(
      path.join(path.dirname(backup), "README.txt"),
      "utf8",
    );
    expect(instructions).toContain(
      createHash("sha256").update(fixture.workspace).digest("hex"),
    );
    expect(instructions).toContain(
      "does not contain live session identities or processes",
    );
    expect(instructions).toContain(
      "copying it back alone does not restore missing sessions",
    );
    expect(instructions).toContain(
      "do not replay saved shell commands or AI prompts",
    );
    expect(fixture.log.mock.calls.flat().join("\n")).toContain(backup);
    expect(fs.existsSync(path.join(fixture.dataDir, "sessions.json"))).toBe(
      false,
    );
  });

  it("retains the first snapshot when an update is attempted again", () => {
    const fixture = legacyWorkspace();
    const first = prepareTerminalUpgrade(fixture);
    fs.writeFileSync(fixture.workspacePath, '{"windows":[]}\n');
    const second = prepareTerminalUpgrade(fixture);
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first)).toEqual(fixture.workspace);
    expect(fs.readFileSync(second, "utf8")).toBe('{"windows":[]}\n');
  });

  it("leaves broker-era updates untouched once session persistence exists", () => {
    const fixture = legacyWorkspace();
    fs.writeFileSync(
      path.join(fixture.dataDir, "sessions.json"),
      '{"version":1,"sessions":[]}',
    );
    expect(prepareTerminalUpgrade(fixture)).toBeUndefined();
    expect(fixture.log).not.toHaveBeenCalled();
    expect(fs.readdirSync(fixture.dataDir).sort()).toEqual([
      "sessions.json",
      "workspace.json",
    ]);
  });

  it.each(["missing directory", "missing workspace"])(
    "does not create state for a %s",
    (kind) => {
      const fixture = legacyWorkspace();
      if (kind === "missing directory")
        fs.rmSync(fixture.dataDir, { recursive: true });
      else fs.unlinkSync(fixture.workspacePath);
      expect(prepareTerminalUpgrade(fixture)).toBeUndefined();
      expect(fixture.log).not.toHaveBeenCalled();
    },
  );

  it("warns during a dry run without creating a backup", () => {
    const fixture = legacyWorkspace();
    expect(
      prepareTerminalUpgrade({ ...fixture, dryRun: true }),
    ).toBeUndefined();
    expect(fs.readdirSync(fixture.dataDir)).toEqual(["workspace.json"]);
    expect(fixture.log.mock.calls.flat().join("\n")).toContain(
      "Dry run: would save a verified private copy",
    );
  });

  it("backs up malformed layout bytes without attempting repair", () => {
    const fixture = legacyWorkspace();
    fs.writeFileSync(fixture.workspacePath, '{"truncated":');
    const backup = prepareTerminalUpgrade(fixture);
    expect(fs.readFileSync(backup, "utf8")).toBe('{"truncated":');
  });

  it.each([
    ["workspace.json", "missing"],
    ["workspace.json", "existing"],
    ["sessions.json", "missing"],
    ["sessions.json", "existing"],
  ])(
    "rejects a %s symlink with a %s target before creating a backup",
    (name, targetState) => {
      const fixture = legacyWorkspace();
      const target = path.join(fixture.dataDir, "linked-state.json");
      if (targetState === "existing") {
        fs.writeFileSync(target, '{"version":1,"sessions":[]}');
      }
      fs.rmSync(path.join(fixture.dataDir, name), { force: true });
      fs.symlinkSync(target, path.join(fixture.dataDir, name));
      expect(() => prepareTerminalUpgrade(fixture)).toThrow(
        /regular file.*symlink/,
      );
      expect(
        fs
          .readdirSync(fixture.dataDir)
          .some((entry) => entry.startsWith("terminal-upgrade-backup-")),
      ).toBe(false);
    },
  );

  it.each(["legacy", "persistent"])(
    "rejects a symlinked data directory for %s sessions, matching workspace storage",
    (sessions) => {
      const fixture = legacyWorkspace();
      if (sessions === "persistent") {
        fs.writeFileSync(
          path.join(fixture.dataDir, "sessions.json"),
          '{"version":1,"sessions":[]}',
        );
      }
      const link = path.join(fixture.dataDir, "linked-data");
      fs.symlinkSync(fixture.dataDir, link);
      expect(() =>
        prepareTerminalUpgrade({ ...fixture, dataDir: link }),
      ).toThrow("regular directory");
    },
  );

  it.each(["write", "verification", "flush"])(
    "stops on backup %s failure and preserves the original",
    (failure) => {
      const fixture = legacyWorkspace();
      if (failure === "write") {
        vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file) => {
          fs.appendFileSync(file, "partial");
          throw Object.assign(new Error("No space left on device"), {
            code: "ENOSPC",
          });
        });
      } else if (failure === "verification") {
        vi.spyOn(fs, "readFileSync")
          .mockReturnValueOnce(fixture.workspace)
          .mockReturnValueOnce(Buffer.from("corrupt copy"));
      } else {
        vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
          throw new Error("Unable to sync");
        });
      }
      expect(() => prepareTerminalUpgrade(fixture)).toThrow(
        "update stopped before restart",
      );
      expect(fs.readFileSync(fixture.workspacePath)).toEqual(fixture.workspace);
      expect(fs.readdirSync(fixture.dataDir)).toEqual(["workspace.json"]);
    },
  );

  it("gives custom services manual backup instructions without reading an assumed data directory", () => {
    const log = vi.fn();
    const read = vi.spyOn(fs, "lstatSync");
    prepareTerminalUpgrade({
      customService: "preview.service",
      dataDir: "/not-the-custom-data",
      log,
    });
    expect(read).not.toHaveBeenCalled();
    const warning = log.mock.calls.flat().join("\n");
    expect(warning).toContain("preview.service");
    expect(warning).toContain(
      "identify CLOUDX_DATA_DIR in its service configuration",
    );
    expect(warning).toContain(
      "copy workspace.json there, and verify the copy matches the original",
    );
    expect(warning).toContain("Use --no-start");
  });
});
