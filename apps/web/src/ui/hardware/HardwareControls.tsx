import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { ControlButton } from "../Control.js";
import type {
  BashScript,
  HardwareHistoryEntry,
  HardwareSummary,
  OperationReceipt,
  StatusDefinition,
  StatusValue,
} from "@cloudx/shared";

export type HardwareRun = (
  action: string,
  input: Record<string, unknown>,
) => Promise<OperationReceipt | undefined>;

export function HardwareDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const element = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = element.current!;
    const controls = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ].filter((control) => !control.closest("[hidden]"));
    (
      dialog.querySelector<HTMLElement>("input,select,textarea") ??
      controls()[0]
    )?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === "Tab") {
        const targets = controls();
        const index = targets.indexOf(document.activeElement as HTMLElement);
        if (!targets.length) event.preventDefault();
        else if (
          index < 0 ||
          (!event.shiftKey && index === targets.length - 1)
        ) {
          event.preventDefault();
          targets[0]?.focus();
        } else if (event.shiftKey && index === 0) {
          event.preventDefault();
          targets.at(-1)?.focus();
        }
      }
    };
    dialog.addEventListener("keydown", keyboard);
    return () => {
      dialog.removeEventListener("keydown", keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="hardware-modal-backdrop">
      <section
        ref={element}
        className="hardware-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <ControlButton
            iconOnly
            size="compact"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={16} />
          </ControlButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function StatusInput({
  label,
  definition,
  value,
  onChange,
  disabled,
}: {
  label: string;
  definition: StatusDefinition;
  value: StatusValue;
  onChange: (value: StatusValue) => void;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      {definition.valueType === "boolean" || definition.valueType === "enum" ? (
        <select
          aria-label={label}
          disabled={disabled}
          value={String(value)}
          onChange={(event) =>
            onChange(
              definition.valueType === "boolean"
                ? event.target.value === "true"
                : event.target.value,
            )
          }
        >
          {(definition.valueType === "boolean"
            ? ["true", "false"]
            : (definition.enumValues ?? [])
          ).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          disabled={disabled}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

export const emptyScript = (): BashScript => ({
  source: "",
  cwd: "/",
  timeoutMs: 30000,
  maxOutputBytes: 65536,
  credentialRefIds: [],
});

export function ScriptFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: BashScript;
  onChange: (value: BashScript) => void;
}) {
  return (
    <div className="hardware-script-fields">
      <label>
        {label}
        <textarea
          aria-label={label}
          className="hardware-code"
          required
          value={value.source}
          onChange={(event) =>
            onChange({ ...value, source: event.target.value })
          }
          rows={3}
          spellCheck={false}
        />
      </label>
      <div className="hardware-form-grid">
        <label>
          Working directory
          <input
            aria-label={`${label} working directory`}
            required
            value={value.cwd}
            placeholder="/srv/lab-hooks"
            onChange={(event) =>
              onChange({ ...value, cwd: event.target.value })
            }
          />
        </label>
        <label>
          Deadline (ms)
          <input
            aria-label={`${label} deadline`}
            type="number"
            required
            min={1}
            max={3600000}
            value={value.timeoutMs}
            onChange={(event) =>
              onChange({ ...value, timeoutMs: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <details className="hardware-script-advanced">
        <summary>{label} execution limits</summary>
        <div className="hardware-form-grid">
          <label>
            Output limit (bytes)
            <input
              aria-label={`${label} output limit`}
              type="number"
              min={1}
              max={1048576}
              required
              value={value.maxOutputBytes}
              onChange={(event) =>
                onChange({
                  ...value,
                  maxOutputBytes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Credential references
            <input
              aria-label={`${label} credential references`}
              value={value.credentialRefIds.join(", ")}
              onChange={(event) =>
                onChange({
                  ...value,
                  credentialRefIds: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
              placeholder="Comma-separated reference IDs"
            />
          </label>
        </div>
        <p className="hardware-muted">
          Credential references require a configured host credential resolver.
          Values never travel to this form.
        </p>
      </details>
    </div>
  );
}

export function ReceiptView({ receipt }: { receipt: OperationReceipt }) {
  return (
    <article
      className={`hardware-receipt outcome-${receipt.state}`}
      aria-label="Operation receipt"
    >
      <header>
        <strong>
          {receipt.state === "running" ? "Operation pending" : receipt.state}
        </strong>
        <code>{receipt.requestId}</code>
      </header>
      {receipt.error ? (
        <p role="alert">
          {receipt.error.code}: {receipt.error.message}
        </p>
      ) : null}
      {receipt.outputPruned ? (
        <p className="hardware-muted">
          Output pruned; the original operation will not run again. The{" "}
          {receipt.outputPruned.reason} retention limit removed output at{" "}
          {new Date(receipt.outputPruned.at).toLocaleString()}. The request
          receipt remains recorded.
        </p>
      ) : null}
      {receipt.result ? (
        <pre>{JSON.stringify(receipt.result, null, 2)}</pre>
      ) : null}
    </article>
  );
}

export function Observation({
  summary,
  definitionId,
  detailed = false,
  detailsOnly = false,
}: {
  summary: HardwareSummary;
  definitionId: string;
  detailed?: boolean;
  detailsOnly?: boolean;
}) {
  const observation = summary.observations.find(
    (value) => value.definitionId === definitionId,
  );
  const binding = summary.item.statuses.find(
    (value) => value.definitionId === definitionId,
  );
  const value =
    observation?.state === "known"
      ? observation.value
      : binding?.source === "manual"
        ? binding.value
        : undefined;
  const stale = Boolean(
    observation?.expiresAt && Date.parse(observation.expiresAt) <= Date.now(),
  );
  const nextCheck =
    binding?.source === "command" && binding.intervalMs !== null
      ? observation
        ? new Date(
            Date.parse(observation.observedAt) + binding.intervalMs,
          ).toLocaleString()
        : "Due"
      : "Manual refresh";
  return (
    <span className="hardware-observation-container">
      {detailsOnly ? null : (
        <span
          className={`hardware-observation ${stale || observation?.state === "error" ? "warning" : value === true ? "positive" : ""}`}
          title={
            observation?.errorCode ??
            (observation
              ? `Observed ${new Date(observation.observedAt).toLocaleString()}`
              : "No command observation")
          }
        >
          {value === undefined
            ? observation?.state === "error"
              ? "Error"
              : "Unknown"
            : String(value)}
          {stale
            ? " · stale"
            : binding?.source === "manual"
              ? " · manual"
              : observation?.state === "known"
                ? " · fresh"
                : ""}
        </span>
      )}
      {detailed ? (
        <small className="hardware-observation-details">
          Source: {binding?.source ?? "unbound"} · Observed:{" "}
          {observation
            ? new Date(observation.observedAt).toLocaleString()
            : "never"}
          {observation?.expiresAt
            ? ` · Expires: ${new Date(observation.expiresAt).toLocaleString()}`
            : ""}
          {observation?.errorCode ? ` · Error: ${observation.errorCode}` : ""}
          {binding?.source === "command"
            ? ` · Next check: ${summary.reservation || summary.checkHold ? "paused while group is held" : nextCheck}`
            : ""}
        </small>
      ) : null}
    </span>
  );
}

export function HardwareHistory({
  entries,
}: {
  entries: HardwareHistoryEntry[];
}) {
  return (
    <section className="hardware-card">
      <h3>Activity</h3>
      {entries.length ? (
        <ol className="hardware-history">
          {[...entries].reverse().map((entry) => (
            <li key={entry.id}>
              <time>{new Date(entry.at).toLocaleString()}</time>
              <strong>{entry.kind.replaceAll("_", " ")}</strong>
              <p>{entry.detail}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hardware-muted">No activity recorded.</p>
      )}
    </section>
  );
}
