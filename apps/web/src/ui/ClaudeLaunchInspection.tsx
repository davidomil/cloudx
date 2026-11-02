import { useEffect, useRef, useState } from "react";
import type { AgentLaunchRecord } from "@cloudx/shared";
import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";
import { AgentLaunchRecordView } from "./AgentLaunchRecordView.js";

export function ClaudeLaunchInspection({ callHook, disabled }: { callHook: NonNullable<UiContributionRenderContext["callHook"]>; disabled?: boolean }) {
  const [tabId, setTabId] = useState("");
  const [record, setRecord] = useState<AgentLaunchRecord>();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function inspect() {
    const current = ++revision.current;
    setPending(true); setRecord(undefined); setMessage("");
    try {
      const result = await callHook<{ launchRecord?: AgentLaunchRecord }>("claude-settings.inspect-launch", { tabId });
      if (revision.current !== current) return;
      setRecord(result.launchRecord);
      if (!result.launchRecord) setMessage("No launch-time record exists for this Claude tab. Historical version, account and arguments remain unobserved.");
    } catch { if (revision.current === current) setMessage("Launch record unavailable. Check the tab ID and owned record; no native client was started or changed."); }
    finally { if (revision.current === current) setPending(false); }
  }
  return <details><summary>Inspect a recorded Claude launch</summary>
    <p>Read launch-time facts for an existing Claude tab or Forge worker. This does not query a model or change a native session.</p>
    <label>Claude tab or worker tab ID<input aria-label="Claude launch inspection tab ID" value={tabId} disabled={disabled} onChange={event => { revision.current++; setTabId(event.target.value); setRecord(undefined); setMessage(""); setPending(false); }} /></label>
    <ControlButton disabled={disabled || pending || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(tabId)} onClick={() => void inspect()}>{pending ? "Inspecting…" : "Inspect recorded launch"}</ControlButton>
    {message ? <p role="status">{message}</p> : null}
    {record ? <AgentLaunchRecordView record={record} /> : null}
  </details>;
}
