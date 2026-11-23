import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { parseTerminalMemoryLimits, type TerminalMemoryLimits, type TerminalMemoryStatus } from "@cloudx/shared";

import { getTerminalMemory, setTerminalMemory } from "../api.js";
import { ControlButton } from "./Control.js";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
type MemoryUnit = typeof UNITS[number] | "infinity";
interface MemoryInput { amount: string; unit: MemoryUnit }
interface MemoryDraft { memoryHigh: MemoryInput; memoryMax: MemoryInput }

function inputFrom(value: string | null): MemoryInput {
  if (value === "infinity") return { amount: "", unit: "infinity" };
  if (value === null) return { amount: "", unit: "GiB" };
  const bytes = BigInt(value);
  if (bytes === 0n) return { amount: "0", unit: "B" };
  const index = UNITS.reduce((selected, _unit, index) => bytes % 1024n ** BigInt(index) === 0n ? index : selected, 0);
  return { amount: String(bytes / 1024n ** BigInt(index)), unit: UNITS[index]! };
}

function draftFrom(status: TerminalMemoryStatus): MemoryDraft {
  return { memoryHigh: inputFrom(status.limits.memoryHigh), memoryMax: inputFrom(status.limits.memoryMax) };
}

function limitsFrom(draft: MemoryDraft): TerminalMemoryLimits {
  const value = ({ amount, unit }: MemoryInput) => unit === "infinity" ? unit : `${amount}${unit}`;
  return parseTerminalMemoryLimits({ memoryHigh: value(draft.memoryHigh), memoryMax: value(draft.memoryMax) });
}

function memoryLabel(value: string | null) {
  if (value === null) return "Unknown";
  if (value === "infinity") return "Unlimited";
  const input = inputFrom(value);
  const label = BigInt(input.amount) >= 1024n ? usageLabel(Number(value)) : `${input.amount} ${input.unit}`;
  return <span title={`${value} B`}>{label}</span>;
}

function usageLabel(bytes: number | null): string {
  if (bytes === null) return "Unknown";
  const index = UNITS.reduce((selected, _unit, index) => bytes >= 1024 ** index ? index : selected, 0);
  return `${index ? (bytes / 1024 ** index).toFixed(2) : bytes} ${UNITS[index]}`;
}

export function TerminalMemoryPanel() {
  const [status, setStatus] = useState<TerminalMemoryStatus>();
  const [draft, setDraft] = useState<MemoryDraft>();
  const [busy, setBusy] = useState<"loading" | "applying" | null>("loading");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const request = useRef<AbortController | null>(null);

  const run = useCallback(async (kind: "loading" | "applying", action: (signal: AbortSignal) => Promise<TerminalMemoryStatus>) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action(controller.signal);
      if (controller.signal.aborted) return;
      setStatus(result);
      setDraft(draftFrom(result));
      if (kind === "applying") setNotice("Terminal memory limits applied and persisted. Effective limits were read back. Terminal sessions keep running.");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }, []);
  const refresh = useCallback(() => run("loading", getTerminalMemory), [run]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);

  let limits: TerminalMemoryLimits | undefined;
  let validation: string | undefined;
  if (draft) {
    try { limits = limitsFrom(draft); }
    catch (cause) { validation = cause instanceof Error ? cause.message : String(cause); }
  }
  const changed = limits && (limits.memoryHigh !== status?.limits.memoryHigh || limits.memoryMax !== status?.limits.memoryMax);
  const canApply = busy === null && status?.manageable && limits && changed;
  const limitsDiffer = status && (["memoryHigh", "memoryMax"] as const).some(key => status.limits[key] !== null && status.effective[key] !== null && status.limits[key] !== status.effective[key]);

  function change(key: keyof MemoryDraft, next: MemoryInput) {
    setDraft(current => current ? { ...current, [key]: next } : current);
    setNotice(undefined);
  }

  return <section className="codex-settings-panel" aria-label="Terminal service memory" aria-busy={busy !== null}>
    <header className="codex-settings-header">
      <h2>Terminal service memory</h2>
      <p>These limits cover the persistent terminal broker and all its child workloads, including terminals and agents. The web service and Node.js JavaScript heap settings are separate.</p>
      <p>MemoryHigh throttles workloads above the threshold. MemoryMax is the hard ceiling and can cause out-of-memory kills. Apply changes live without restarting the broker. Saved limits survive service restarts, reboots and managed updates.</p>
    </header>
    <div className="codex-settings-form">
      <div className="codex-settings-actions"><ControlButton disabled={busy !== null} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" /> {busy === "loading" ? "Reading memory…" : "Refresh memory"}</ControlButton></div>
      {error ? <p className="codex-settings-notice" role="alert">{error}</p> : null}
      {notice ? <p className="codex-settings-notice" role="status">{notice}</p> : null}
      {status ? <>
        <p><code>{status.service}</code> · {status.activeState ?? "State unknown"}</p>
        {!status.manageable ? <p className="codex-settings-notice" role="status">Memory controls are unavailable. {status.reason ?? "This installation cannot manage terminal service memory limits."}</p> : null}
        <table aria-label="Observed terminal memory">
          <thead><tr><th>Reading</th><th>Configured</th><th>Effective</th></tr></thead>
          <tbody>
            <tr><th>MemoryHigh</th><td>{memoryLabel(status.limits.memoryHigh)}</td><td>{memoryLabel(status.effective.memoryHigh)}</td></tr>
            <tr><th>MemoryMax</th><td>{memoryLabel(status.limits.memoryMax)}</td><td>{memoryLabel(status.effective.memoryMax)}</td></tr>
          </tbody>
        </table>
        <p>Current usage: <strong>{usageLabel(status.usageBytes)}</strong></p>
        <small>Parent cgroups can impose tighter limits. Unlimited applies to the service's own setting. Effective values also reflect kernel page-size rounding. {limitsDiffer ? "The effective limits differ from the configured values; inspect inherited constraints and physical memory capacity." : "Unknown means the reading is unavailable."}</small>
        <p>Memory pressure (10-second average): {status.pressure ? <>some <strong>{status.pressure.someAvg10.toFixed(2)}%</strong> · full <strong>{status.pressure.fullAvg10.toFixed(2)}%</strong></> : "Unknown"}</p>
        <small>Some means at least one task stalled. Full means all non-idle tasks stalled. Machine-wide free RAM does not rule out a service memory constraint.</small>
        <p>Memory events: {status.events ? <>throttling (high) <strong>{status.events.high}</strong> · OOM <strong>{status.events.oom}</strong> · OOM kills <strong>{status.events.oomKill}</strong></> : "Unknown"}</p>
        <small>Event counters are cumulative for this cgroup. Refresh to compare readings.</small>
        <details><summary>Systemd configuration and existing overrides</summary>
          <p>Unit: <code>{status.fragmentPath ?? "Unknown"}</code></p>
          <p>Control group: <code>{status.controlGroup ?? "Unknown"}</code></p>
          <p>Drop-ins:</p>
          {status.dropInPaths.length ? <ul>{status.dropInPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p>No drop-ins reported.</p>}
        </details>
        {draft ? <fieldset className="codex-settings-group" disabled={busy !== null || !status.manageable}>
          <legend>Set terminal memory limits</legend>
          <MemoryLimitControl label="MemoryHigh" description="Throttling threshold" value={draft.memoryHigh} onChange={next => change("memoryHigh", next)} />
          <MemoryLimitControl label="MemoryMax" description="Hard ceiling" value={draft.memoryMax} onChange={next => change("memoryMax", next)} />
          <small>KiB, MiB, GiB and TiB use powers of 1024. Finite MemoryHigh must not exceed finite MemoryMax.</small>
          {validation && status.manageable ? <p role="alert">{validation}</p> : null}
          <div className="codex-settings-actions"><ControlButton disabled={!canApply} onClick={() => { if (limits) void run("applying", signal => setTerminalMemory(limits, signal)); }}><Save size={16} aria-hidden="true" /> {busy === "applying" ? "Applying memory…" : "Apply terminal memory"}</ControlButton></div>
          <small>This action applies and persists only terminal memory limits. The Settings Save button does not apply these controls.</small>
        </fieldset> : null}
      </> : null}
    </div>
  </section>;
}

function MemoryLimitControl({ label, description, value, onChange }: { label: string; description: string; value: MemoryInput; onChange: (next: MemoryInput) => void }) {
  return <div>
    <label><span>{label} · {description}</span>
      <select aria-label={`${label} unit`} value={value.unit} onChange={event => onChange({ ...value, unit: event.target.value as MemoryUnit })}>
        {UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
        <option value="infinity">Unlimited</option>
      </select>
    </label>
    {value.unit !== "infinity" ? <label><span>{label} amount ({value.unit})</span><input aria-label={`${label} amount`} type="text" inputMode="decimal" value={value.amount} placeholder="Enter a positive size" onChange={event => onChange({ ...value, amount: event.target.value })} /></label> : null}
  </div>;
}
