import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { CLOUDX_LOG_SOURCES, type CloudxLogSource, type CloudxLogsResponse } from "@cloudx/shared";

import { getLogs, saveBlobDownload } from "../api.js";
import { ControlButton } from "./Control.js";

export function LogsPanel() {
  const [source, setSource] = useState<CloudxLogSource>("current");
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<CloudxLogsResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined);
    setError(undefined);
    setLoading(true);
    void getLogs(source, controller.signal).then(next => {
      if (!controller.signal.aborted) setSnapshot(next);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [source, refresh]);

  function download() {
    if (!snapshot) return;
    const timestamp = snapshot.capturedAt.replace(/[^a-zA-Z0-9-]/g, "-");
    saveBlobDownload(new Blob([snapshot.content], { type: "text/plain;charset=utf-8" }), `cloudx-${snapshot.source}-${timestamp}.log`);
  }

  return <section className="logs-panel" aria-label="Log viewer">
    <div className="logs-toolbar">
      <label><span>Log source</span><select value={source} onChange={event => setSource(event.target.value as CloudxLogSource)}>
        {CLOUDX_LOG_SOURCES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      <div className="logs-actions">
        <ControlButton onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16} aria-hidden="true" />Refresh logs</ControlButton>
        <ControlButton onClick={download} disabled={!snapshot?.content || loading}><Download size={16} aria-hidden="true" />Download logs</ControlButton>
      </div>
    </div>
    <p>{CLOUDX_LOG_SOURCES.find(option => option.id === source)?.description}</p>
    <p>Recent entries only, up to 1,000 records or lines and 1 MiB. Refresh to capture new logs.</p>
    {loading ? <p role="status">Loading logs…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {snapshot ? <>
      <p className="logs-snapshot-time">Captured <time dateTime={snapshot.capturedAt}>{new Date(snapshot.capturedAt).toLocaleString()}</time></p>
      {snapshot.truncated ? <p role="status">Some entries were omitted to keep this snapshot within the log limits.</p> : null}
      {snapshot.content ? <pre className="logs-content" aria-label="Log contents" tabIndex={0}>{snapshot.content}</pre> : <p role="status">No logs available for this source.</p>}
    </> : null}
  </section>;
}
