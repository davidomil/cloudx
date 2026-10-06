import { useCallback, useEffect, useState } from "react";
import { AGENT_PRICE_FIELDS, AGENT_USAGE_HOOKS, isAgentModelPrice, type AgentModelPrice, type AgentPricingState } from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;
type PriceField = typeof AGENT_PRICE_FIELDS[number];
// Text per model and field; an empty row means "use the built-in price".
type Draft = Record<string, Partial<Record<PriceField, string>>>;

const FIELD_LABELS: Record<PriceField, string> = { input: "Input", cachedInput: "Cached input", cacheWrite: "Cache write", cacheWrite1h: "1h cache write", output: "Output" };

function draftFrom(overrides: Record<string, AgentModelPrice>): Draft {
  return Object.fromEntries(Object.entries(overrides).map(([model, price]) =>
    [model, Object.fromEntries(AGENT_PRICE_FIELDS.filter(field => price[field] !== undefined).map(field => [field, String(price[field])]))]));
}

// Rows with any value must be complete; empty rows are dropped.
function overridesFrom(draft: Draft): { overrides: Record<string, AgentModelPrice>; invalid: string[] } {
  const overrides: Record<string, AgentModelPrice> = {};
  const invalid: string[] = [];
  for (const [model, row] of Object.entries(draft)) {
    const filled = AGENT_PRICE_FIELDS.filter(field => row[field]?.trim());
    if (!filled.length) continue;
    const price = Object.fromEntries(filled.map(field => [field, Number(row[field])]));
    if (isAgentModelPrice(price)) overrides[model] = price;
    else invalid.push(model);
  }
  return { overrides, invalid };
}

export function AgentPricingPanel({ callHook }: { callHook: CallHook }) {
  const [pricing, setPricing] = useState<AgentPricingState>();
  const [draft, setDraft] = useState<Draft>({});
  const [newModel, setNewModel] = useState("");
  const [status, setStatus] = useState<string>();

  const accept = useCallback((state: AgentPricingState) => { setPricing(state); setDraft(draftFrom(state.overrides)); }, []);
  useEffect(() => {
    callHook<{ pricing: AgentPricingState }>(AGENT_USAGE_HOOKS.readPricing, {}).then(result => accept(result.pricing))
      .catch(error => setStatus(error instanceof Error ? error.message : String(error)));
  }, [accept, callHook]);

  if (!pricing) return <section className="agent-accounts-panel" aria-label="Model pricing"><h3>Model pricing</h3><p>{status ?? "Loading prices…"}</p></section>;
  const models = [...new Set([...Object.keys(pricing.builtIn), ...Object.keys(draft)])].sort();
  const { overrides, invalid } = overridesFrom(draft);
  const set = (model: string, field: PriceField, value: string) => setDraft(current => ({ ...current, [model]: { ...current[model], [field]: value } }));

  return <section className="agent-accounts-panel" aria-label="Model pricing">
    <h3>Model pricing</h3>
    <p>USD per million tokens, used for the usage shown on tabs, windows and Forge workers. Built-in prices are standard API prices as of {pricing.asOf}. Fill a row to override a model; clear it to return to the built-in price.</p>
    <div className="agent-pricing-table">
      <table>
        <thead><tr><th>Model</th>{AGENT_PRICE_FIELDS.map(field => <th key={field}>{FIELD_LABELS[field]}</th>)}</tr></thead>
        <tbody>
          {models.map(model => <tr key={model}>
            <th scope="row">{model}</th>
            {AGENT_PRICE_FIELDS.map(field => <td key={field}>
              <input aria-label={`${model} ${FIELD_LABELS[field]}`} inputMode="decimal" value={draft[model]?.[field] ?? ""}
                placeholder={pricing.builtIn[model]?.[field]?.toString() ?? ""} onChange={event => set(model, field, event.target.value)} />
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <form className="agent-account-form" onSubmit={event => {
      event.preventDefault();
      const model = newModel.trim();
      if (model) { setDraft(current => ({ ...current, [model]: current[model] ?? {} })); setNewModel(""); }
    }}>
      <label>Add a model<input value={newModel} maxLength={128} placeholder="Model id, such as gpt-6.1-sol" onChange={event => setNewModel(event.target.value)} /></label>
    </form>
    {invalid.length ? <p role="alert" className="agent-error">Complete input, cached input, cache write and output for {invalid.join(", ")}, as non-negative numbers.</p> : null}
    {status ? <p role="status">{status}</p> : null}
    <ControlButton tone="primary" disabled={invalid.length > 0} onClick={() => void callHook<{ pricing: AgentPricingState }>(AGENT_USAGE_HOOKS.updatePricing, { overrides })
      .then(result => { accept(result.pricing); setStatus("Prices saved."); })
      .catch(error => setStatus(error instanceof Error ? error.message : String(error)))}>Save prices</ControlButton>
  </section>;
}
