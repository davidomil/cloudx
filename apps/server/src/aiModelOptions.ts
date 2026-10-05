import { DEFAULT_CODEX_MODEL, type ConfigFieldOption } from "@cloudx/shared";

export const DOCUMENTATION_AI_USE_VOICE_MODEL = "__voice_model__";
export const DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL = "gpt-5.6-luna";
export const CODEX_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "GPT-6.1 Sol",
    value: DEFAULT_CODEX_MODEL,
    description: "Default for Codex coding and review work."
  },
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
  }
];

// Claude models offered wherever a model is chosen per run: voice planning,
// documentation enrichment and Forge. Choosing one routes the run to Claude
// Code with the configured Claude account.
export const CLAUDE_EXEC_MODEL_OPTIONS: ConfigFieldOption[] = [
  { label: "Claude Opus 5.5", value: "claude-opus-5-5", description: "Most capable model for complex coding and review work." },
  { label: "Claude Sonnet 5.5", value: "claude-sonnet-5-5", description: "Balanced model for everyday coding work." },
  { label: "Claude Fable 5.1", value: "claude-fable-5-1", description: "Fast model for routine coding tasks." },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", description: "Fastest and most affordable model." }
];
export const AGENT_EXEC_MODEL_OPTIONS: ConfigFieldOption[] = [...CODEX_MODEL_OPTIONS, ...CLAUDE_EXEC_MODEL_OPTIONS];

export const DOCUMENTATION_AI_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "Same as voice control",
    value: DOCUMENTATION_AI_USE_VOICE_MODEL,
    description: "Use the current CloudX voice-control model."
  },
  ...AGENT_EXEC_MODEL_OPTIONS
];

