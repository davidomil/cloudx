import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  Edit3,
  Play,
  Terminal,
  Upload,
} from "lucide-react";
import type {
  HardwareStateView,
  HardwareSummary,
  JsonObject,
  OperationReceipt,
} from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import {
  HardwareHistory,
  ReceiptView,
  type HardwareRun,
} from "./HardwareControls.js";
import { ownerLabel, sameOwner, uartBytes, uartText } from "./hardwareModel.js";

export function HardwareAccess({
  state,
  summary,
  busy,
  run,
  receipt,
  onBack,
  onEdit,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  busy: boolean;
  run: HardwareRun;
  receipt?: OperationReceipt;
  onBack: () => void;
  onEdit: () => void;
}) {
  const claim = summary.reservation;
  const [connectionRequest, setConnectionRequest] = useState<{
    id: string;
    opening: boolean;
  }>();
  const [error, setError] = useState<string>();
  const owned = Boolean(claim && sameOwner(claim.owner, state.currentOwner));
  const active = Boolean(
    owned && claim?.state === "active" && claim.hardwareId === summary.item.id,
  );
  const confirmed = active && claim?.accessState === "open";
  const currentReceipt =
    receipt?.reservation &&
    (!claim ||
      (receipt.reservation.reservationId === claim.reservationId &&
        receipt.reservation.generation === claim.generation))
      ? receipt
      : undefined;
  useEffect(() => {
    const result =
      connectionRequest &&
      state.receipts.find((value) => value.requestId === connectionRequest.id);
    if (result && result.state !== "running") setConnectionRequest(undefined);
  }, [active, connectionRequest, state.receipts]);
  async function connection(opening: boolean) {
    if (!claim) return;
    const result = await run(
      opening ? "hardware.access.open" : "hardware.access.close",
      { reservationId: claim.reservationId, generation: claim.generation },
    );
    if (result?.state === "running")
      setConnectionRequest({ id: result.requestId, opening });
  }
  async function invoke(operationId: string, input: JsonObject) {
    setError(undefined);
    if (!claim || !active || !confirmed) {
      setError(
        "Open access for this active reservation before invoking an operation.",
      );
      return;
    }
    await run("hardware.access.invoke", {
      reservationId: claim.reservationId,
      generation: claim.generation,
      operationId,
      input,
    });
  }
  return (
    <section className="hardware-access">
      <header className="hardware-view-heading">
        <div className="hardware-inline">
          <ControlButton size="compact" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to inventory
          </ControlButton>
          <h2>
            {summary.item.name} /{" "}
            {state.types.find((type) => type.id === summary.item.typeId)
              ?.displayName ?? summary.item.typeId}
          </h2>
        </div>
        <ControlButton size="compact" onClick={onEdit}>
          <Edit3 size={14} />
          Edit hardware
        </ControlButton>
      </header>
      <div className="hardware-reservation-strip">
        <strong>
          {claim
            ? `${ownerLabel(claim.owner)} / ${claim.purpose}`
            : "No active reservation"}
        </strong>
        {claim ? (
          <code>
            {claim.reservationId} · generation {claim.generation} ·{" "}
            {claim.state}
          </code>
        ) : null}
      </div>
      <p className="hardware-banner hardware-notes">
        <strong>Notes for agents:</strong>{" "}
        {summary.item.notes || "No notes provided."}
      </p>
      <div className="hardware-inline hardware-access-admission">
        <ControlButton
          tone="primary"
          disabled={busy || !active || confirmed || Boolean(connectionRequest)}
          onClick={() => void connection(true)}
        >
          Open access
        </ControlButton>
        <ControlButton
          disabled={
            busy || !owned || !claim || !confirmed || Boolean(connectionRequest)
          }
          onClick={() => void connection(false)}
        >
          Close access
        </ControlButton>
        <span className="hardware-muted">
          {confirmed
            ? "Managed connection confirmed open"
            : claim?.accessState === "opening" ||
                claim?.accessState === "closing"
              ? `Managed connection ${claim.accessState}`
              : "Open access to confirm the managed connection"}
        </span>
      </div>
      {!active ? (
        <p className="hardware-banner warning">
          Access requires an active reservation owned by you. Preparing,
          recovery, or another owner grants no access.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="hardware-banner danger">
          {error}
        </p>
      ) : null}
      {summary.item.typeId === "hardware.ssh" ? (
        <SshAccess disabled={busy || !active || !confirmed} invoke={invoke} />
      ) : summary.item.typeId === "hardware.uart" ? (
        <UartAccess
          disabled={busy || !active || !confirmed}
          invoke={invoke}
          receipt={currentReceipt}
        />
      ) : (
        <ProviderAccess
          state={state}
          summary={summary}
          disabled={busy || !active || !confirmed}
          invoke={invoke}
        />
      )}
      {currentReceipt ? <ReceiptView receipt={currentReceipt} /> : null}
      <HardwareHistory
        entries={state.history.filter(
          (entry) =>
            entry.reservationId === claim?.reservationId ||
            entry.hardwareId === summary.item.id,
        )}
      />
      <footer className="hardware-form-actions">
        <p className="hardware-muted">
          Closing a connection does not release its reservation. Unknown effects
          keep hardware held.
        </p>
        <ControlButton
          tone="primary"
          disabled={busy || !active}
          onClick={() => {
            if (claim)
              void run("hardware.release", {
                reservationId: claim.reservationId,
                generation: claim.generation,
              });
          }}
        >
          Release hardware
        </ControlButton>
      </footer>
    </section>
  );
}

function SshAccess({
  disabled,
  invoke,
}: {
  disabled: boolean;
  invoke: (operation: string, input: JsonObject) => Promise<void>;
}) {
  const [script, setScript] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [maxOutputBytes, setMaxOutputBytes] = useState(65536);
  const [direction, setDirection] = useState("upload");
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [transferTimeout, setTransferTimeout] = useState(60000);
  return (
    <div className="hardware-columns hardware-access-columns">
      <section className="hardware-card">
        <h2>
          <Terminal size={19} />
          SSH access
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("ssh.exec", { script, timeoutMs, maxOutputBytes });
          }}
        >
          <fieldset disabled={disabled}>
            <label>
              Remote Bash script
              <textarea
                aria-label="Remote Bash script"
                className="hardware-code"
                required
                rows={8}
                value={script}
                spellCheck={false}
                onChange={(event) => setScript(event.target.value)}
                placeholder="uname -m"
              />
            </label>
            <div className="hardware-form-grid">
              <label>
                Deadline (ms)
                <input
                  aria-label="Script deadline"
                  type="number"
                  required
                  min={1}
                  max={3600000}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                />
              </label>
              <label>
                Output limit (bytes)
                <input
                  aria-label="Script output limit"
                  type="number"
                  required
                  min={1}
                  max={1048576}
                  value={maxOutputBytes}
                  onChange={(event) =>
                    setMaxOutputBytes(Number(event.target.value))
                  }
                />
              </label>
            </div>
            <ControlButton type="submit" tone="primary">
              <Play size={14} />
              Run script
            </ControlButton>
          </fieldset>
        </form>
        <p className="hardware-muted">
          Script bytes travel to remote Bash. A command exit code is separate
          from an uncertain transport outcome.
        </p>
      </section>
      <section className="hardware-card">
        <h2>
          <Upload size={19} />
          File transfer
        </h2>
        <div
          className="hardware-subtabs"
          role="group"
          aria-label="Transfer direction"
        >
          <ControlButton
            selected={direction === "upload"}
            onClick={() => setDirection("upload")}
          >
            <Upload size={14} />
            Upload
          </ControlButton>
          <ControlButton
            selected={direction === "download"}
            onClick={() => setDirection("download")}
          >
            <Download size={14} />
            Download
          </ControlButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void invoke(`ssh.${direction}`, {
              localPath,
              remotePath,
              overwrite,
              timeoutMs: transferTimeout,
            });
          }}
        >
          <fieldset disabled={disabled}>
            <label>
              Local file
              <input
                aria-label="Local file"
                required
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder="/workspace/artifacts/image.bin"
              />
            </label>
            <label>
              Remote path
              <input
                aria-label="Remote path"
                required
                value={remotePath}
                onChange={(event) => setRemotePath(event.target.value)}
                placeholder="/srv/validation/image.bin"
              />
            </label>
            <label className="hardware-checkbox">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              Overwrite if file exists
            </label>
            <label>
              Deadline (ms)
              <input
                aria-label="Transfer deadline"
                type="number"
                required
                min={1}
                max={3600000}
                value={transferTimeout}
                onChange={(event) =>
                  setTransferTimeout(Number(event.target.value))
                }
              />
            </label>
            <ControlButton tone="primary" type="submit">
              {direction === "upload" ? (
                <Upload size={14} />
              ) : (
                <Download size={14} />
              )}
              {direction === "upload" ? "Upload file" : "Download file"}
            </ControlButton>
          </fieldset>
        </form>
        <p className="hardware-muted">
          Paths refer to files on the CloudX host and the reserved machine.
          Regular files only; host path policy applies.
        </p>
      </section>
    </div>
  );
}

function UartAccess({
  disabled,
  invoke,
  receipt,
}: {
  disabled: boolean;
  invoke: (operation: string, input: JsonObject) => Promise<void>;
  receipt?: OperationReceipt;
}) {
  const [durationMs, setDurationMs] = useState(2000);
  const [maxBytes, setMaxBytes] = useState(4096);
  const [mode, setMode] = useState<"text" | "base64">("text");
  const [ending, setEnding] = useState("none");
  const [data, setData] = useState("");
  const [lines, setLines] = useState({ rts: "unchanged", dtr: "unchanged" });
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string>();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (
      !receipt ||
      receipt.state !== "succeeded" ||
      seen.current.has(receipt.requestId) ||
      typeof receipt.result?.dataBase64 !== "string"
    )
      return;
    seen.current.add(receipt.requestId);
    try {
      const text = uartText(receipt.result.dataBase64);
      setTranscript((current) =>
        (
          current +
          `[${new Date().toLocaleTimeString()}] RX ${text || "(quiet window)"}\n`
        ).slice(-4 * 1024 * 1024),
      );
    } catch {
      setError(
        "Received invalid base64 data. Inspect the original operation receipt.",
      );
    }
  }, [receipt]);
  async function write() {
    try {
      const bytes = uartBytes(data, mode, ending);
      if (bytes.length > 1398104)
        throw new Error("Transmit data exceeds 1 MiB.");
      setError(undefined);
      await invoke("uart.write", { dataBase64: bytes, timeoutMs: 30000 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <div className="hardware-columns">
      <section className="hardware-card">
        <h2>
          <Terminal size={19} />
          UART access
        </h2>
        <label>
          Session transcript
          <pre
            className="hardware-transcript"
            tabIndex={0}
            aria-label="UART transcript"
          >
            {transcript ||
              "No received bytes in this view. Read a bounded window to receive data."}
          </pre>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void invoke("uart.read", { durationMs, maxBytes });
          }}
        >
          <fieldset disabled={disabled} className="hardware-inline">
            <label>
              Read window (ms)
              <input
                aria-label="Read window"
                type="number"
                min={1}
                max={60000}
                required
                value={durationMs}
                onChange={(event) => setDurationMs(Number(event.target.value))}
              />
            </label>
            <label>
              Max bytes
              <input
                aria-label="Read max bytes"
                type="number"
                min={1}
                max={1048576}
                required
                value={maxBytes}
                onChange={(event) => setMaxBytes(Number(event.target.value))}
              />
            </label>
            <ControlButton tone="primary" type="submit">
              <Play size={14} />
              Read bytes
            </ControlButton>
          </fieldset>
        </form>
        <div className="hardware-inline">
          <ControlButton size="compact" onClick={() => setTranscript("")}>
            Clear transcript
          </ControlButton>
          <span className="hardware-muted">
            Transcript retains the last 4 MiB of text. Full operation receipts
            retain base64 bytes.
          </span>
        </div>
      </section>
      <section className="hardware-card">
        <h2>Transmit</h2>
        <div
          className="hardware-subtabs"
          role="group"
          aria-label="Transmit format"
        >
          <ControlButton
            selected={mode === "text"}
            onClick={() => setMode("text")}
          >
            Text
          </ControlButton>
          <ControlButton
            selected={mode === "base64"}
            onClick={() => setMode("base64")}
          >
            Base64
          </ControlButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void write();
          }}
        >
          <fieldset disabled={disabled}>
            <label>
              {mode === "text" ? "Transmit text" : "Transmit base64"}
              <textarea
                aria-label="Transmit data"
                required
                rows={5}
                className="hardware-code"
                value={data}
                onChange={(event) => setData(event.target.value)}
              />
            </label>
            <label>
              Line ending
              <select
                aria-label="Line ending"
                disabled={mode === "base64"}
                value={ending}
                onChange={(event) => setEnding(event.target.value)}
              >
                <option value="none">None</option>
                <option>LF</option>
                <option>CR</option>
                <option>CRLF</option>
              </select>
            </label>
            <ControlButton tone="primary" type="submit">
              <Upload size={14} />
              Send bytes
            </ControlButton>
          </fieldset>
        </form>
        <details>
          <summary>Serial control lines</summary>
          <p className="hardware-muted">
            Set RTS/DTR only. These signals can reset or affect the target.
          </p>
          <fieldset disabled={disabled}>
            <div className="hardware-form-grid">
              {(["rts", "dtr"] as const).map((line) => (
                <label key={line}>
                  {line.toUpperCase()}
                  <select
                    aria-label={line.toUpperCase()}
                    value={lines[line]}
                    onChange={(event) =>
                      setLines({ ...lines, [line]: event.target.value })
                    }
                  >
                    <option value="unchanged">Unchanged</option>
                    <option value="true">Asserted</option>
                    <option value="false">Deasserted</option>
                  </select>
                </label>
              ))}
            </div>
            <ControlButton
              disabled={Object.values(lines).every(
                (value) => value === "unchanged",
              )}
              onClick={() =>
                void invoke("uart.set-lines", {
                  ...Object.fromEntries(
                    Object.entries(lines)
                      .filter(([, value]) => value !== "unchanged")
                      .map(([key, value]) => [key, value === "true"]),
                  ),
                  timeoutMs: 5000,
                })
              }
            >
              Set lines
            </ControlButton>
          </fieldset>
        </details>
        {error ? (
          <p role="alert" className="hardware-banner danger">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ProviderAccess({
  state,
  summary,
  disabled,
  invoke,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  disabled: boolean;
  invoke: (operation: string, input: JsonObject) => Promise<void>;
}) {
  const operations =
    state.types.find((type) => type.id === summary.item.typeId)?.operations ??
    [];
  const [operationId, setOperationId] = useState(operations[0]?.id ?? "");
  const [input, setInput] = useState("{}");
  const [error, setError] = useState<string>();
  return (
    <section className="hardware-card">
      <h2>Provider operations</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const value: unknown = JSON.parse(input);
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Input must be a JSON object.");
            setError(undefined);
            void invoke(operationId, value as JsonObject);
          } catch (cause) {
            setError(String(cause));
          }
        }}
      >
        <fieldset disabled={disabled}>
          <label>
            Operation
            <select
              aria-label="Provider operation"
              value={operationId}
              onChange={(event) => setOperationId(event.target.value)}
            >
              {operations.map((operation) => (
                <option key={operation.id}>{operation.id}</option>
              ))}
            </select>
          </label>
          <label>
            Operation input (JSON)
            <textarea
              aria-label="Operation input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={8}
            />
          </label>
          <ControlButton type="submit" tone="primary" disabled={!operationId}>
            Run operation
          </ControlButton>
        </fieldset>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}
