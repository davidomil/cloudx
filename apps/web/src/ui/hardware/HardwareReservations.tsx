import { useEffect, useRef, useState } from "react";
import { Info, Trash2 } from "lucide-react";
import type {
  HardwareCheckHold,
  HardwareHoldRef,
  HardwareReservation,
  HardwareStateView,
} from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import {
  HardwareDialog,
  HardwareHistory,
  ReceiptView,
  type HardwareRun,
} from "./HardwareControls.js";
import { sameOwner } from "./hardwareModel.js";
import { HardwareOwnerView, type HardwareOwnerProps } from "./HardwareOwner.js";

type Hold = HardwareReservation | HardwareCheckHold;
const isCheck = (hold: Hold): hold is HardwareCheckHold => "runId" in hold;
const holdId = (hold: Hold) =>
  isCheck(hold) ? hold.runId : hold.reservationId;
const targetFor = (hold: Hold): HardwareHoldRef =>
  isCheck(hold)
    ? { kind: "system_check", runId: hold.runId, generation: hold.generation }
    : {
        kind: "reservation",
        reservationId: hold.reservationId,
        generation: hold.generation,
      };

export function HardwareReservations({
  state,
  initialSelectedId,
  busy,
  run,
  onOpenOwner,
  tabs,
  windows,
}: {
  state: HardwareStateView;
  initialSelectedId?: string;
  busy: boolean;
  run: HardwareRun;
} & HardwareOwnerProps) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const details = useRef<HTMLElement>(null);
  useEffect(() => {
    if (initialSelectedId) {
      details.current?.focus({ preventScroll: true });
      details.current?.scrollIntoView({ block: "nearest" });
    }
  }, [initialSelectedId]);
  const [phase, setPhase] = useState("");
  const [ownOnly, setOwnOnly] = useState(false);
  const [override, setOverride] = useState<Hold>();
  const [reason, setReason] = useState("");
  const [accept, setAccept] = useState(false);
  const holds: Hold[] = [...state.reservations, ...state.checkHolds];
  const selected = holds.find((hold) => holdId(hold) === selectedId);
  const ownerTabId =
    selected && !isCheck(selected) && selected.owner.kind === "agent"
      ? selected.owner.tabId
      : undefined;
  const currentExecution = state.agentReadiness?.find(
    (execution) => execution.tabId === ownerTabId,
  );
  const rows = holds.filter(
    (hold) =>
      (!phase || hold.state === phase) &&
      (!ownOnly ||
        (!isCheck(hold) && sameOwner(hold.owner, state.currentOwner))),
  );
  const overrideCurrent =
    override && holds.find((hold) => holdId(hold) === holdId(override));
  const staleOverride = Boolean(
    override &&
    (!overrideCurrent ||
      overrideCurrent.revision !== override.revision ||
      overrideCurrent.generation !== override.generation),
  );
  const unresolved = Boolean(
    override &&
    (override.state === "recovery_required" ||
      (!isCheck(override) && override.activeOperationIds.length)),
  );
  return (
    <>
      <p className="hardware-banner">
        <Info size={17} />
        Heartbeats show activity. They do not expire reservations.
      </p>
      <div className="hardware-filters">
        <label>
          State
          <select
            aria-label="Reservation state filter"
            value={phase}
            onChange={(event) => setPhase(event.target.value)}
          >
            <option value="">All live holds</option>
            {[
              "preparing",
              "active",
              "releasing",
              "checking",
              "recovery_required",
            ].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="hardware-checkbox">
          <input
            type="checkbox"
            checked={ownOnly}
            onChange={(event) => setOwnOnly(event.target.checked)}
          />
          Owned by me
        </label>
      </div>
      <div className="hardware-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Hardware</th>
              <th>Owner</th>
              <th>Purpose</th>
              <th>State</th>
              <th>Held since</th>
              <th>Owner observed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((hold) => {
              const item = state.items.find(
                (value) => value.item.id === hold.hardwareId,
              )?.item;
              return (
                <tr
                  key={holdId(hold)}
                  className={selectedId === holdId(hold) ? "selected" : ""}
                >
                  <td>
                    <strong>{item?.name ?? hold.hardwareId}</strong>
                  </td>
                  <td>
                    {isCheck(hold) ? (
                      "System check"
                    ) : (
                      <HardwareOwnerView
                        owner={hold.owner}
                        tabs={tabs}
                        windows={windows}
                        onOpenOwner={onOpenOwner}
                      />
                    )}
                  </td>
                  <td>{isCheck(hold) ? "Status observation" : hold.purpose}</td>
                  <td>
                    <span className={`hardware-badge state-${hold.state}`}>
                      {hold.state.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td>
                    {new Date(
                      isCheck(hold) ? hold.startedAt : hold.acquiredAt,
                    ).toLocaleString()}
                  </td>
                  <td>
                    {isCheck(hold)
                      ? "System operation"
                      : `${hold.lastOwnerObservation.replaceAll("_", " ")}${hold.lastOwnerObservedAt ? ` · ${new Date(hold.lastOwnerObservedAt).toLocaleTimeString()}` : ""}`}
                  </td>
                  <td className="hardware-inline">
                    <ControlButton
                      size="compact"
                      onClick={() => setSelectedId(holdId(hold))}
                    >
                      Details
                    </ControlButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length ? (
        <div className="hardware-empty">
          <h3>No matching live reservations</h3>
          <p>
            Released hardware becomes available when its admission requirements
            pass.
          </p>
        </div>
      ) : null}
      {selected ? (
        <div className="hardware-columns">
          <section
            className="hardware-card hardware-hold-details"
            aria-label="Hold details"
            tabIndex={-1}
            ref={details}
          >
            <h2>
              {state.items.find(
                (value) => value.item.id === selected.hardwareId,
              )?.item.name ?? selected.hardwareId}
            </h2>
            <dl>
              <dt>Hold</dt>
              <dd>
                <code>{holdId(selected)}</code>
              </dd>
              <dt>Generation / revision</dt>
              <dd>
                {selected.generation} / {selected.revision}
              </dd>
              <dt>State</dt>
              <dd>{selected.state}</dd>
              <dt>Owner</dt>
              <dd>
                {isCheck(selected) ? (
                  "System check"
                ) : (
                  <HardwareOwnerView
                    owner={selected.owner}
                    tabs={tabs}
                    windows={windows}
                    onOpenOwner={onOpenOwner}
                  />
                )}
              </dd>
              <dt>Reason</dt>
              <dd>
                {selected.recoveryReason ?? "No recovery issue reported."}
              </dd>
              {!isCheck(selected) ? (
                <>
                  <dt>Outstanding operations</dt>
                  <dd>{selected.activeOperationIds.join(", ") || "None"}</dd>
                  <dt>Reservation execution</dt>
                  <dd>
                    <pre>{JSON.stringify(selected.owner, null, 2)}</pre>
                  </dd>
                  {selected.owner.kind === "agent" ? (
                    <>
                      <dt>Current tab execution</dt>
                      <dd>
                        <code>
                          {currentExecution?.executionId ??
                            "No current execution evidence"}
                        </code>
                      </dd>
                    </>
                  ) : null}
                </>
              ) : null}
            </dl>
            <p className="hardware-notes">
              {
                state.items.find(
                  (value) => value.item.id === selected.hardwareId,
                )?.item.notes
              }
            </p>
            <div className="hardware-inline">
              {!isCheck(selected) ? (
                <ControlButton
                  disabled={
                    busy ||
                    selected.state !== "active" ||
                    !sameOwner(selected.owner, state.currentOwner)
                  }
                  onClick={() =>
                    void run("hardware.release", {
                      reservationId: selected.reservationId,
                      generation: selected.generation,
                    })
                  }
                >
                  Release own reservation
                </ControlButton>
              ) : null}
              <ControlButton
                tone="danger"
                disabled={busy}
                onClick={() => {
                  setReason("");
                  setAccept(false);
                  setOverride(structuredClone(selected));
                }}
              >
                <Trash2 size={14} />
                Force release…
              </ControlButton>
            </div>
          </section>
          <HardwareHistory
            entries={state.history.filter(
              (entry) => entry.hardwareId === selected.hardwareId,
            )}
          />
        </div>
      ) : null}
      <section className="hardware-card">
        <h3>Recent operation receipts</h3>
        {state.retention ? (
          <p className="hardware-muted" aria-label="Hardware retention">
            Completed details: {state.retention.completedMaxAgeMs / 86_400_000}{" "}
            days · {state.retention.completedMaxEntries.toLocaleString()}{" "}
            entries · {state.retention.outputMaxBytes / 1_048_576} MiB result
            budget. Running and unknown receipts stay retained.
          </p>
        ) : null}
        {[...state.receipts]
          .reverse()
          .slice(0, 20)
          .map((receipt) => (
            <details key={receipt.requestId}>
              <summary>
                {receipt.state} · {receipt.requestId}
              </summary>
              <ReceiptView receipt={receipt} />
            </details>
          ))}
        {!state.receipts.length ? (
          <p className="hardware-muted">No recorded operations.</p>
        ) : null}
      </section>
      {override ? (
        <HardwareDialog
          title={`Force release ${state.items.find((value) => value.item.id === override.hardwareId)?.item.name ?? override.hardwareId}`}
          onClose={() => {
            if (!busy) setOverride(undefined);
          }}
        >
          <p className="hardware-banner">
            Expected hold: {holdId(override)} · generation {override.generation}{" "}
            · revision {override.revision}
          </p>
          <p>
            Revoke old managed access and drain CloudX-owned operations.
            Arbitrary remote work may remain.
          </p>
          {staleOverride ? (
            <p className="hardware-banner warning" role="alert">
              This hold changed. Cancel and inspect its current state before
              overriding.
            </p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run("hardware.forceRelease", {
                target: targetFor(override),
                expectedHoldRevision: override.revision,
                reason: reason.trim(),
                acceptUnresolvedExternalActivity: accept,
              }).then((receipt) => {
                if (
                  receipt?.state === "succeeded" ||
                  receipt?.state === "running"
                )
                  setOverride(undefined);
              });
            }}
          >
            <label>
              Reason
              <textarea
                aria-label="Force release reason"
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
            </label>
            {unresolved ? (
              <label className="hardware-checkbox">
                <input
                  type="checkbox"
                  checked={accept}
                  onChange={(event) => setAccept(event.target.checked)}
                  disabled={busy}
                />
                I accept unresolved external activity.
              </label>
            ) : null}
            <footer className="hardware-form-actions">
              <ControlButton
                disabled={busy}
                onClick={() => setOverride(undefined)}
              >
                Cancel override
              </ControlButton>
              <ControlButton
                type="submit"
                tone="danger"
                disabled={
                  busy ||
                  staleOverride ||
                  !reason.trim() ||
                  (unresolved && !accept)
                }
              >
                Confirm force release
              </ControlButton>
            </footer>
          </form>
        </HardwareDialog>
      ) : null}
    </>
  );
}
