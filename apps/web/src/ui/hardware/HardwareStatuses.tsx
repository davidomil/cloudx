import { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
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
import { sameOwner } from "./hardwareModel.js";

export interface StatusEditDraft {
  statuses: HardwareItem["statuses"];
  hooks: HardwareItem["hooks"];
  revision: number;
}
export function HardwareStatuses({
  state,
  selectedId,
  onSelect,
  drafts,
  busy,
  run,
}: {
  state: HardwareStateView;
  selectedId?: string;
  onSelect: (id: string) => void;
  drafts: Map<string, StatusEditDraft>;
  busy: boolean;
  run: HardwareRun;
}) {
  const selected = state.items.find((value) => value.item.id === selectedId);
  return (
    <>
      <label className="hardware-item-picker">
        Hardware
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
      </label>
      {selected ? (
        <StatusConfiguration
          key={selected.item.id}
          state={state}
          summary={selected}
          drafts={drafts}
          busy={busy}
          run={run}
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
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  drafts: Map<string, StatusEditDraft>;
  busy: boolean;
  run: HardwareRun;
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
        {held || stale ? (
          <p className="hardware-banner warning" role="status">
            {held
              ? "Status bindings and hooks cannot change while this resource is held."
              : "This item changed. Your configuration draft is retained; load the current item before saving."}
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
