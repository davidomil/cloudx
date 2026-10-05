import {
  AGENT_PRICE_FIELDS,
  MODEL_ID_PATTERN,
  isAgentModelPrice,
  isRecord,
  type AgentModelPrice,
  type AgentPricingState
} from "@cloudx/shared";

import { JsonStateFile } from "../../jsonStateFile.js";
import type { UsageRecord } from "./usageRecord.js";

// Standard API prices in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing and
// https://developers.openai.com/api/docs/pricing, read on the date below.
const PRICES_AS_OF = "2026-10-05";

const BUILT_IN_PRICES: Record<string, AgentModelPrice> = {
  "claude-fable-5-1": { input: 10, cachedInput: 0.25, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
  "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWrite: 0, output: 30 }
};

// OpenAI reprices a whole request above this many input tokens.
const LONG_CONTEXT_INPUT_TOKENS = 272_000;
const LONG_CONTEXT_PRICES: Record<string, AgentModelPrice> = {
  "gpt-6.1-sol": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  "gpt-6-astra": { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 },
  "gpt-5.6-sol": { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
  "gpt-5.6-terra": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  "gpt-5.6-luna": { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  "gpt-5.5": { input: 10, cachedInput: 1, cacheWrite: 0, output: 45 }
};
// Claude fast mode doubles input and output prices on these models; cache
// multipliers apply on top.
const FAST_MODE_MULTIPLIER: Record<string, number> = { "claude-opus-5-5": 2, "claude-opus-5": 2 };
// US-only inference costs 1.1x on Claude 4.6 and later models.
const US_INFERENCE_MULTIPLIER = 1.1;
const WEB_SEARCH_USD = 10 / 1000;

// Claude model ids may carry a date suffix, such as claude-haiku-4-5-20251001.
function priceKey(model: string): string {
  return model.replace(/-\d{8}$/u, "");
}

export class AgentPricing {
  private readonly file: JsonStateFile;

  constructor(dataDir: string) {
    this.file = new JsonStateFile(dataDir, "agent-pricing.json", "Agent pricing", 0o600);
  }

  async state(): Promise<AgentPricingState> {
    return { asOf: PRICES_AS_OF, builtIn: BUILT_IN_PRICES, overrides: await this.overrides() };
  }

  async updateOverrides(overrides: unknown): Promise<AgentPricingState> {
    await this.file.write(parseOverrides(overrides));
    return this.state();
  }

  // Prices one record, or returns undefined when its model has no price.
  async pricer(): Promise<(record: UsageRecord) => number | undefined> {
    const overrides = await this.overrides();
    return record => {
      const key = priceKey(record.model);
      const override = overrides[key];
      const longContext = !override && record.input + record.cachedInput > LONG_CONTEXT_INPUT_TOKENS ? LONG_CONTEXT_PRICES[key] : undefined;
      const price = override ?? longContext ?? BUILT_IN_PRICES[key];
      if (!price) return undefined;
      const speed = record.fast ? FAST_MODE_MULTIPLIER[key] ?? 1 : 1;
      const geo = record.usInference ? US_INFERENCE_MULTIPLIER : 1;
      const tokens = (record.input * price.input + record.cachedInput * price.cachedInput +
        record.cacheWrite * price.cacheWrite + record.cacheWrite1h * (price.cacheWrite1h ?? price.cacheWrite) +
        record.output * price.output) / 1_000_000;
      return tokens * speed * geo + record.webSearches * WEB_SEARCH_USD;
    };
  }

  private async overrides(): Promise<Record<string, AgentModelPrice>> {
    return parseOverrides(await this.file.read<unknown>() ?? {});
  }
}

function parseOverrides(value: unknown): Record<string, AgentModelPrice> {
  if (!isRecord(value)) throw new Error("Agent pricing overrides must be an object of model prices.");
  const overrides: Record<string, AgentModelPrice> = {};
  for (const [model, price] of Object.entries(value)) {
    if (!MODEL_ID_PATTERN.test(model)) throw new Error(`Invalid model id in pricing: ${model}`);
    if (!isAgentModelPrice(price)) throw new Error(`Prices for ${model} need ${AGENT_PRICE_FIELDS.join(", ")} as non-negative numbers.`);
    overrides[priceKey(model)] = price;
  }
  return overrides;
}
