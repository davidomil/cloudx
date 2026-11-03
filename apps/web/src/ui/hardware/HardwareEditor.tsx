import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import type {
  HardwareItem,
  HardwareItemDraft,
  HardwareStateView,
  HardwareSummary,
  JsonObject,
  StatusBinding,
} from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import {
  hardwareRequestId,
  saveHardwareSshPassword,
} from "../../hardwareApi.js";
import {
  emptyScript,
  HardwareDialog,
  Observation,
  ScriptFields,
  StatusInput,
  type HardwareRun,
} from "./HardwareControls.js";
import { newStatusBinding } from "./hardwareModel.js";

export const sshDefaults = (): JsonObject => ({
  host: "",
  port: 22,
  username: "",
  auth: { kind: "agent" },
  connectTimeoutMs: 5000,
});
export const uartDefaults = (): JsonObject => ({
  devicePath: "",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
});
const blankItem = (): HardwareItemDraft => ({
  name: "",
  description: "",
  enabled: true,
  physicalResourceId: "",
  typeId: "hardware.ssh",
  configVersion: 1,
  config: sshDefaults(),
  tagIds: [],
  notes: "",
  statuses: [],
  hooks: {},
});
export interface ItemEditDraft {
  value: HardwareItemDraft;
  baseRevision: number;
  newGroupName: string;
}
export function editableHardware(item: HardwareItem): HardwareItemDraft {
  const {
    id: _id,
    revision: _revision,
    notesRevision: _notesRevision,
    ...draft
  } = item;
  return structuredClone(draft);
}

export function HardwareEditor({
  state,
  item,
  held,
  drafts,
  busy,
  run,
  onClose,
  onSaved,
}: {
  state: HardwareStateView;
  item?: HardwareItem;
  held: boolean;
  drafts: Map<string, ItemEditDraft>;
  busy: boolean;
  run: HardwareRun;
  onClose: () => void;
  onSaved: () => void;
}) {
  const key = item?.id ?? "new";
  const [draft, setDraft] = useState<ItemEditDraft>(
    () =>
      drafts.get(key) ?? {
        value: item ? editableHardware(item) : blankItem(),
        baseRevision: item?.revision ?? 0,
        newGroupName: "",
      },
  );
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordReference, setPasswordReference] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const { value } = draft;
  useEffect(() => {
    setPassword("");
    setPasswordReference(undefined);
    setSaveError(undefined);
  }, [value.typeId, (value.config.auth as JsonObject | undefined)?.kind]);
  useEffect(() => {
    drafts.set(key, draft);
  }, [draft, drafts, key]);
  const stale = Boolean(item && item.revision !== draft.baseRevision);
  const edit = (patch: Partial<HardwareItemDraft>) =>
    setDraft({ ...draft, value: { ...value, ...patch } });
  async function save() {
    if (saving || busy || stale) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      let savedValue = value;
      if (
        !held &&
        value.typeId === "hardware.ssh" &&
        (value.config.auth as JsonObject).kind === "password"
      ) {
        if (password) {
          const credentialRefId =
            passwordReference ?? `ssh-password-${hardwareRequestId()}`;
          setPasswordReference(credentialRefId);
          await saveHardwareSshPassword(credentialRefId, password);
          setPassword("");
          setPasswordReference(undefined);
          savedValue = {
            ...value,
            config: {
              ...value.config,
              auth: { kind: "password", credentialRefId },
            },
          };
          setDraft({ ...draft, value: savedValue });
        } else if (!(value.config.auth as JsonObject).credentialRefId) {
          setSaveError(
            "Enter an SSH password before saving password authentication.",
          );
          return;
        }
      }
      const newGroupName =
        !held && !savedValue.physicalResourceId
          ? draft.newGroupName.trim()
          : undefined;
      const { physicalResourceId: _physicalResourceId, ...withoutGroup } =
        savedValue;
      const patch = held
        ? {
            name: value.name,
            description: value.description,
            notes: value.notes,
            tagIds: value.tagIds,
            enabled: value.enabled,
          }
        : newGroupName !== undefined
          ? withoutGroup
          : savedValue;
      const receipt = await run(
        item ? "hardware.items.update" : "hardware.items.create",
        item
          ? {
              hardwareId: item.id,
              expectedItemRevision: draft.baseRevision,
              patch,
              ...(newGroupName !== undefined ? { newGroupName } : {}),
            }
          : {
              item: savedValue,
              ...(savedValue.physicalResourceId
                ? {}
                : { newGroupName: draft.newGroupName }),
            },
      );
      if (receipt?.state === "succeeded") {
        drafts.delete(key);
        onSaved();
      }
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "The SSH password could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="hardware-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="hardware-view-heading">
        <div>
          <ControlButton size="compact" disabled={saving} onClick={onClose}>
            <ArrowLeft size={14} />
            Back to inventory
          </ControlButton>
          <h2>{item ? `Edit hardware: ${item.name}` : "Add hardware"}</h2>
        </div>
        <span className="hardware-muted">
          {item ? `Revision ${draft.baseRevision}` : "New item"}
        </span>
      </header>
      {stale ? (
        <div className="hardware-banner warning" role="alert">
          This item changed while you were editing. Your draft is retained.
          <ControlButton
            size="compact"
            onClick={() => {
              setPassword("");
              setPasswordReference(undefined);
              setSaveError(undefined);
              setDraft({
                value: editableHardware(item!),
                baseRevision: item!.revision,
                newGroupName: "",
              });
            }}
          >
            Discard draft and load current item
          </ControlButton>
        </div>
      ) : null}
      {held ? (
        <p className="hardware-banner">
          Connection, group, statuses, and hooks are locked while this resource
          is held. Notes and descriptive fields remain editable.
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="hardware-banner danger">
          {saveError}
        </p>
      ) : null}
      <fieldset disabled={busy || saving} className="hardware-columns">
        <div>
          <section className="hardware-card">
            <h3>Basics</h3>
            <label>
              Name
              <input
                autoFocus
                aria-label="Hardware name"
                required
                maxLength={240}
                value={value.name}
                onChange={(event) => edit({ name: event.target.value })}
              />
            </label>
            <label>
              Description
              <input
                aria-label="Hardware description"
                value={value.description}
                onChange={(event) => edit({ description: event.target.value })}
              />
            </label>
            <fieldset disabled={held}>
              <label>
                Type
                <select
                  aria-label="Hardware type"
                  value={value.typeId}
                  onChange={(event) => {
                    const type = state.types.find(
                      (type) => type.id === event.target.value,
                    )!;
                    edit({
                      typeId: type.id,
                      configVersion: type.configVersion,
                      config:
                        type.id === "hardware.ssh"
                          ? sshDefaults()
                          : type.id === "hardware.uart"
                            ? uartDefaults()
                            : {},
                    });
                  }}
                >
                  {state.types.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Physical resource group
                <select
                  aria-label="Physical resource group"
                  value={value.physicalResourceId}
                  onChange={(event) =>
                    edit({ physicalResourceId: event.target.value })
                  }
                >
                  <option value="">Create a new group</option>
                  {state.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
              {!value.physicalResourceId ? (
                <label>
                  New group name
                  <input
                    aria-label="New group name"
                    required
                    value={draft.newGroupName}
                    onChange={(event) =>
                      setDraft({ ...draft, newGroupName: event.target.value })
                    }
                  />
                </label>
              ) : null}
            </fieldset>
            <label className="hardware-checkbox">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(event) => edit({ enabled: event.target.checked })}
              />
              Enabled for new reservations
            </label>
            <h4>Capability tags</h4>
            <div className="hardware-tags">
              {state.tags.map((tag) => (
                <label
                  className={`hardware-tag selectable ${value.tagIds.includes(tag.id) ? "selected" : ""}`}
                  key={tag.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`Capability ${tag.label}`}
                    checked={value.tagIds.includes(tag.id)}
                    onChange={(event) =>
                      edit({
                        tagIds: event.target.checked
                          ? [...value.tagIds, tag.id]
                          : value.tagIds.filter((id) => id !== tag.id),
                      })
                    }
                  />
                  {tag.label}
                </label>
              ))}
            </div>
            {!state.tags.length ? (
              <p className="hardware-muted">
                Create capability tags in Tags & types.
              </p>
            ) : null}
            <label>
              Notes for agents
              <textarea
                aria-label="Notes for agents"
                rows={7}
                value={value.notes}
                onChange={(event) => edit({ notes: event.target.value })}
                placeholder="Username, setup, capabilities, validation instructions, and restrictions."
              />
            </label>
            <p className="hardware-muted">
              Notes guide agents. Restrictions such as “Do not reboot” remain
              advisory.
            </p>
          </section>
          <fieldset disabled={held}>
            <HookFields
              value={value.hooks}
              onChange={(hooks) => edit({ hooks })}
            />
          </fieldset>
        </div>
        <div>
          <fieldset disabled={held}>
            <section className="hardware-card">
              <h3>
                {value.typeId === "hardware.uart"
                  ? "UART"
                  : value.typeId === "hardware.ssh"
                    ? "SSH"
                    : "Provider"}{" "}
                connection settings
              </h3>
              <ConnectionFields
                typeId={value.typeId}
                config={value.config}
                onChange={(config) => edit({ config })}
                password={password}
                onPasswordChange={(next) => {
                  setPassword(next);
                  setPasswordReference(undefined);
                  setSaveError(undefined);
                }}
              />
              <p className="hardware-muted">
                No SSH connection opens while editing.
              </p>
            </section>
            <StatusBindings
              state={state}
              summary={state.items.find((entry) => entry.item.id === item?.id)}
              bindings={value.statuses}
              onChange={(statuses) => edit({ statuses })}
            />
          </fieldset>
        </div>
      </fieldset>
      <footer className="hardware-form-actions">
        {item ? (
          <ControlButton
            tone="danger"
            disabled={busy || held || stale}
            title={
              held
                ? "Release the resource before deleting hardware."
                : undefined
            }
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={14} />
            Delete hardware
          </ControlButton>
        ) : null}
        <ControlButton
          onClick={() => {
            drafts.delete(key);
            onClose();
          }}
          disabled={busy || saving}
        >
          Cancel
        </ControlButton>
        <ControlButton
          tone="primary"
          type="submit"
          disabled={busy || saving || stale || !state.types.length}
        >
          <Save size={15} />
          Save hardware
        </ControlButton>
      </footer>
      {deleting && item ? (
        <HardwareDialog
          title={`Delete ${item.name}`}
          onClose={() => {
            if (!busy) setDeleting(false);
          }}
        >
          <p>
            Delete this inventory entry? Operation history remains recorded.
          </p>
          {held || stale ? (
            <p role="alert">
              The item changed or became held. Cancel and inspect the current
              item.
            </p>
          ) : null}
          <footer className="hardware-form-actions">
            <ControlButton disabled={busy} onClick={() => setDeleting(false)}>
              Keep hardware
            </ControlButton>
            <ControlButton
              tone="danger"
              disabled={busy || held || stale}
              onClick={() =>
                void run("hardware.items.delete", {
                  hardwareId: item.id,
                  expectedItemRevision: draft.baseRevision,
                }).then((receipt) => {
                  if (receipt?.state === "succeeded") {
                    drafts.delete(key);
                    onSaved();
                  }
                })
              }
            >
              Confirm hardware deletion
            </ControlButton>
          </footer>
        </HardwareDialog>
      ) : null}
    </form>
  );
}

function ConnectionFields({
  typeId,
  config,
  onChange,
  password,
  onPasswordChange,
}: {
  typeId: string;
  config: JsonObject;
  onChange: (config: JsonObject) => void;
  password: string;
  onPasswordChange: (password: string) => void;
}) {
  const set = (key: string, value: string | number | JsonObject) =>
    onChange({ ...config, [key]: value });
  if (typeId === "hardware.ssh") {
    const auth = config.auth as JsonObject;
    return (
      <>
        <label>
          Host
          <input
            aria-label="SSH host"
            required
            value={String(config.host)}
            onChange={(event) => set("host", event.target.value)}
          />
        </label>
        <div className="hardware-form-grid">
          <label>
            Port
            <input
              aria-label="SSH port"
              type="number"
              required
              min={1}
              max={65535}
              value={Number(config.port)}
              onChange={(event) => set("port", Number(event.target.value))}
            />
          </label>
          <label>
            Username
            <input
              aria-label="SSH username"
              required
              value={String(config.username)}
              onChange={(event) => set("username", event.target.value)}
            />
          </label>
        </div>
        <label>
          Authentication
          <select
            aria-label="SSH authentication"
            value={String(auth.kind)}
            onChange={(event) =>
              set(
                "auth",
                event.target.value === "agent"
                  ? { kind: "agent" }
                  : event.target.value === "password"
                    ? { kind: "password", credentialRefId: "" }
                    : { kind: "identity_file", path: "" },
              )
            }
          >
            <option value="agent">
              {auth.socketPath ? "Configured SSH agent" : "Current SSH agent"}
            </option>
            <option value="identity_file">Identity file</option>
            <option value="password">Password</option>
          </select>
        </label>
        {auth.kind === "identity_file" ? (
          <label>
            Identity file reference
            <input
              aria-label="Identity file reference"
              required
              value={String(auth.path)}
              onChange={(event) =>
                set("auth", {
                  ...auth,
                  path: event.target.value,
                })
              }
            />
          </label>
        ) : null}
        {auth.kind === "password" ? (
          <label>
            {auth.credentialRefId
              ? "Replacement SSH password (optional)"
              : "SSH password"}
            <input
              aria-label="SSH password"
              type="password"
              autoComplete="new-password"
              required={!auth.credentialRefId}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
            <span className="hardware-muted">
              {auth.credentialRefId
                ? "Password saved on CloudX host"
                : "Saved privately on the CloudX host. Hardware stores only a reference."}
            </span>
          </label>
        ) : auth.kind === "agent" ? (
          <p className="hardware-muted">
            {auth.socketPath
              ? "Uses the item's explicitly configured SSH agent."
              : "Uses the SSH agent available to the CloudX server."}
          </p>
        ) : null}
        <label>
          Connection timeout (ms)
          <input
            aria-label="SSH connection timeout"
            type="number"
            required
            min={1}
            max={120000}
            value={Number(config.connectTimeoutMs)}
            onChange={(event) =>
              set("connectTimeoutMs", Number(event.target.value))
            }
          />
        </label>
        <p className="hardware-banner">
          {config.knownHostsFile
            ? "Verifies host keys against the configured known-hosts file."
            : "New host keys are saved automatically. Changed host keys are blocked."}
        </p>
      </>
    );
  }
  if (typeId === "hardware.uart")
    return (
      <>
        <label>
          Device path
          <input
            aria-label="UART device path"
            required
            value={String(config.devicePath)}
            onChange={(event) => set("devicePath", event.target.value)}
            placeholder="/dev/serial/by-id/…"
          />
        </label>
        <label>
          Baud rate
          <input
            aria-label="UART baud rate"
            type="number"
            required
            min={1}
            max={4000000}
            value={Number(config.baudRate)}
            onChange={(event) => set("baudRate", Number(event.target.value))}
          />
        </label>
        <div className="hardware-form-grid">
          {[
            { key: "dataBits", label: "Data bits", values: [5, 6, 7, 8] },
            { key: "stopBits", label: "Stop bits", values: [1, 2] },
            { key: "parity", label: "Parity", values: ["none", "even", "odd"] },
            {
              key: "flowControl",
              label: "Flow control",
              values: ["none", "rtscts"],
            },
          ].map((field) => (
            <label key={field.key}>
              {field.label}
              <select
                aria-label={`UART ${field.label.toLowerCase()}`}
                value={String(config[field.key])}
                onChange={(event) =>
                  set(
                    field.key,
                    typeof field.values[0] === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                  )
                }
              >
                {field.values.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="hardware-banner warning">
          Opening a serial device can change DTR/RTS. Check the board notes
          before access.
        </p>
      </>
    );
  return (
    <label>
      Provider configuration (JSON)
      <textarea
        aria-label="Provider configuration"
        required
        rows={12}
        defaultValue={JSON.stringify(config, null, 2)}
        onBlur={(event) => {
          try {
            const value: unknown = JSON.parse(event.target.value);
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error();
            event.target.setCustomValidity("");
            onChange(value as JsonObject);
          } catch {
            event.target.setCustomValidity(
              "Enter a JSON object matching the provider schema.",
            );
          }
        }}
      />
    </label>
  );
}

export function HookFields({
  value,
  onChange,
}: {
  value: HardwareItem["hooks"];
  onChange: (value: HardwareItem["hooks"]) => void;
}) {
  return (
    <section className="hardware-card">
      <h3>Reservation hooks</h3>
      <p className="hardware-muted">
        The exclusive claim is saved before preparation. Failed or uncertain
        cleanup keeps the resource held.
      </p>
      {(
        [
          { key: "beforeReserve", label: "Before reserve" },
          { key: "onRelease", label: "On release" },
        ] as const
      ).map((hook) => (
        <div className="hardware-hook" key={hook.key}>
          <label className="hardware-checkbox">
            <input
              type="checkbox"
              aria-label={`Enable ${hook.label}`}
              checked={Boolean(value[hook.key])}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? { ...value, [hook.key]: emptyScript() }
                    : Object.fromEntries(
                        Object.entries(value).filter(
                          ([key]) => key !== hook.key,
                        ),
                      ),
                )
              }
            />
            {hook.label} (optional)
          </label>
          {value[hook.key] ? (
            <ScriptFields
              label={`${hook.label} Bash script`}
              value={value[hook.key]!}
              onChange={(script) => onChange({ ...value, [hook.key]: script })}
            />
          ) : null}
        </div>
      ))}
      <p className="hardware-muted">
        Hook context always travels as JSON on stdin. Saving never runs a
        script. Working directories must exist within a CloudX allowed root.
      </p>
    </section>
  );
}

export function StatusBindings({
  state,
  bindings,
  summary,
  onChange,
}: {
  state: HardwareStateView;
  bindings: StatusBinding[];
  summary?: HardwareSummary;
  onChange: (bindings: StatusBinding[]) => void;
}) {
  const [definitionId, setDefinitionId] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  function change(index: number, binding: StatusBinding) {
    onChange(
      bindings.map((current, position) =>
        position === index
          ? { ...binding, revision: current.revision + 1 }
          : current,
      ),
    );
  }
  const available = state.statusDefinitions.filter(
    (definition) =>
      !bindings.some((binding) => binding.definitionId === definition.id),
  );
  return (
    <section className="hardware-card">
      <h3>Custom statuses</h3>
      {bindings.map((binding, index) => {
        const definition = state.statusDefinitions.find(
          (value) => value.id === binding.definitionId,
        );
        if (!definition)
          return (
            <p key={binding.definitionId}>
              Missing status definition: {binding.definitionId}
            </p>
          );
        return (
          <details
            className="hardware-status-editor"
            key={binding.definitionId}
            open={
              expandedId ? expandedId === binding.definitionId : index === 0
            }
          >
            <summary>
              {definition.label} · {binding.source} · {definition.valueType}
              {summary ? (
                <Observation summary={summary} definitionId={definition.id} />
              ) : null}
            </summary>
            {summary ? (
              <div className="hardware-status-live">
                <Observation
                  summary={summary}
                  definitionId={definition.id}
                  detailed
                  detailsOnly
                />
              </div>
            ) : null}
            <label>
              Source
              <select
                aria-label={`${definition.label} source`}
                value={binding.source}
                onChange={(event) => {
                  const common = {
                    revision: binding.revision,
                    definitionId: binding.definitionId,
                    ...(binding.requiredForReserve
                      ? { requiredForReserve: binding.requiredForReserve }
                      : {}),
                  };
                  change(
                    index,
                    event.target.value === "manual"
                      ? { ...newStatusBinding(definition), ...common }
                      : {
                          ...common,
                          source: "command",
                          script: emptyScript(),
                          maxAgeMs: 60000,
                          intervalMs: null,
                        },
                  );
                }}
              >
                <option value="manual">Manual value</option>
                <option value="command">Bash command</option>
              </select>
            </label>
            {binding.source === "manual" ? (
              <StatusInput
                label={`${definition.label} manual value`}
                definition={definition}
                value={binding.value}
                onChange={(value) => change(index, { ...binding, value })}
              />
            ) : (
              <>
                <ScriptFields
                  label={`${definition.label} status command`}
                  value={binding.script}
                  onChange={(script) => change(index, { ...binding, script })}
                />
                <div className="hardware-form-grid">
                  <label>
                    Maximum age (ms)
                    <input
                      aria-label={`${definition.label} maximum age`}
                      type="number"
                      required
                      min={1}
                      value={binding.maxAgeMs}
                      onChange={(event) =>
                        change(index, {
                          ...binding,
                          maxAgeMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Check interval (ms; 0 = manual)
                    <input
                      aria-label={`${definition.label} check interval`}
                      type="number"
                      min={0}
                      value={binding.intervalMs ?? 0}
                      onChange={(event) =>
                        change(index, {
                          ...binding,
                          intervalMs: Number(event.target.value) || null,
                        })
                      }
                    />
                  </label>
                </div>
                <p className="hardware-muted">
                  {definition.valueType === "boolean" ? (
                    <>
                      Exit <code>0</code> means <code>true</code>; a normal
                      nonzero exit means <code>false</code>. Stdout is
                      diagnostic output.
                    </>
                  ) : definition.valueType === "text" ? (
                    "Exit zero and output one JSON string, including quotes."
                  ) : (
                    "Exit zero and output one JSON string matching an allowed enum value."
                  )}{" "}
                  Use an existing directory within a CloudX allowed root.
                  Scheduled checks skip held groups.
                </p>
              </>
            )}
            <label className="hardware-checkbox">
              <input
                type="checkbox"
                aria-label={`Require ${definition.label} for reservation`}
                checked={Boolean(binding.requiredForReserve)}
                onChange={(event) => {
                  const { requiredForReserve: _required, ...rest } = binding;
                  change(
                    index,
                    event.target.checked
                      ? {
                          ...rest,
                          requiredForReserve: {
                            equals:
                              definition.valueType === "boolean"
                                ? true
                                : (definition.enumValues?.[0] ?? ""),
                          },
                        }
                      : rest,
                  );
                }}
              />
              Required to reserve
            </label>
            {binding.requiredForReserve ? (
              <StatusInput
                label={`${definition.label} required value`}
                definition={definition}
                value={binding.requiredForReserve.equals}
                onChange={(equals) =>
                  change(index, { ...binding, requiredForReserve: { equals } })
                }
              />
            ) : null}
            <ControlButton
              size="compact"
              onClick={() =>
                onChange(bindings.filter((_, position) => position !== index))
              }
            >
              <Trash2 size={13} />
              Remove {definition.label} binding
            </ControlButton>
          </details>
        );
      })}
      <div className="hardware-inline">
        <select
          aria-label="Status definition to add"
          value={definitionId}
          onChange={(event) => setDefinitionId(event.target.value)}
        >
          <option value="">Choose a status definition</option>
          {available.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label}
            </option>
          ))}
        </select>
        <ControlButton
          size="compact"
          disabled={!available.some((value) => value.id === definitionId)}
          onClick={() => {
            onChange([
              ...bindings,
              newStatusBinding(
                available.find((value) => value.id === definitionId)!,
              ),
            ]);
            setExpandedId(definitionId);
            setDefinitionId("");
          }}
        >
          <Plus size={13} />
          Add status
        </ControlButton>
      </div>
      {!state.statusDefinitions.length ? (
        <p className="hardware-muted">
          Create a status definition in Tags & types first.
        </p>
      ) : null}
    </section>
  );
}
