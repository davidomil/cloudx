import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { type CodexCommandDetails as RecordedCommand, type CodexCommandDetailsSnapshot } from "@cloudx/shared";

import { readCodexCommandDetails } from "../api.js";
import { ControlButton } from "./Control.js";

interface CommandSelection {
  executionId: string;
  key: string;
}

export function CodexCommandDetails({ tabId, tabTitle, active }: { tabId: string; tabTitle: string; active: boolean }) {
  const [snapshot, setSnapshot] = useState<CodexCommandDetailsSnapshot>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<CommandSelection>();
  const [opened, setOpened] = useState<CommandSelection>();
  const scope = useRef({ tabId, active });
  scope.current = { tabId, active };

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let executionId: string | undefined;
    const abort = new AbortController();
    setSnapshot(undefined);
    setError(undefined);
    setSelected(undefined);
    setOpened(undefined);
    if (!active) return;

    const read = async () => {
      try {
        const next = await readCodexCommandDetails(tabId, abort.signal);
        if (disposed || !scope.current.active || scope.current.tabId !== tabId) return;
        if (next.tabId !== tabId) throw new Error("Command details belong to another tab.");
        if (executionId !== next.executionId || next.status !== "available") {
          setOpened(undefined);
          setSelected(undefined);
        } else {
          setOpened(current => current && next.commands.some(item => commandKey(item) === current.key) ? current : undefined);
        }
        executionId = next.executionId;
        setSnapshot(next);
        setError(undefined);
      } catch {
        if (disposed || !scope.current.active || scope.current.tabId !== tabId) return;
        setSnapshot(undefined);
        setOpened(undefined);
        setError("Command details could not be read.");
      } finally {
        if (!disposed) timer = window.setTimeout(() => { void read(); }, 1_000);
      }
    };
    void read();
    return () => { disposed = true; abort.abort(); window.clearTimeout(timer); };
  }, [tabId, active]);

  if (!active || snapshot && snapshot.tabId !== tabId) return null;
  const commands = snapshot?.status === "available" ? snapshot.commands : [];
  const command = selected && selected.executionId === snapshot?.executionId
    ? commands.find(item => commandKey(item) === selected.key) ?? commands.at(-1)
    : commands.at(-1);
  const openedCommand = opened && opened.executionId === snapshot?.executionId
    ? commands.find(item => commandKey(item) === opened.key)
    : undefined;

  return <section className="codex-command-details" aria-label="Codex command details">
    <FileText size={14} aria-hidden="true" />
    {command && snapshot ? <>
      {commands.length > 1 ? <select aria-label="Recent Codex commands" value={commandKey(command)} onChange={event => {
        setSelected({ executionId: snapshot.executionId, key: event.target.value });
      }}>
        {commands.map((item, index) => <option key={commandKey(item)} value={commandKey(item)}>{index + 1}. {commandSummary(item.command)}</option>)}
      </select> : <span className="codex-command-summary">{commandSummary(command.command)}</span>}
      <span className="codex-command-status">{commandStatus(command)}</span>
      <ControlButton size="compact" aria-label="Open command details" onClick={() => {
        setOpened({ executionId: snapshot.executionId, key: commandKey(command) });
      }}>Details</ControlButton>
    </> : <span className="codex-command-summary" role={error ? "alert" : undefined}>
      {error ?? (snapshot?.status === "unavailable" ? snapshot.reason ?? "Command details are unavailable for this session." : snapshot ? "No commands recorded yet." : "Reading command details…")}
    </span>}
    {openedCommand && snapshot && opened ? <CommandDialog key={`${opened.executionId}:${opened.key}`} tabId={tabId} tabTitle={tabTitle} executionId={snapshot.executionId} command={openedCommand} onDismiss={() => setOpened(undefined)} /> : null}
  </section>;
}

function CommandDialog({ tabId, tabTitle, executionId, command, onDismiss }: {
  tabId: string;
  tabTitle: string;
  executionId: string;
  command: RecordedCommand;
  onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const output = outputRef.current!;
    if (output.value === command.output) return;
    const { selectionStart, selectionEnd, selectionDirection, scrollTop, scrollLeft } = output;
    output.value = command.output;
    output.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    output.scrollTop = scrollTop;
    output.scrollLeft = scrollLeft;
  }, [command.output]);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const origin = document.activeElement;
    const dismiss = () => dismissRef.current();
    const cancel = (event: Event) => { event.preventDefault(); event.stopPropagation(); dismiss(); };
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("close", dismiss);
    dialog.showModal();
    return () => {
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("close", dismiss);
      if (dialog.open) dialog.close();
      if (origin instanceof HTMLElement && origin.isConnected && !origin.closest("[hidden]")) origin.focus({ preventScroll: true });
    };
  }, []);

  return <dialog className="codex-command-dialog" ref={dialogRef} aria-label="Codex command and output" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onDismiss(); }
  }} onKeyUp={event => event.stopPropagation()}>
    <header>
      <h2>Command and output</h2>
      <ControlButton size="compact" aria-label="Close command details" onClick={onDismiss}><X size={16} aria-hidden="true" /> Close</ControlButton>
    </header>
    <div className="codex-command-origin">
      <strong>{tabTitle}</strong> <span>{commandStatus(command)}{command.exitCode !== undefined ? ` · exit ${command.exitCode}` : ""}</span>
      <small>Tab: {tabId} · Execution: {executionId} · Command: {command.id}</small>
      <small>Thread: {command.threadId} · Turn: {command.turnId}</small>
      <small>Directory: {command.cwd}</small>
    </div>
    <label>Full command<textarea aria-label="Full command" value={command.command} readOnly spellCheck={false} wrap="off" /></label>
    {command.commandTruncated ? <p className="codex-command-retention" role="status">Command exceeds the retained size limit; the text shown is truncated.</p> : null}
    <label className="codex-command-output">Command output<textarea aria-label="Command output" ref={outputRef} readOnly spellCheck={false} wrap="off" placeholder={command.status === "inProgress" ? "Waiting for output…" : "No output recorded."} /></label>
    {command.outputTruncated ? <p className="codex-command-retention" role="status">Output exceeds the retained size limit; the text shown is truncated.</p> : null}
  </dialog>;
}

function commandKey(command: RecordedCommand): string {
  return JSON.stringify([command.threadId, command.turnId, command.id]);
}

function commandSummary(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 160);
}

function commandStatus(command: RecordedCommand): string {
  return command.status === "inProgress" ? "Running" : command.status === "completed" ? "Completed" : command.status === "declined" ? "Declined" : "Failed";
}
