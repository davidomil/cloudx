import { useEffect, useState } from "react";
import {
  ChevronDown,
  Info,
  LockKeyhole,
  RefreshCw,
  Save,
  Server,
} from "lucide-react";
import type {
  HardwareItem,
  HardwareStateView,
  HardwareSummary,
  StatusValue,
} from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import { HookFields, StatusBindings } from "./HardwareEditor.js";
import {
  HardwareHistory,
  Observation,
  StatusInput,
  type HardwareRun,
} from "./HardwareControls.js";
import { ownerLabel, sameOwner } from "./hardwareModel.js";

export interface StatusEditDraft {
  statuses: HardwareItem["statuses"];
  hooks: HardwareItem["hooks"];
  revision: number;
}
export function HardwareStatuses({
  state,
  selectedId,
  onSelect,
  onInspectHold,
  drafts,
  busy,
  run,
}: {
  state: HardwareStateView;
  selectedId?: string;
  onSelect: (id: string) => void;
  onInspectHold: (id: string) => void;
  drafts: Map<string, StatusEditDraft>;
  busy: boolean;
  run: HardwareRun;
}) {
  const selected = state.items.find((value) => value.item.id === selectedId);
  return (
    <>
      <section
        className="hardware-card hardware-target"
        aria-label="Hardware configuration target"
      >
        <div className="hardware-target-picker">
          <Server size={25} aria-hidden="true" />
          <label className="hardware-item-picker">
            Hardware
            <span className="hardware-select-control">
              <select
                aria-label="Configure hardware statuses"
                value={selectedId ?? ""}
                onChange={(event) => onSelect(event.target.value)}
              >
                <option value="">Choose hardware</option>
                {state.items.map((value) => (
                  <option key={value.item.id} value={value.item.id}>
                    {value.item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={17} aria-hidden="true" />
            </span>
          </label>
        </div>
        {selected ? (
          <dl
            className="hardware-target-details"
            aria-label="Selected hardware details"
          >
            <div>
              <dt>Type</dt>
              <dd>
                {state.types.find((type) => type.id === selected.item.typeId)
                  ?.displayName ?? selected.item.typeId}
              </dd>
            </div>
            <div>
              <dt>Physical group</dt>
              <dd>
                {state.groups.find(
                  (group) => group.id === selected.item.physicalResourceId,
                )?.name ?? selected.item.physicalResourceId}
              </dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>
                {String(
                  selected.item.config.host ??
                    selected.item.config.devicePath ??
                    "—",
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="hardware-muted">
            Choose a hardware item to edit its status bindings and reservation
            hooks.
          </p>
        )}
      </section>
      {selected ? (
        <StatusConfiguration
          key={selected.item.id}
          state={state}
          summary={selected}
          drafts={drafts}
          busy={busy}
          run={run}
          onInspectHold={onInspectHold}
        />
      ) : (
        <div className="hardware-empty">
          Select a hardware item to configure statuses and hooks.
        </div>
      )}
    </>
  );
}

function StatusConfiguration({
  state,
  summary,
  drafts,
  busy,
  run,
  onInspectHold,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  drafts: Map<string, StatusEditDraft>;
  busy: boolean;
  run: HardwareRun;
  onInspectHold: (id: string) => void;
}) {
  const [draft, setDraft] = useState(
    () =>
      drafts.get(summary.item.id) ?? {
        statuses: structuredClone(summary.item.statuses),
        hooks: structuredClone(summary.item.hooks),
        revision: summary.item.revision,
      },
  );
  useEffect(() => {
    drafts.set(summary.item.id, draft);
  }, [draft, drafts, summary.item.id]);
  const held = Boolean(summary.reservation || summary.checkHold);
  const stale = draft.revision !== summary.item.revision;
  const reset = () =>
    setDraft({
      statuses: structuredClone(summary.item.statuses),
      hooks: structuredClone(summary.item.hooks),
      revision: summary.item.revision,
    });
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("hardware.items.update", {
            hardwareId: summary.item.id,
            expectedItemRevision: draft.revision,
            patch: { statuses: draft.statuses, hooks: draft.hooks },
          }).then((receipt) => {
            if (receipt?.state === "succeeded") {
              const item = receipt.result?.item as unknown as
                HardwareItem | undefined;
              if (item)
                setDraft({
                  statuses: structuredClone(item.statuses),
                  hooks: structuredClone(item.hooks),
                  revision: item.revision,
                });
            }
          });
        }}
      >
        {held ? (
          <ConfigurationHold
            state={state}
            summary={summary}
            busy={busy}
            onInspectHold={onInspectHold}
          />
        ) : null}
        {stale ? (
          <p className="hardware-banner warning" role="status">
            This item changed. Your configuration draft is retained; load the
            current item before saving.
          </p>
        ) : null}
        <fieldset disabled={busy || held} className="hardware-columns">
          <StatusBindings
            state={state}
            summary={summary}
            bindings={draft.statuses}
            onChange={(statuses) => setDraft({ ...draft, statuses })}
          />
          <HookFields
            value={draft.hooks}
            onChange={(hooks) => setDraft({ ...draft, hooks })}
          />
        </fieldset>
        <footer className="hardware-form-actions">
          <ControlButton disabled={busy} onClick={reset}>
            {stale
              ? "Discard draft and load current configuration"
              : "Cancel changes"}
          </ControlButton>
          <ControlButton
            tone="primary"
            type="submit"
            disabled={busy || held || stale}
          >
            <Save size={14} />
            Save configuration
          </ControlButton>
        </footer>
      </form>
      <section className="hardware-card">
        <h3>Current observations</h3>
        {summary.item.statuses.map((binding) => {
          const definition = state.statusDefinitions.find(
            (value) => value.id === binding.definitionId,
          );
          return definition ? (
            <article
              className="hardware-observation-row"
              key={binding.definitionId}
            >
              <strong>{definition.label}</strong>
              <Observation
                summary={summary}
                definitionId={binding.definitionId}
                detailed
              />
              {binding.source === "manual" ? (
                <ManualStatus
                  key={`${binding.definitionId}:${summary.item.revision}`}
                  summary={summary}
                  definitionId={binding.definitionId}
                  value={binding.value}
                  state={state}
                  busy={busy}
                  run={run}
                />
              ) : (
                <ControlButton
                  size="compact"
                  disabled={
                    busy ||
                    Boolean(summary.checkHold) ||
                    Boolean(
                      summary.reservation &&
                      (!sameOwner(
                        summary.reservation.owner,
                        state.currentOwner,
                      ) ||
                        summary.reservation.state !== "active"),
                    )
                  }
                  onClick={() =>
                    void run("hardware.statuses.refresh", {
                      hardwareId: summary.item.id,
                      statusIds: [binding.definitionId],
                      ...(summary.reservation
                        ? {
                            reservationId: summary.reservation.reservationId,
                            generation: summary.reservation.generation,
                          }
                        : {}),
                    })
                  }
                >
                  <RefreshCw size={13} />
                  Refresh {definition.label}
                </ControlButton>
              )}
            </article>
          ) : null;
        })}
        {!summary.item.statuses.length ? (
          <p>No statuses are bound to this item.</p>
        ) : null}
      </section>
      <HardwareHistory
        entries={state.history.filter(
          (entry) => entry.hardwareId === summary.item.id,
        )}
      />
    </>
  );
}

function ConfigurationHold({
  state,
  summary,
  busy,
  onInspectHold,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  busy: boolean;
  onInspectHold: (id: string) => void;
}) {
  const check = summary.checkHold;
  const reservation = summary.reservation;
  const hold = check ?? reservation;
  if (!hold) return null;
  let title: string;
  let detail: string;
  if (check) {
    title =
      check.state === "checking"
        ? "Status check is running."
        : "Status check needs recovery.";
    detail =
      check.state === "checking"
        ? "Editing resumes when this check finishes. Inspect the hold to see its operation and recovery controls."
        : (check.recoveryReason ??
          "The checking outcome is uncertain. Inspect the hold and its operation before releasing it.");
  } else {
    const claim = reservation!;
    switch (claim.state) {
      case "preparing":
        title = "Reservation preparation is running.";
        detail =
          "Preparation must finish before the reservation can be released. Statuses and hooks stay locked while it is held.";
        break;
      case "releasing":
        title = "Reservation release is running.";
        detail =
          "CloudX is closing access and running cleanup. Editing resumes when release finishes.";
        break;
      case "recovery_required":
        title = "Reservation needs recovery.";
        detail =
          claim.recoveryReason ??
          "Inspect the reservation and its operations before releasing it.";
        break;
      case "active":
        title = sameOwner(claim.owner, state.currentOwner)
          ? "Reserved by you."
          : `Reserved by ${ownerLabel(claim.owner)}.`;
        detail = sameOwner(claim.owner, state.currentOwner)
          ? "Release your reservation before changing statuses or hooks."
          : "Statuses and hooks unlock after this reservation ends.";
    }
  }
  const heldThrough =
    state.items.find((entry) => entry.item.id === hold.hardwareId)?.item.name ??
    hold.hardwareId;
  return (
    <div
      className="hardware-banner warning hardware-configuration-hold"
      role="status"
    >
      <LockKeyhole size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {reservation ? <small>Purpose: {reservation.purpose}</small> : null}
        {hold.hardwareId !== summary.item.id ? (
          <small>Held through {heldThrough} in the same physical group.</small>
        ) : null}
        {check ? (
          <small>Started {new Date(check.startedAt).toLocaleString()}</small>
        ) : null}
      </div>
      <ControlButton
        size="compact"
        disabled={busy}
        onClick={() =>
          onInspectHold(check?.runId ?? reservation!.reservationId)
        }
      >
        <Info size={14} />
        Inspect hold
      </ControlButton>
    </div>
  );
}

function ManualStatus({
  summary,
  definitionId,
  value: initial,
  state,
  busy,
  run,
}: {
  summary: HardwareSummary;
  definitionId: string;
  value: StatusValue;
  state: HardwareStateView;
  busy: boolean;
  run: HardwareRun;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="hardware-inline">
      <StatusInput
        label={`${state.statusDefinitions.find((value) => value.id === definitionId)!.label} value`}
        definition={state.statusDefinitions.find(
          (value) => value.id === definitionId,
        )!}
        value={value}
        onChange={setValue}
        disabled={busy}
      />
      <ControlButton
        size="compact"
        disabled={busy || value === initial}
        onClick={() =>
          void run("hardware.statuses.set", {
            hardwareId: summary.item.id,
            expectedItemRevision: summary.item.revision,
            definitionId,
            value,
          })
        }
      >
        Set manual value
      </ControlButton>
    </div>
  );
}
