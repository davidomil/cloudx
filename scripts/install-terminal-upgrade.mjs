import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const terminalUpgradeWarning =
  "WARNING: The first upgrade to persistent terminal ownership cannot preserve " +
  "legacy in-memory tabs or terminal processes when the web service restarts. " +
  "A workspace layout backup does not contain live session identities or processes " +
  "and cannot automatically restore those tabs. Save your work and record each " +
  "tab's working directory and any historical Codex session ID before restarting. " +
  "Use --no-start to defer the restart while preparing recovery. " +
  "Recreate tabs through Cloudx and resume only known historical Codex sessions; " +
  "do not replay saved shell commands or AI prompts.";

export function prepareTerminalUpgrade({
  dataDir,
  customService,
  dryRun = false,
  log = console.warn,
}) {
  if (customService) {
    log(
      `${customService}: ${terminalUpgradeWarning}\n` +
        "The custom service's data directory is not inferred by this updater. " +
        "Before its first terminal upgrade, identify CLOUDX_DATA_DIR in its service " +
        "configuration (the default is <checkout>/.cloudx), create a private backup " +
        "directory, copy workspace.json there, and verify the copy matches the original. " +
        "Keep that snapshot for manual window and pane placement; copying it back " +
        "alone does not restore missing sessions.",
    );
    return;
  }

  const directory = fs.lstatSync(dataDir, { throwIfNoEntry: false });
  if (!directory) return;
  if (!directory.isDirectory()) {
    throw new Error(
      `Cloudx data directory must be a regular directory: ${dataDir}`,
    );
  }
  if (regularFileExists(path.join(dataDir, "sessions.json"))) return;

  const workspacePath = path.join(dataDir, "workspace.json");
  if (!regularFileExists(workspacePath)) return;
  log(terminalUpgradeWarning);
  if (dryRun) {
    log(
      `Dry run: would save a verified private copy of ${workspacePath} before restarting.`,
    );
    return;
  }

  const workspace = readRegularFile(workspacePath);
  const backupDir = fs.mkdtempSync(
    path.join(dataDir, "terminal-upgrade-backup-"),
  );
  const backupPath = path.join(backupDir, "workspace.json");
  try {
    fs.writeFileSync(backupPath, workspace, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (!readRegularFile(backupPath).equals(workspace)) {
      throw new Error("Workspace backup verification failed.");
    }
    const sha256 = createHash("sha256").update(workspace).digest("hex");
    fs.writeFileSync(
      path.join(backupDir, "README.txt"),
      `${terminalUpgradeWarning}\n\nOriginal: ${workspacePath}\nSHA-256: ${sha256}\n` +
        "workspace.json contains the exact layout bytes captured before the update. " +
        "Keep this snapshot for manual window and pane placement; copying it back " +
        "alone does not restore missing sessions. Changes made after this snapshot " +
        "are not included. No commands or prompts have been replayed.\n",
      { flag: "wx", mode: 0o600, flush: true },
    );
    syncDirectory(backupDir);
    syncDirectory(dataDir);
  } catch (error) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw new Error(
      `Could not preserve legacy workspace ${workspacePath}; update stopped before restart.`,
      { cause: error },
    );
  }
  log(`Verified legacy workspace layout backup: ${backupPath}`);
  return backupPath;
}

function regularFileExists(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile())
    throw new Error(
      `Cloudx state must be a regular file, not a symlink or special file: ${filePath}`,
    );
  return true;
}

function readRegularFile(filePath) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(descriptor).isFile())
      throw new Error(`Cloudx state must be a regular file: ${filePath}`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
