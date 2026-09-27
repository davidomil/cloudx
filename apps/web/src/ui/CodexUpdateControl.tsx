import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { compareCodexVersions, isExactCodexVersion, parseCodexReleases, parseCodexUpdateStatus, type CodexReleases, type CodexUpdateRequest, type CodexUpdateStatus } from "@cloudx/shared";

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
const safeReadRejections = new Set([
  "Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.",
  "Saved Codex selection is invalid or unreadable. Repair .cloudx-codex-selection.json in the configured npm prefix before selecting or launching Codex.",
  "Codex update status could not be saved. Check CloudX data directory permissions.",
]);

export function CodexUpdateControl({ callHook }: { callHook: CallHook }) {
  const [view, setView] = useState<UpdateView>({ blocked: true });
  const [releases, setReleases] = useState<CodexReleases>();
  const [releaseError, setReleaseError] = useState<string>();
  const [releaseRevision, setReleaseRevision] = useState(0);
  const [targetVersion, setTargetVersion] = useState("");
  const [acknowledgedChange, setAcknowledgedChange] = useState<string>();
  const [recoveryChange, setRecoveryChange] = useState<string>();
  const startUpdate = useRef<((request: CodexUpdateRequest) => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    setReleases(undefined);
    setReleaseError(undefined);
    void callHook("codex-update.releases", {}).then(result => {
      const published = parseCodexReleases(result.releases);
      if (!disposed) setReleases(published);
    }).catch(() => {
      if (!disposed) setReleaseError("Cannot load published Codex releases. Check the registry connection and reload releases before applying a version.");
    });
    return () => { disposed = true; };
  }, [callHook, releaseRevision]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let revision = 0;
    let submitting = false;
    let blocked = true;
    let update: CodexUpdateStatus | undefined;
    let startRejection: { jobId: CodexUpdateStatus["jobId"]; message: string } | undefined;
    let readRejection: string | undefined;
    setView({ blocked });

    async function read() {
      const requestRevision = revision;
      try {
        const result = await callHook("codex-update.read", {});
        const status = parseCodexUpdateStatus(result.update);
        if (!disposed && requestRevision === revision && !submitting) {
          if (status.jobId !== startRejection?.jobId) startRejection = undefined;
          readRejection = undefined;
          update = status;
          blocked = false;
          setView({ update, blocked, notice: startRejection?.message });
        }
      } catch (error) {
        if (!disposed && requestRevision === revision && !submitting) {
          if (error instanceof HttpError && safeReadRejections.has(error.message)) readRejection = error.message;
          blocked = true;
          setView({ update, blocked, notice: readRejection ?? "Cannot read Codex update status. Checking the connection before another update can start." });
        }
      } finally {
        if (!disposed) timer = setTimeout(() => { void read(); }, 1_000);
      }
    }

    startUpdate.current = async request => {
      if (blocked || submitting || !update || activePhases.has(update.phase)) return;
      submitting = true;
      blocked = true;
      startRejection = undefined;
      revision += 1;
      setView({ update, blocked, notice: "Starting Codex update…" });
      try {
        const result = await callHook("codex-update.start", { ...request });
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
          } else if (error instanceof HttpError && error.status === 409) {
            startRejection = { jobId: update.jobId, message: "Another Codex version change is already running. Checking its progress before another selection can be applied." };
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
  const active = Boolean(update && activePhases.has(update.phase));
  const exactVersion = isExactCodexVersion(targetVersion);
  const publishedVersion = Boolean(exactVersion && releases?.versions.includes(targetVersion));
  const downgrade = Boolean(exactVersion && update?.activeVersion && compareCodexVersions(targetVersion, update.activeVersion) < 0);
  const change = `${update?.activeVersion}:${targetVersion}`;
  const acknowledgeDowngrade = acknowledgedChange === change;
  const recoveryMode = recoveryChange === change;
  const prerelease = exactVersion && targetVersion.split("+")[0]!.includes("-");
  const matchingVersions = releases?.versions.filter(version => version.toLowerCase().includes(targetVersion.toLowerCase())) ?? [];
  const canApply = !blocked && update && !active && publishedVersion && (!downgrade || acknowledgeDowngrade);
  const selectVersion = (version: string) => { setTargetVersion(version); setAcknowledgedChange(undefined); setRecoveryChange(undefined); };

  return <section className="codex-update-control" aria-label="Codex CLI update">
    <h3>Codex CLI</h3>
    <p>Active for new tabs and Forge workers: <strong>{update?.activeVersion ?? (update ? "Unavailable" : "Checking…")}</strong></p>
    <p>Requested version: <strong>{update?.requestedVersion ?? "None"}</strong></p>
    <p>Installed candidate: <strong>{update?.installedVersion ?? "None"}</strong></p>
    <div className="codex-settings-form">
      <label>
        Search releases or enter an exact version
        <input aria-label="Search releases or enter an exact version" value={targetVersion} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={active} placeholder="For example, 0.155.1" onChange={event => selectVersion(event.target.value)} />
      </label>
      <label>
        Published releases
        <select aria-label="Published releases" value={publishedVersion ? targetVersion : ""} disabled={!releases || active} onChange={event => selectVersion(event.target.value)}>
          <option value="">{releases ? "Choose a published release" : "Loading releases…"}</option>
          {matchingVersions.map(version => <option key={version} value={version}>{version}{version.split("+")[0]!.includes("-") ? " — Prerelease" : version === releases?.latestStable ? " — Latest stable" : ""}</option>)}
        </select>
      </label>
    </div>
    {releaseError ? <p role="alert" className="codex-settings-notice">{releaseError}</p> : null}
    <div className="codex-settings-actions">
      <ControlButton disabled={!releases || active} onClick={() => selectVersion(releases!.latestStable)}>Select latest stable{releases ? ` (${releases.latestStable})` : ""}</ControlButton>
      <ControlButton disabled={!update?.previousVerifiedVersion || active} onClick={() => selectVersion(update!.previousVerifiedVersion!)}>Return to previous verified{update?.previousVerifiedVersion ? ` (${update.previousVerifiedVersion})` : ""}</ControlButton>
      <ControlButton disabled={active || (!releases && !releaseError)} onClick={() => setReleaseRevision(revision => revision + 1)}>Reload releases</ControlButton>
    </div>
    {targetVersion ? <>
      {publishedVersion ? <p>Confirm {downgrade ? "downgrade" : "selection"}: <strong>{update?.activeVersion ?? "Unavailable"}</strong> → <strong>{targetVersion}</strong>{prerelease ? " (Prerelease)" : ""}.</p> : releases ? <p role="status">{exactVersion ? "This exact version is not in the published releases. Reload releases to check again." : "Choose a published release or enter its complete exact version. Ranges, tags and package names are not accepted."}</p> : null}
      {publishedVersion && targetVersion === update?.activeVersion ? <p>Codex {targetVersion} {update.phase === "succeeded" ? "is already selected and verified." : "is already selected for new launches. Apply to confirm its verification status."}</p> : null}
      {prerelease ? <p className="codex-settings-notice">You selected a prerelease. Apply only if you intend to use this prerelease for new launches.</p> : null}
    </> : null}
    {publishedVersion ? <div className="codex-settings-form">
      <label className="codex-settings-toggle">
        <input type="checkbox" aria-label="Recovery mode" checked={recoveryMode} disabled={active} onChange={event => setRecoveryChange(event.target.checked ? change : undefined)} />
        <span>Recovery mode<small>Use when the active CLI can no longer launch. Verify the selected version's new tab and Forge turn without starting the active CLI. Cross-version compatibility of saved conversations and shared state will not be checked.</small></span>
      </label>
    </div> : null}
    {downgrade ? <div className="codex-settings-form">
      <label className="codex-settings-toggle">
        <input type="checkbox" aria-label="Acknowledge shared state downgrade risk" checked={acknowledgeDowngrade} disabled={active} onChange={event => setAcknowledgedChange(event.target.checked ? change : undefined)} />
        <span>I understand the shared state risk.<small>Saved conversations and shared Codex state may use a newer format that this older release cannot read. Integration verification does not prove existing state is compatible. Back up your Codex state before downgrading.</small></span>
      </label>
    </div> : null}
    <div className="codex-settings-actions">
      <ControlButton disabled={!canApply} onClick={() => { void startUpdate.current?.({ targetVersion, ...(downgrade ? { acknowledgeDowngrade } : {}), ...(recoveryMode ? { recoveryMode } : {}) }); }}>
        <Download size={16} aria-hidden="true" /> Apply selected version
      </ControlButton>
    </div>
    <p aria-live="polite" aria-atomic="true" className={update?.phase === "failed" || notice ? "codex-settings-notice" : undefined}>
      {notice ?? update?.message ?? "Checking the active Codex version…"}
    </p>
    <small>The exact selection is kept through restarts and CloudX updates. New tabs and Forge workers use the selected version; running tabs and workers keep their original binaries and dependencies. Your settings and saved conversations are retained.</small>
  </section>;
}
