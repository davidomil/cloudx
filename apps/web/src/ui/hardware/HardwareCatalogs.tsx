import { useState } from "react";
import { Layers, Plus, Save, Tag, Trash2 } from "lucide-react";
import type { HardwareStateView } from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import { HardwareDialog, type HardwareRun } from "./HardwareControls.js";

type CatalogKind = "tags" | "groups" | "statuses";
type CatalogDraft = {
  kind: CatalogKind;
  id?: string;
  revision?: number;
  label: string;
  description: string;
  valueType: "boolean" | "text" | "enum";
  enumValues: string;
};

export function HardwareCatalogs({
  state,
  busy,
  run,
}: {
  state: HardwareStateView;
  busy: boolean;
  run: HardwareRun;
}) {
  const [editing, setEditing] = useState<CatalogDraft>();
  const [deleting, setDeleting] = useState(false);
  const [typeId, setTypeId] = useState<string>();
  const type =
    state.types.find((value) => value.id === typeId) ?? state.types[0];
  const create = (kind: CatalogKind) => {
    setDeleting(false);
    setEditing({
      kind,
      label: "",
      description: "",
      valueType: "boolean",
      enumValues: "",
    });
  };
  async function save() {
    if (!editing) return;
    const input = {
      ...(editing.id
        ? { id: editing.id, expectedRevision: editing.revision }
        : {}),
      ...(editing.kind === "groups"
        ? { name: editing.label }
        : { label: editing.label }),
      ...(editing.kind === "tags" ? { description: editing.description } : {}),
      ...(editing.kind === "statuses"
        ? {
            valueType: editing.valueType,
            ...(editing.valueType === "enum"
              ? {
                  enumValues: editing.enumValues
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }
              : {}),
          }
        : {}),
    };
    const receipt = await run(
      `hardware.${editing.kind}.${editing.id ? "update" : "create"}`,
      input,
    );
    if (receipt?.state === "succeeded") setEditing(undefined);
  }
  return (
    <div className="hardware-columns hardware-catalogs">
      <div>
        <section className="hardware-card">
          <header>
            <h2>
              <Tag size={19} />
              Capability tags
            </h2>
            <ControlButton
              tone="primary"
              size="compact"
              onClick={() => create("tags")}
            >
              <Plus size={14} />
              New tag
            </ControlButton>
          </header>
          <p className="hardware-muted">
            Stable IDs preserve membership when a label changes.
          </p>
          <div className="hardware-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Description</th>
                  <th>Hardware</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {state.tags.map((tag) => (
                  <tr key={tag.id}>
                    <td>
                      <span className="hardware-tag">{tag.label}</span>
                    </td>
                    <td>{tag.description}</td>
                    <td>
                      {
                        state.items.filter((value) =>
                          value.item.tagIds.includes(tag.id),
                        ).length
                      }
                    </td>
                    <td>
                      <ControlButton
                        size="compact"
                        onClick={() => {
                          setDeleting(false);
                          setEditing({
                            kind: "tags",
                            id: tag.id,
                            revision: tag.revision,
                            label: tag.label,
                            description: tag.description,
                            valueType: "text",
                            enumValues: "",
                          });
                        }}
                      >
                        Edit tag {tag.label}
                      </ControlButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!state.tags.length ? <p>No capability tags yet.</p> : null}
        </section>
        <section className="hardware-card">
          <header>
            <h2>Status definitions</h2>
            <ControlButton
              tone="primary"
              size="compact"
              onClick={() => create("statuses")}
            >
              <Plus size={14} />
              New status definition
            </ControlButton>
          </header>
          <p className="hardware-muted">
            Statuses describe hardware. They never replace internal
            reservations.
          </p>
          {state.statusDefinitions.map((definition) => (
            <article className="hardware-catalog-row" key={definition.id}>
              <div>
                <strong>{definition.label}</strong>
                <small>
                  {definition.valueType}
                  {definition.enumValues
                    ? ` · ${definition.enumValues.join(", ")}`
                    : ""}
                </small>
              </div>
              <ControlButton
                size="compact"
                onClick={() => {
                  setDeleting(false);
                  setEditing({
                    kind: "statuses",
                    id: definition.id,
                    revision: definition.revision,
                    label: definition.label,
                    description: "",
                    valueType: definition.valueType,
                    enumValues: definition.enumValues?.join("\n") ?? "",
                  });
                }}
              >
                Edit status {definition.label}
              </ControlButton>
            </article>
          ))}
        </section>
      </div>
      <div>
        <section className="hardware-card">
          <h2>
            <Layers size={19} />
            Hardware types
          </h2>
          <p className="hardware-muted">
            Types are registered in code. No code upload is available here.
          </p>
          <div className="hardware-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Owner</th>
                  <th>API</th>
                  <th>Operations</th>
                </tr>
              </thead>
              <tbody>
                {state.types.map((value) => (
                  <tr
                    key={value.id}
                    className={value.id === type?.id ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="hardware-text-button"
                        onClick={() => setTypeId(value.id)}
                      >
                        {value.displayName}
                      </button>
                    </td>
                    <td>{value.ownerPluginId}</td>
                    <td>v{value.apiVersion}</td>
                    <td>
                      {value.operations
                        .map((operation) => operation.id)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {type ? (
            <div className="hardware-type-details">
              <h3>Type detail: {type.displayName}</h3>
              <p>{type.description}</p>
              <code>
                {type.id} · config v{type.configVersion}
              </code>
              <details>
                <summary>Configuration schema</summary>
                <pre>{JSON.stringify(type.configSchema, null, 2)}</pre>
              </details>
              {type.operations.map((operation) => (
                <details key={operation.id}>
                  <summary>{operation.id} · input and output schemas</summary>
                  <p>{operation.description}</p>
                  <pre>
                    {JSON.stringify(
                      {
                        input: operation.inputSchema,
                        output: operation.outputSchema,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ))}
            </div>
          ) : (
            <p>No type providers are installed.</p>
          )}
        </section>
        <section className="hardware-card">
          <header>
            <h2>Physical resource groups</h2>
            <ControlButton
              tone="primary"
              size="compact"
              onClick={() => create("groups")}
            >
              <Plus size={14} />
              Add group
            </ControlButton>
          </header>
          <p className="hardware-muted">
            SSH and UART entries for one machine share one reservation.
          </p>
          {state.groups.map((group) => (
            <article className="hardware-catalog-row" key={group.id}>
              <div>
                <strong>{group.name}</strong>
                <small>
                  {state.items
                    .filter(
                      (value) => value.item.physicalResourceId === group.id,
                    )
                    .map((value) => value.item.name)
                    .join(", ") || "No hardware items"}
                </small>
                <code>{group.id}</code>
              </div>
              <ControlButton
                size="compact"
                onClick={() => {
                  setDeleting(false);
                  setEditing({
                    kind: "groups",
                    id: group.id,
                    revision: group.revision,
                    label: group.name,
                    description: "",
                    valueType: "text",
                    enumValues: "",
                  });
                }}
              >
                Edit group {group.name}
              </ControlButton>
            </article>
          ))}
        </section>
      </div>
      {editing ? (
        <HardwareDialog
          title={`${editing.id ? "Edit" : "New"} ${editing.kind === "tags" ? "tag" : editing.kind === "groups" ? "group" : "status definition"}`}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy}>
              <label>
                {editing.kind === "groups" ? "Group name" : "Label"}
                <input
                  aria-label="Catalog name"
                  required
                  maxLength={240}
                  value={editing.label}
                  onChange={(event) =>
                    setEditing({ ...editing, label: event.target.value })
                  }
                />
              </label>
              {editing.kind === "tags" ? (
                <label>
                  Description
                  <textarea
                    aria-label="Tag description"
                    value={editing.description}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        description: event.target.value,
                      })
                    }
                  />
                </label>
              ) : null}
              {editing.kind === "statuses" ? (
                <>
                  <label>
                    Value type
                    <select
                      aria-label="Status value type"
                      value={editing.valueType}
                      onChange={(event) =>
                        setEditing({
                          ...editing,
                          valueType: event.target
                            .value as CatalogDraft["valueType"],
                        })
                      }
                    >
                      <option value="boolean">Boolean</option>
                      <option value="text">Text</option>
                      <option value="enum">Enum</option>
                    </select>
                  </label>
                  {editing.valueType === "enum" ? (
                    <label>
                      Enum values (one per line)
                      <textarea
                        aria-label="Enum values"
                        required
                        value={editing.enumValues}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            enumValues: event.target.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <p className="hardware-muted">
                    A used definition cannot change value type. Create a new
                    definition and rebind explicitly.
                  </p>
                </>
              ) : null}
              {editing.id ? (
                <p className="hardware-muted">
                  ID {editing.id} · revision {editing.revision}. Referenced
                  records cannot be deleted.
                </p>
              ) : null}
            </fieldset>
            <footer className="hardware-form-actions">
              {editing.id ? (
                <ControlButton
                  tone="danger"
                  disabled={busy}
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 size={14} />
                  Delete{" "}
                  {editing.kind === "tags"
                    ? "tag"
                    : editing.kind === "groups"
                      ? "group"
                      : "status definition"}
                </ControlButton>
              ) : null}
              <ControlButton
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </ControlButton>
              <ControlButton type="submit" tone="primary" disabled={busy}>
                <Save size={14} />
                Save{" "}
                {editing.kind === "tags"
                  ? "tag"
                  : editing.kind === "groups"
                    ? "group"
                    : "status definition"}
              </ControlButton>
            </footer>
          </form>
          {deleting ? (
            <div className="hardware-banner warning">
              <p>Delete “{editing.label}”?</p>
              <ControlButton
                tone="danger"
                disabled={busy}
                onClick={() =>
                  void run(`hardware.${editing.kind}.delete`, {
                    id: editing.id,
                    expectedRevision: editing.revision,
                  }).then((receipt) => {
                    if (receipt?.state === "succeeded") setEditing(undefined);
                  })
                }
              >
                Confirm deletion
              </ControlButton>
              <ControlButton disabled={busy} onClick={() => setDeleting(false)}>
                Keep record
              </ControlButton>
            </div>
          ) : null}
        </HardwareDialog>
      ) : null}
    </div>
  );
}
