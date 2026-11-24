import { agentProviderLabel, type AgentProviderStatus, type ConfigFieldOption } from "@cloudx/shared";

// Checks the executable selected by CloudX, not a browser or shell installation.
export function modelNativeWarning(option: ConfigFieldOption, providers?: AgentProviderStatus[]): string | undefined {
  const requirement = option.nativeRequirement;
  if (!requirement) return undefined;
  const label = agentProviderLabel(requirement.providerId);
  const provider = providers?.find(item => item.providerId === requirement.providerId);
  const required = `${label} ${requirement.minimumVersion} or later`;
  if (!provider) return `Verify the selected ${label} executable; requires ${required}.`;
  if (!provider.installed) return `The selected ${label} executable is unavailable; requires ${required}.`;
  const versionPattern = requirement.providerId === "codex"
    ? /^(?:codex-cli )?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
    : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(Claude Code\))?$/u;
  const version = provider.version?.match(versionPattern)?.slice(1).map(Number);
  if (!version) return `The selected ${label} version is unknown; requires ${required}.`;
  const minimum = requirement.minimumVersion.split(".").map(Number);
  const difference = version.map((value, index) => value - minimum[index]!).find(value => value !== 0) ?? 0;
  if (difference < 0) return `Selected ${provider.command ?? label} reports ${provider.version}; requires ${required}.`;
  return undefined;
}
