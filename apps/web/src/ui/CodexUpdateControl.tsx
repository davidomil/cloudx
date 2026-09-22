import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { parseCodexUpdateStatus, type CodexUpdateStatus } from "@cloudx/shared";

import { HttpError } from "../api.js";
import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;
interface UpdateView {
  update?: CodexUpdateStatus;
  blocked: boolean;
  notice?: string;
}

const activePhases = new Set<CodexUpdateStatus["phase"]>(["checking", "updating", "verifying"]);
const safeStartRejections = new Set([
  "Codex update status could not be saved. Check CloudX data directory permissions.",
  "Codex updates are unavailable while CloudX is stopping.",
  "Start Codex updates from a trusted CloudX browser origin.",
]);

export function CodexUpdateControl({ callHook }: { callHook: CallHook }) {
  const [view, setView] = useState<UpdateView>({ blocked: true });
  const startUpdate = useRef<(() => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let revision = 0;
    let submitting = false;
    let blocked = true;
    let update: CodexUpdateStatus | undefined;
    let startRejection: { jobId: CodexUpdateStatus["jobId"]; message: string } | undefined;
    setView({ blocked });

    async function read() {
      const requestRevision = revision;
      try {
        const result = await callHook("codex-update.read", {});
        const status = parseCodexUpdateStatus(result.update);
        if (!disposed && requestRevision === revision && !submitting) {
          if (status.jobId !== startRejection?.jobId) startRejection = undefined;
          update = status;
          blocked = false;
          setView({ update, blocked, notice: startRejection?.message });
        }
      } catch {
        if (!disposed && requestRevision === revision && !submitting) {
          blocked = true;
          setView({ update, blocked, notice: "Cannot read Codex update status. Checking the connection before another update can start." });
        }
      } finally {
        if (!disposed) timer = setTimeout(() => { void read(); }, 1_000);
      }
    }

    startUpdate.current = async () => {
      if (blocked || submitting || !update || activePhases.has(update.phase)) return;
      submitting = true;
      blocked = true;
      startRejection = undefined;
      revision += 1;
      setView({ update, blocked, notice: "Starting Codex update…" });
      try {
        const result = await callHook("codex-update.start", {});
        const status = parseCodexUpdateStatus(result.update);
        if (!disposed) {
          update = status;
          blocked = false;
          setView({ update, blocked });
        }
      } catch (error) {
        if (!disposed) {
          if (error instanceof HttpError && safeStartRejections.has(error.message)) {
            startRejection = { jobId: update.jobId, message: error.message };
          }
          setView({ update, blocked: true, notice: startRejection?.message ?? "Could not confirm the update request. Checking server status before another update can start." });
        }
      } finally {
        revision += 1;
        submitting = false;
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      startUpdate.current = undefined;
    };
  }, [callHook]);

  const { update, blocked, notice } = view;
  const active = update && activePhases.has(update.phase);
  return <section className="codex-update-control" aria-label="Codex CLI update">
    <h3>Codex CLI</h3>
    <p>Installed version: <strong>{update?.installedVersion ?? (update ? "Unavailable" : "Checking…")}</strong></p>
    <div className="codex-settings-actions">
      <ControlButton disabled={blocked || !update || active} onClick={() => { void startUpdate.current?.(); }}>
        <Download size={16} aria-hidden="true" /> Update Codex
      </ControlButton>
    </div>
    <p aria-live="polite" aria-atomic="true" className={update?.phase === "failed" || notice ? "codex-settings-notice" : undefined}>
      {notice ?? update?.message ?? "Checking the installed Codex version…"}
    </p>
    <small>Updates the Codex CLI used by this CloudX installation to the latest release. Newly launched Codex processes use the updated version; running Codex and terminal sessions continue unchanged. Your settings and conversations are preserved.</small>
    <small>A full CloudX update can replace this with the Codex version bundled with that CloudX release.</small>
  </section>;
}
