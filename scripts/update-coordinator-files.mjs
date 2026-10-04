export const COORDINATOR_SCRIPT_FILES = [
  "settings-update.mjs", "update-cloudx.mjs", "managed-update.mjs", "managed-update-store.mjs",
  "update-backup-cleanup.mjs", "update-backup-filesystem.mjs", "update-backup-references.mjs", "update-operation-lock.mjs",
  "managed-update-data.mjs", "managed-update-terminals.mjs", "managed-update-readiness.mjs",
  "managed-update-integration.mjs", "managed-runtime-launch.mjs", "write-runtime-build.mjs",
  "install-cloudx.mjs", "codex-updater.mjs", "codex-selection.mjs", "install-update.mjs", "install-runtime.mjs",
  "install-terminal-upgrade.mjs", "terminal-upgrade-recovery.mjs", "installer-environment.mjs",
  "update-coordinator.mjs", "update-coordinator-files.mjs",
].map(file => `scripts/${file}`);
