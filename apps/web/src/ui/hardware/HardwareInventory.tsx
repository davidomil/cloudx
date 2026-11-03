import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Info,
  RefreshCw,
  Search,
  Server,
  Terminal,
  X,
} from "lucide-react";
import type {
  HardwareFilter,
  HardwareStateView,
  HardwareSummary,
} from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import {
  HardwareHistory,
  Observation,
  StatusInput,
  type HardwareRun,
} from "./HardwareControls.js";
import { matchesHardware, ownerLabel, sameOwner } from "./hardwareModel.js";

export function HardwareInventory({
  state,
  selectedId,
  onSelect,
  onEdit,
  onAccess,
  onStatuses,
  busy,
  run,
}: {
  state: HardwareStateView;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onEdit: (item: HardwareSummary) => void;
  onAccess: (id: string) => void;
  onStatuses: (id: string) => void;
  busy: boolean;
  run: HardwareRun;
}) {
  const [filter, setFilter] = useState<HardwareFilter>({});
  const [tagMode, setTagMode] = useState<"all" | "any" | "none">("all");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [descending, setDescending] = useState(false);
  const list = useRef<HTMLElement>(null);
  const selected = state.items.find((value) => value.item.id === selectedId);
  const rows = state.items
    .filter((value) =>
      matchesHardware(
        value,
        { ...filter, tags: { [tagMode]: tagIds } },
        state.currentOwner,
      ),
    )
    .sort(
      (left, right) =>
        (left.item.name.localeCompare(right.item.name) ||
          left.item.id.localeCompare(right.item.id)) * (descending ? -1 : 1),
    );
  const statusColumns = state.statusDefinitions.slice(0, 2);
  return (
    <>
      <div className="hardware-filters">
        <label className="hardware-search">
          <Search size={16} />
          <input
            type="search"
            aria-label="Find hardware"
            placeholder="Find hardware…"
            value={filter.text ?? ""}
            onChange={(event) =>
              setFilter({ ...filter, text: event.target.value })
            }
          />
        </label>
        <label>
          Type
          <select
            aria-label="Filter type"
            value={filter.typeIds?.[0] ?? ""}
            onChange={(event) =>
              setFilter({
                ...filter,
                typeIds: event.target.value ? [event.target.value] : [],
              })
            }
          >
            <option value="">All types</option>
            {state.types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Availability
          <select
            aria-label="Filter availability"
            value={filter.availability ?? ""}
            onChange={(event) =>
              setFilter({
                ...filter,
                availability:
                  (event.target.value as HardwareFilter["availability"]) ||
                  undefined,
              })
            }
          >
            <option value="">All availability</option>
            <option value="available">Available</option>
            <option value="held">Held</option>
            <option value="ineligible">Needs attention</option>
          </select>
        </label>
        <label>
          Owner
          <select
            aria-label="Filter owner"
            value={filter.ownedByMe ? "me" : "all"}
            onChange={(event) =>
              setFilter({ ...filter, ownedByMe: event.target.value === "me" })
            }
          >
            <option value="all">All owners</option>
            <option value="me">Owned by me</option>
          </select>
        </label>
        <label>
          Enabled
          <select
            aria-label="Filter enabled"
            value={
              filter.enabled === undefined ? "all" : String(filter.enabled)
            }
            onChange={(event) =>
              setFilter({
                ...filter,
                enabled:
                  event.target.value === "all"
                    ? undefined
                    : event.target.value === "true",
              })
            }
          >
            <option value="all">All items</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
        <ControlButton
          size="compact"
          onClick={() => {
            setFilter({});
            setTagIds([]);
            setTagMode("all");
          }}
        >
          <X size={14} />
          Clear filters
        </ControlButton>
        <details className="hardware-filter-details">
          <summary>Capability and status filters</summary>
          <div className="hardware-form-grid">
            <label>
              Tag matching
              <select
                aria-label="Tag matching"
                value={tagMode}
                onChange={(event) =>
                  setTagMode(event.target.value as typeof tagMode)
                }
              >
                <option value="all">All selected tags</option>
                <option value="any">Any selected tag</option>
                <option value="none">Exclude selected tags</option>
              </select>
            </label>
            <label>
              Capability tags
              <select
                multiple
                aria-label="Filter capability tags"
                value={tagIds}
                onChange={(event) =>
                  setTagIds(
                    [...event.target.selectedOptions].map(
                      (option) => option.value,
                    ),
                  )
                }
              >
                {state.tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status requirement
              <select
                aria-label="Filter status"
                value={filter.statuses?.[0]?.definitionId ?? ""}
                onChange={(event) => {
                  const definition = state.statusDefinitions.find(
                    (value) => value.id === event.target.value,
                  );
                  setFilter({
                    ...filter,
                    statuses: definition
                      ? [
                          {
                            definitionId: definition.id,
                            equals:
                              definition.valueType === "boolean"
                                ? true
                                : (definition.enumValues?.[0] ?? ""),
                            requireFresh: true,
                          },
                        ]
                      : [],
                  });
                }}
              >
                <option value="">Any status</option>
                {state.statusDefinitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.label}
                  </option>
                ))}
              </select>
            </label>
            {filter.statuses?.[0] ? (
              <StatusInput
                label="Filter status value"
                definition={state.statusDefinitions.find(
                  (value) => value.id === filter.statuses![0]!.definitionId,
                )!}
                value={filter.statuses[0].equals}
                onChange={(equals) =>
                  setFilter({
                    ...filter,
                    statuses: [{ ...filter.statuses![0]!, equals }],
                  })
                }
              />
            ) : null}
          </div>
        </details>
      </div>
      <div className="hardware-inventory-layout">
        <section className="hardware-inventory-list" ref={list}>
          <p className="hardware-inventory-count" role="status">
            {rows.length} of {state.items.length} hardware ·{" "}
            {
              state.items.filter((value) => value.availability === "available")
                .length
            }{" "}
            available · {state.reservations.length} reservations
          </p>
          <div className="hardware-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <button
                      className="hardware-sort"
                      onClick={() => setDescending(!descending)}
                    >
                      Hardware{" "}
                      {descending ? (
                        <ArrowDown size={13} />
                      ) : (
                        <ArrowUp size={13} />
                      )}
                    </button>
                  </th>
                  <th>Type</th>
                  <th>Tags</th>
                  {statusColumns.map((definition) => (
                    <th key={definition.id}>{definition.label}</th>
                  ))}
                  <th>Reservation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((summary) => (
                  <tr
                    key={summary.item.id}
                    className={summary.item.id === selectedId ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="hardware-row-button"
                        aria-label={`Select ${summary.item.name}`}
                        aria-pressed={summary.item.id === selectedId}
                        onClick={() => onSelect(summary.item.id)}
                      >
                        <Server size={18} />
                        <strong>{summary.item.name}</strong>
                        {!summary.item.enabled ? <small>Disabled</small> : null}
                      </button>
                    </td>
                    <td>
                      {state.types.find(
                        (type) => type.id === summary.item.typeId,
                      )?.displayName ?? summary.item.typeId}
                    </td>
                    <td>
                      <div className="hardware-tags">
                        {summary.item.tagIds.map((id) => (
                          <span className="hardware-tag" key={id}>
                            {state.tags.find((tag) => tag.id === id)?.label ??
                              id}
                          </span>
                        ))}
                      </div>
                    </td>
                    {statusColumns.map((definition) => (
                      <td key={definition.id}>
                        <Observation
                          summary={summary}
                          definitionId={definition.id}
                        />
                      </td>
                    ))}
                    <td>
                      <span
                        className={`hardware-badge state-${summary.reservation?.state ?? summary.checkHold?.state ?? summary.availability}`}
                      >
                        {summary.reservation
                          ? `${summary.reservation.state.replaceAll("_", " ")} · ${ownerLabel(summary.reservation.owner)}`
                          : summary.checkHold
                            ? "System check"
                            : summary.availability === "ineligible"
                              ? "Needs attention"
                              : "Available"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length ? (
            <div className="hardware-empty">
              <Server size={28} />
              <h3>
                {state.items.length
                  ? "No hardware matches these filters"
                  : "Add your first hardware item"}
              </h3>
              <p>
                {state.items.length
                  ? "Change or clear the current filters."
                  : "Configure an SSH or UART item and its physical resource group."}
              </p>
            </div>
          ) : null}
        </section>
        {selected ? (
          <HardwareInspector
            key={selected.item.id}
            state={state}
            summary={selected}
            onEdit={() => onEdit(selected)}
            onAccess={() =>
              onAccess(selected.reservation?.hardwareId ?? selected.item.id)
            }
            onStatuses={() => onStatuses(selected.item.id)}
            onClose={() => {
              list.current
                ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                ?.focus();
              onSelect(undefined);
            }}
            busy={busy}
            run={run}
          />
        ) : (
          <aside className="hardware-inspector hardware-empty">
            <Info size={25} />
            <p>Select hardware to inspect its notes and availability.</p>
          </aside>
        )}
      </div>
    </>
  );
}

function HardwareInspector({
  state,
  summary,
  onEdit,
  onAccess,
  onStatuses,
  onClose,
  busy,
  run,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  onEdit: () => void;
  onAccess: () => void;
  onStatuses: () => void;
  onClose: () => void;
  busy: boolean;
  run: HardwareRun;
}) {
  const [tab, setTab] = useState("overview");
  const [purpose, setPurpose] = useState("");
  const { item, reservation } = summary;
  const owns = Boolean(
    reservation && sameOwner(reservation.owner, state.currentOwner),
  );
  return (
    <aside
      className="hardware-inspector"
      aria-label={`${item.name} details`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <Server size={26} />
        <div>
          <h2>{item.name}</h2>
          <p>
            {state.types.find((type) => type.id === item.typeId)?.displayName ??
              item.typeId}{" "}
            · {String(item.config.host ?? item.config.devicePath ?? "")}{" "}
            {item.config.username ? `· ${item.config.username}` : ""}
          </p>
        </div>
        <ControlButton
          className="hardware-inspector-close"
          size="compact"
          iconOnly
          aria-label="Close item details"
          onClick={onClose}
        >
          <X size={14} />
        </ControlButton>
      </header>
      {reservation && reservation.hardwareId !== item.id ? (
        <p className="hardware-banner">
          This group is held through{" "}
          {state.items.find((entry) => entry.item.id === reservation.hardwareId)
            ?.item.name ?? reservation.hardwareId}
          . Access opens that reserved entry.
        </p>
      ) : null}
      <nav className="hardware-subtabs" aria-label="Item details">
        {["overview", "notes", "activity"].map((value) => (
          <ControlButton
            size="compact"
            selected={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </ControlButton>
        ))}
      </nav>
      {tab === "activity" ? (
        <HardwareHistory
          entries={state.history.filter(
            (entry) => entry.hardwareId === item.id,
          )}
        />
      ) : (
        <>
          {tab === "overview" ? (
            <>
              <div className="hardware-card">
                <dl>
                  <dt>Physical group</dt>
                  <dd>
                    {state.groups.find(
                      (group) => group.id === item.physicalResourceId,
                    )?.name ?? item.physicalResourceId}
                  </dd>
                  <dt>Group aliases</dt>
                  <dd>
                    {state.items
                      .filter(
                        (value) =>
                          value.item.physicalResourceId ===
                            item.physicalResourceId &&
                          value.item.id !== item.id,
                      )
                      .map((value) => value.item.name)
                      .join(", ") || "None"}
                  </dd>
                  <dt>Tags</dt>
                  <dd className="hardware-tags">
                    {item.tagIds.map((id) => (
                      <span className="hardware-tag" key={id}>
                        {state.tags.find((tag) => tag.id === id)?.label ?? id}
                      </span>
                    ))}
                  </dd>
                  {item.statuses.map((binding) => (
                    <div
                      className="hardware-definition-row"
                      key={binding.definitionId}
                    >
                      <dt>
                        {
                          state.statusDefinitions.find(
                            (definition) =>
                              definition.id === binding.definitionId,
                          )?.label
                        }
                      </dt>
                      <dd>
                        <Observation
                          summary={summary}
                          definitionId={binding.definitionId}
                          detailed
                        />
                      </dd>
                    </div>
                  ))}
                  <dt>Reservation</dt>
                  <dd>
                    <span
                      className={`hardware-badge state-${reservation?.state ?? summary.availability}`}
                    >
                      {reservation
                        ? `${reservation.state.replaceAll("_", " ")} · ${ownerLabel(reservation.owner)}`
                        : summary.checkHold
                          ? summary.checkHold.state
                          : summary.availability}
                    </span>
                  </dd>
                </dl>
                {summary.blockers.length ? (
                  <ul className="hardware-blockers">
                    {summary.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="hardware-inline">
                <ControlButton
                  size="compact"
                  disabled={
                    busy ||
                    Boolean(reservation && !owns) ||
                    Boolean(summary.checkHold)
                  }
                  onClick={() =>
                    void run("hardware.statuses.refresh", {
                      hardwareId: item.id,
                      ...(reservation && owns
                        ? {
                            reservationId: reservation.reservationId,
                            generation: reservation.generation,
                          }
                        : {}),
                    })
                  }
                >
                  <RefreshCw size={13} />
                  Refresh statuses
                </ControlButton>
                <ControlButton size="compact" onClick={onStatuses}>
                  Configure statuses & hooks
                </ControlButton>
              </div>
            </>
          ) : null}
          <section className="hardware-card">
            <h3>Notes for agents</h3>
            <p className="hardware-notes">
              {item.notes || "No notes provided."}
            </p>
            <small className="hardware-muted">
              Notes revision {item.notesRevision}. Notes are guidance.
            </small>
          </section>
        </>
      )}
      <div className="hardware-inspector-actions">
        {!reservation && !summary.checkHold ? (
          <label>
            Purpose
            <input
              aria-label="Reservation purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Deployment validation"
            />
          </label>
        ) : null}
        <div className="hardware-inline">
          <ControlButton size="compact" onClick={onEdit}>
            <Edit3 size={14} />
            Edit hardware
          </ControlButton>
          {owns && reservation ? (
            <>
              <ControlButton
                tone="primary"
                size="compact"
                disabled={busy || reservation.state !== "active"}
                onClick={onAccess}
              >
                <Terminal size={14} />
                Open access screen
              </ControlButton>
              <ControlButton
                size="compact"
                disabled={busy || reservation.state !== "active"}
                onClick={() =>
                  void run("hardware.release", {
                    reservationId: reservation.reservationId,
                    generation: reservation.generation,
                  })
                }
              >
                Release hardware
              </ControlButton>
            </>
          ) : (
            <ControlButton
              tone="primary"
              disabled={
                busy || summary.availability !== "available" || !purpose.trim()
              }
              onClick={() =>
                void run("hardware.reserve", {
                  hardwareId: item.id,
                  expectedItemRevision: item.revision,
                  purpose: purpose.trim(),
                })
              }
            >
              Reserve hardware
            </ControlButton>
          )}
        </div>
      </div>
    </aside>
  );
}
