import { useEffect, useId, useState } from "react";
import type { CodexStateSource } from "@cloudx/shared";
import { getCodexStateSources } from "../api.js";

/** Mounted only for resume; selection is explicit and source keys stay opaque. */
export function CodexStateSourceSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (sourceId: string) => void;
}) {
  const [sources, setSources] = useState<CodexStateSource[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    void getCodexStateSources(controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setSources(response.sources);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to load session sources.",
          );
      },
    );
    return () => controller.abort();
  }, []);
  const query = filter.trim().toLocaleLowerCase();
  const matches = sources?.filter((source) =>
    `${source.label} ${source.updatedAt ?? ""} ${source.sourceId}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const selected = sources?.find((source) => source.sourceId === value);
  return (
    <div className="field-group" style={{ minWidth: 0 }}>
      <label htmlFor={`${id}-filter`}>Find session source</label>
      <input
        id={`${id}-filter`}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Template, date, or source key"
        disabled={!sources}
      />
      <label htmlFor={`${id}-source`}>Session source</label>
      <select
        id={`${id}-source`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={!sources || sources.length === 0}
        style={{ width: "100%", minWidth: 0 }}
      >
        <option value="">Select a session source</option>
        {matches?.map((source) => (
          <option key={source.sourceId} value={source.sourceId}>
            {source.label}
            {source.updatedAt
              ? ` · ${source.updatedAt.slice(0, 10)}`
              : ""} · {source.sourceId}
          </option>
        ))}
        {selected && !matches?.includes(selected) ? (
          <option value={selected.sourceId} hidden>
            {selected.label}
          </option>
        ) : null}
      </select>
      {error ? (
        <div role="alert">{error}</div>
      ) : !sources ? (
        <div role="status">Loading session sources…</div>
      ) : sources.length === 0 ? (
        <div role="status">No session sources available.</div>
      ) : matches?.length === 0 ? (
        <div role="status">No matching session sources.</div>
      ) : null}
      {selected ? (
        <div
          style={{
            overflowWrap: "anywhere",
            userSelect: "text",
            textTransform: "none",
          }}
          aria-label="Selected session source key"
        >
          {selected.sourceId}
        </div>
      ) : null}
    </div>
  );
}
