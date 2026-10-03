import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { isExactCodexVersion, parseCodexReleaseCatalog, parseCodexUpdateStatus, type CodexReleaseCatalog, type CodexUpdateStatus } from "@cloudx/shared";

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
  "Select an exact published Codex version.",
  "Another Codex version selection is in progress. Wait for it to finish.",
]);
const safeReadRejections = new Set([
  "Saved Codex update status could not be read. Check the local codex-update/selection-status.json file before updating.",
  "Codex update status could not be saved. Check CloudX data directory permissions.",
]);

export function CodexUpdateControl({ callHook }: { callHook: CallHook }) {
  const [view, setView] = useState<UpdateView>({ blocked: true });
  const [catalog, setCatalog] = useState<CodexReleaseCatalog>();
  const [releaseNotice, setReleaseNotice] = useState("Loading published Codex releases…");
  const [releaseRevision, setReleaseRevision] = useState(0);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [search, setSearch] = useState("");
  const startUpdate = useRef<((version: string) => Promise<void>) | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    setCatalog(undefined);
    setReleaseNotice("Loading published Codex releases…");
    async function discover() {
      try {
        const result = await callHook("codex-update.releases", {});
        const releases = parseCodexReleaseCatalog(result.releases);
        if (!disposed) { setCatalog(releases); setReleaseNotice(""); }
      } catch {
        if (!disposed) setReleaseNotice("Cannot load published Codex releases. Check registry access, then reload releases before applying a version.");
      }
    }
    void discover();
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

    startUpdate.current = async (version) => {
      if (blocked || submitting || !update || activePhases.has(update.phase) || !isExactCodexVersion(version)) return;
      submitting = true;
      blocked = true;
      startRejection = undefined;
      revision += 1;
      setView({ update, blocked, notice: "Starting Codex update…" });
      try {
        const result = await callHook("codex-update.start", { version });
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
  const selectedRelease = catalog?.versions.find(release => release.version === selectedVersion);
  const matchingReleases = catalog?.versions.filter(release => release.version.includes(search.trim()));
  const selectionError = selectedVersion && (!isExactCodexVersion(selectedVersion)
    ? "Enter an exact version such as 0.155.1. Tags, ranges, package names and paths are not accepted."
    : catalog && !selectedRelease ? "This version is not in the published releases. Reload releases or select a listed version." : undefined);
  return <section className="codex-update-control" aria-label="Codex CLI update">
    <h3>Codex CLI</h3>
    <p>Active for new tabs and Forge workers: <strong>{update?.activeVersion ?? (update ? "Unavailable" : "Checking…")}</strong></p>
    <p>Installed version: <strong>{update?.installedVersion ?? (update ? "Unavailable" : "Checking…")}</strong></p>
    <p>Requested version: <strong>{update?.requestedVersion ?? "None"}</strong></p>
    <small>The installed version records the last checked candidate. Only the active version is selected for new launches.</small>
    <label>Search published releases
      <input aria-label="Search published releases" type="search" value={search} onChange={event => setSearch(event.target.value)} />
    </label>
    <label>Published releases
      <select aria-label="Published releases" value={selectedRelease && matchingReleases?.includes(selectedRelease) ? selectedVersion : ""} disabled={!catalog || active} onChange={event => setSelectedVersion(event.target.value)}>
        <option value="">Select a published release</option>
        {matchingReleases?.map(release => <option key={release.version} value={release.version}>{release.version}{release.prerelease ? " (prerelease)" : release.version === catalog?.latestStable ? " (latest stable)" : ""}</option>)}
      </select>
    </label>
    {catalog && !matchingReleases?.length ? <p>No published releases match this search.</p> : null}
    <label>Exact version
      <input aria-label="Exact version" value={selectedVersion} maxLength={128} spellCheck={false} autoComplete="off" disabled={active} onChange={event => setSelectedVersion(event.target.value)} />
    </label>
    {selectionError ? <p role="alert" className="codex-settings-notice">{selectionError}</p> : null}
    {selectedRelease?.prerelease ? <p>This is a prerelease. Apply only if you intend to use this exact prerelease.</p> : null}
    {releaseNotice ? <p role="status">{releaseNotice}</p> : null}
    <div className="codex-settings-actions">
      <ControlButton disabled={!catalog || active} onClick={() => setSelectedVersion(catalog!.latestStable)}>Select latest stable</ControlButton>
      {update?.previousVersion ? <ControlButton disabled={!catalog || active} onClick={() => setSelectedVersion(update.previousVersion!)}>Select previous verified ({update.previousVersion})</ControlButton> : null}
      <ControlButton disabled={active} onClick={() => setReleaseRevision(value => value + 1)}>Reload releases</ControlButton>
    </div>
    <p>Selection preview: active <strong>{update?.activeVersion ?? "Unavailable"}</strong> → requested <strong>{selectedVersion || "Choose a version"}</strong>.</p>
    <div className="codex-settings-actions">
      <ControlButton disabled={blocked || !update || active || !selectedRelease || Boolean(selectionError)} onClick={() => { void startUpdate.current?.(selectedVersion); }}>
        <Download size={16} aria-hidden="true" /> Apply selected version
      </ControlButton>
    </div>
    <p aria-live="polite" aria-atomic="true" className={update?.phase === "failed" || notice ? "codex-settings-notice" : undefined}>
      {notice ?? update?.message ?? "Checking the installed Codex version…"}
    </p>
    <small>The exact selection is retained across restarts and CloudX updates. It applies to new tabs and Forge workers; running sessions keep their original version and dependencies.</small>
    <small>Settings and conversations are preserved. Before switching, CloudX verifies native launches and shared Codex state, including when downgrading. A version check alone does not prove compatibility.</small>
  </section>;
}
