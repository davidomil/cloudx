import { DEFAULT_CODEX_MODEL, type ConfigFieldOption } from "@cloudx/shared";

export const DOCUMENTATION_AI_USE_VOICE_MODEL = "__voice_model__";
export const DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL = "gpt-5.6-luna";
export const CODEX_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "GPT-6.2 Sol",
    value: "gpt-6.2-sol",
    description: "Everyday coding and agent work. Availability depends on the selected account.",
    nativeRequirement: { providerId: "codex", minimumVersion: "0.166.0" }
  },
  {
    label: "GPT-6.2 Astra",
    value: "gpt-6.2-astra",
    description: "Demanding projects and complex reasoning. Availability depends on the selected account.",
    nativeRequirement: { providerId: "codex", minimumVersion: "0.166.0" }
  },
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
  { label: "Claude Fable 5.2", value: "claude-fable-5-2", description: "Demanding reasoning and long-running agent work. Requires account/provider access; usage credits may apply.", nativeRequirement: { providerId: "claude", minimumVersion: "2.1.321" } },
  { label: "Claude Haiku 5.5", value: "claude-haiku-5-5", description: "Fast, affordable model for bounded tasks. Availability depends on the selected account/provider.", nativeRequirement: { providerId: "claude", minimumVersion: "2.1.293" } },
  { label: "Claude Opus 5.5", value: "claude-opus-5-5", description: "Most capable model for complex coding and review work." },
  { label: "Claude Sonnet 5.5", value: "claude-sonnet-5-5", description: "Balanced model for everyday coding work." },
  { label: "Claude Fable 5.1", value: "claude-fable-5-1", description: "Earlier model for demanding reasoning and long-running agent work." },
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

