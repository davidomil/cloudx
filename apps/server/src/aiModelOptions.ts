import type { ConfigFieldOption } from "@cloudx/shared";

export const DOCUMENTATION_AI_USE_VOICE_MODEL = "__voice_model__";
export const DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL = "gpt-5.4-mini";
export const CODEX_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "GPT-6-Astra",
    value: "gpt-6-astra",
    description: "Our most capable model for complex, demanding work."
  },
  {
    label: "GPT-5.6-Sol",
    value: "gpt-5.6-sol",
    description: "Reliable agentic workhorse for everyday tasks."
  },
  {
    label: "GPT-5.6-Terra",
    value: "gpt-5.6-terra",
    description: "Balanced agentic coding model for everyday work."
  },
  {
    label: "GPT-5.6-Luna",
    value: "gpt-5.6-luna",
    description: "Fast and affordable agentic coding model."
  },
  {
    label: "GPT-5.5",
    value: "gpt-5.5",
    description: "Frontier model for complex coding, research, and real-world work."
  },
  {
    label: "GPT-5.4",
    value: "gpt-5.4",
    description: "Strong model for everyday coding."
  },
  {
    label: "GPT-5.4-Mini",
    value: "gpt-5.4-mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks."
  },
  {
    label: "GPT-5.3-Codex-Spark",
    value: "gpt-5.3-codex-spark",
    description: "Ultra-fast coding model."
  }
];

export const DOCUMENTATION_AI_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "Same as voice control",
    value: DOCUMENTATION_AI_USE_VOICE_MODEL,
    description: "Use the current CloudX voice-control Codex model."
  },
  ...CODEX_MODEL_OPTIONS
];
