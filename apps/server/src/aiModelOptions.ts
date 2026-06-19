import type { ConfigFieldOption } from "@cloudx/shared";

export const DOCUMENTATION_AI_USE_VOICE_MODEL = "__voice_model__";
export const DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL = "gpt-5.4-mini";
export const DOCUMENTATION_AI_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "Same as voice control",
    value: DOCUMENTATION_AI_USE_VOICE_MODEL,
    description: "Use the current CloudX voice-control Codex model."
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

export const VOICE_MODEL_OPTIONS = DOCUMENTATION_AI_MODEL_OPTIONS.filter((option) => option.value !== DOCUMENTATION_AI_USE_VOICE_MODEL);
