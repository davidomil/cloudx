import { JIRA_FILTER_JQL_MAX_LENGTH, JIRA_FILTER_NAME_MAX_LENGTH, type JiraFilterState, type JiraSaveFilterInput } from "@cloudx/shared";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { ControlButton } from "./Control.js";

export type JiraFilterAction = "jira.filters.save" | "jira.filters.select" | "jira.filters.delete";

export function JiraFilterBar({ state, busy, onChange }: {
  state: JiraFilterState | undefined;
  busy: boolean;
  onChange: (action: JiraFilterAction, input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<JiraSaveFilterInput>();
  const selected = state?.filters.find((filter) => filter.id === state.selectedFilterId);
  const disabled = busy || !state;

  return (
    <div className="jira-filter-bar">
      <div className="jira-filter-actions">
        <label>
          <span>View</span>
          <select aria-label="Jira filter" value={state?.selectedFilterId ?? ""} disabled={disabled || Boolean(draft)} onChange={(event) => {
            void onChange("jira.filters.select", { filterId: event.target.value || null });
          }}>
            <option value="">Configured dashboard</option>
            {state?.filters.map((filter) => <option key={filter.id} value={filter.id}>{filter.name}</option>)}
          </select>
        </label>
        <ControlButton size="compact" disabled={disabled || Boolean(draft)} onClick={() => setDraft({ name: "", jql: "resolution = EMPTY ORDER BY updated DESC" })}>
          <Plus size={14} /> New filter
        </ControlButton>
        <ControlButton size="compact" iconOnly title="Edit filter" aria-label="Edit filter" disabled={disabled || !selected || Boolean(draft)} onClick={() => setDraft(selected)}>
          <Pencil size={14} />
        </ControlButton>
        <ControlButton size="compact" iconOnly title="Delete filter" aria-label="Delete filter" disabled={disabled || !selected || Boolean(draft)} onClick={() => {
          if (selected) void onChange("jira.filters.delete", { id: selected.id });
        }}>
          <Trash2 size={14} />
        </ControlButton>
      </div>
      {draft ? (
        <form className="jira-filter-form" aria-label={draft.id ? "Edit Jira filter" : "New Jira filter"} onSubmit={(event) => {
          event.preventDefault();
          void onChange("jira.filters.save", { ...draft }).then((saved) => {
            if (saved) setDraft(undefined);
          });
        }}>
          <label>Filter name
            <input autoFocus required maxLength={JIRA_FILTER_NAME_MAX_LENGTH} value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label>JQL
            <textarea required maxLength={JIRA_FILTER_JQL_MAX_LENGTH} rows={3} value={draft.jql} disabled={busy} onChange={(event) => setDraft({ ...draft, jql: event.target.value })} />
          </label>
          <p>Saved in CloudX. Enter complete JQL; include <code>assignee = currentUser()</code> to see only your issues.</p>
          <div className="jira-filter-actions">
            <ControlButton type="submit" size="compact" disabled={busy || !draft.name.trim() || !draft.jql.trim()}>Save filter</ControlButton>
            <ControlButton type="button" size="compact" disabled={busy} onClick={() => setDraft(undefined)}>Cancel</ControlButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}
