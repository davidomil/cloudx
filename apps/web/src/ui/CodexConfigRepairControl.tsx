import { useEffect, useRef, useState } from "react";
import { RefreshCw, Wrench } from "lucide-react";
import { parseCodexConfigRepairPreview, type CodexConfigRepairPreview } from "@cloudx/shared";

import { HttpError } from "../api.js";
import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

interface RepairView {
  repair?: CodexConfigRepairPreview;
  busy: "reading" | "applying" | null;
  error?: string;
  saved?: boolean;
}

export function CodexConfigRepairControl({ callHook }: { callHook: NonNullable<UiContributionRenderContext["callHook"]> }) {
  const [view, setView] = useState<RepairView>({ busy: "reading" });
  const reload = useRef<(() => Promise<void>) | undefined>(undefined);
  const apply = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let reviewed = false;
    let repair: CodexConfigRepairPreview | undefined;

    reload.current = async () => {
      if (busy) return;
      busy = true;
      reviewed = false;
      setView({ repair, busy: "reading" });
      try {
        const result = await callHook("codex-config-repair.read", {});
        const preview = parseCodexConfigRepairPreview(result.repair);
        if (!disposed) {
          repair = preview;
          reviewed = true;
          setView({ repair, busy: null });
        }
      } catch {
        if (!disposed) setView({ repair, busy: null, error: "Cannot read shared Codex configuration. Check the selected CLI and connection, then reload configuration before repairing." });
      } finally {
        busy = false;
      }
    };

    apply.current = async () => {
      if (busy || !reviewed || !repair?.canApply || !repair.changes.length) return;
      busy = true;
      reviewed = false;
      setView({ repair, busy: "applying" });
      try {
        const result = await callHook("codex-config-repair.apply", { expectedRevision: repair.revision });
        const preview = parseCodexConfigRepairPreview(result.repair);
        if (!disposed) {
          repair = preview;
          reviewed = true;
          setView({ repair, busy: null, saved: true });
        }
      } catch (error) {
        if (!disposed) setView({ repair, busy: null, error: error instanceof HttpError && error.status === 409
          ? "Shared configuration or the selected CLI changed. Reload configuration to review the current repair before applying."
          : "Could not confirm the configuration repair. Reload configuration to review the current state before applying again." });
      } finally {
        busy = false;
      }
    };

    void reload.current();
    return () => { disposed = true; reload.current = undefined; apply.current = undefined; };
  }, [callHook]);

  const { repair, busy, error, saved } = view;
  const showPreview = repair && (repair.changes.length > 0 || error || repair.blockedReason);
  return <section className="codex-config-repair-control" aria-label="Shared Codex configuration repair" aria-busy={busy !== null}>
    <h3>Shared Codex configuration</h3>
    {showPreview ? <>
      <p>Source config: <code>{repair.sourceConfigPath}</code></p>
      <p>Selected executable: <code>{repair.selectedCommand}</code></p>
      <p>Selected CLI version: <strong>{repair.selectedVersion}</strong></p>
      {repair.changes.length ? <>
        <p>Review these proposed changes:</p>
        <ul>{repair.changes.map(change => <li key={change}>{change}</li>)}</ul>
      </> : null}
    </> : null}
    {repair?.blockedReason ? <p role="alert" className="codex-settings-notice">{repair.blockedReason}</p> : null}
    {error ? <p role="alert" className="codex-settings-notice">{error}</p> : null}
    {busy ? <p role="status">{busy === "reading" ? "Checking shared Codex configuration…" : "Repairing shared Codex configuration…"}</p>
      : saved ? <p role="status">Shared Codex configuration repaired.</p>
      : repair && !repair.changes.length && !repair.blockedReason && !error ? <p>No supported configuration repairs are needed for the selected CLI.</p> : null}
    <div className="codex-settings-actions">
      <ControlButton disabled={busy !== null} onClick={() => { void reload.current?.(); }}><RefreshCw size={16} aria-hidden="true" /> Reload configuration</ControlButton>
      <ControlButton disabled={busy !== null || Boolean(error) || !repair?.canApply || !repair.changes.length} onClick={() => { void apply.current?.(); }}><Wrench size={16} aria-hidden="true" /> Repair shared config</ControlButton>
    </div>
    <small>Repairs apply to new and restored tabs. Running sessions keep their current configuration.</small>
  </section>;
}
