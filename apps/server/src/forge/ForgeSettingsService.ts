import { CODEX_REASONING_EFFORTS, type CodexReasoningEffort, type ConfigFieldDescriptor, type ForgeCredentialRole, type ForgeRepository } from "@cloudx/shared";
import type { ConfigService } from "../configService.js";
import { CODEX_MODEL_OPTIONS } from "../aiModelOptions.js";
import type { ForgeConnectionService } from "./connections/ForgeConnectionService.js";
import { ForgeCredentials, validateRepository } from "./providers/ForgeCredentials.js";
import { createForgeProvider } from "./providers/index.js";
import type { ForgeProvider } from "./providers/ForgeProvider.js";
import type { ForgeSettings } from "./ForgeWorkflowService.js";

export class ForgeSettingsService {
  private repositoryCredentials?: { key: string; credentials: ForgeCredentials };

  constructor(
    private readonly config: ConfigService,
    private readonly connections: Pick<ForgeConnectionService, "credential" | "workerAuthors">,
  ) {}

  repository(): ForgeRepository {
    const provider = this.required("provider");
    if (provider !== "github" && provider !== "gitlab") throw new Error("Select GitHub or GitLab in Forge settings.");
    const repository: ForgeRepository = { provider, apiUrl: this.required("apiUrl").replace(/\/$/, ""), projectPath: this.required("projectPath") };
    validateRepository(repository);
    return repository;
  }

  settings(): ForgeSettings {
    const repository = this.repository();
    this.connections.credential(repository, "worker");
    this.connections.credential(repository, "reviewer");
    return {
      repository,
      baseBranch: this.required("baseBranch"),
      workerTemplateId: this.required("workerTemplateId"),
      reviewTemplateId: this.required("reviewTemplateId"),
      workerModel: this.required("workerModel"),
      workerReasoningEffort: this.required("workerReasoningEffort") as CodexReasoningEffort,
      reviewModel: this.required("reviewModel"),
      reviewReasoningEffort: this.required("reviewReasoningEffort") as CodexReasoningEffort,
      maxRunMinutes: Number(this.config.getPluginConfig("forge").maxRunMinutes),
    };
  }

  isRepositoryTrusted(repository: ForgeRepository): boolean {
    const approved = this.config.getPluginConfig("forge").trustedRepository;
    return approved === repositoryTrustKey(repository) && approved === repositoryTrustKey(this.repository());
  }

  provider(repository: ForgeRepository, role: ForgeCredentialRole, signal?: AbortSignal): ForgeProvider {
    return createForgeProvider(repository, this.credentials(repository), {
      role,
      signal,
      listIdentity: () => ({
        username: String(this.config.getPluginConfig("forge").username ?? "").trim(),
        workerAuthors: this.connections.workerAuthors(repository),
      }),
    });
  }

  gitAccess(repository: ForgeRepository, role: ForgeCredentialRole, signal?: AbortSignal) {
    return this.credentials(repository).gitAccess(role, signal);
  }

  private credentials(repository: ForgeRepository): ForgeCredentials {
    const current = this.repository();
    if (current.provider !== repository.provider || current.apiUrl !== repository.apiUrl || current.projectPath !== repository.projectPath)
      throw new Error("This worker belongs to a different repository. Restore its repository settings before continuing.");
    const key = repositoryTrustKey(repository);
    if (this.repositoryCredentials?.key !== key)
      this.repositoryCredentials = { key, credentials: new ForgeCredentials(current, async role => this.connections.credential(current, role)) };
    return this.repositoryCredentials.credentials;
  }

  private required(key: string): string {
    const value = this.config.getPluginConfig("forge")[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Configure ${key} in Forge settings.`);
    return value.trim();
  }
}
export function forgeConfigFields(): ConfigFieldDescriptor[] {
  const reasoningOptions = CODEX_REASONING_EFFORTS.map(value => ({ value, label: value === "xhigh" ? "X-high" : value[0].toUpperCase() + value.slice(1) }));
  const fields: ConfigFieldDescriptor[] = [
    {
      key: "provider",
      label: "Provider",
      type: "select",
      defaultValue: "github",
      options: [
        { label: "GitHub", value: "github" },
        { label: "GitLab", value: "gitlab" },
      ],
    },
    {
      key: "apiUrl",
      label: "API URL",
      type: "string",
      defaultValue: "https://api.github.com",
      description:
        "GitHub: https://api.github.com. GitLab: https://gitlab.com/api/v4. Enterprise/self-hosted HTTPS endpoints are supported.",
    },
    {
      key: "projectPath",
      label: "Repository",
      type: "string",
      defaultValue: "",
      description: "GitHub owner/repository or GitLab group/subgroup/project.",
    },
    {
      key: "username",
      label: "Your username",
      type: "string",
      defaultValue: "",
      description: "Your username on the selected GitHub or GitLab host, used by Assigned to me and Created by me filters.",
    },
    {
      key: "trustedRepository",
      label: "Approved repository trust",
      type: "string",
      visibility: "internal",
      defaultValue: "",
    },
    {
      key: "baseBranch",
      label: "Target branch",
      type: "string",
      defaultValue: "main",
    },
    {
      key: "workerTemplateId",
      label: "Issue worker template",
      type: "string",
      optionSource: "rulesSkills.templates",
      defaultValue: "",
      description:
        "Choose a Rules / Skills template for implementation agents.",
    },
    {
      key: "workerModel",
      label: "Coding model",
      type: "select",
      defaultValue: "gpt-6-astra",
      options: CODEX_MODEL_OPTIONS,
      description: "Codex model for new coding runs and resumes.",
    },
    {
      key: "workerReasoningEffort",
      label: "Coding reasoning effort",
      type: "select",
      defaultValue: "xhigh",
      options: reasoningOptions,
      description: "Choose a reasoning level supported by the coding model.",
    },
    {
      key: "reviewTemplateId",
      label: "Review template",
      type: "string",
      optionSource: "rulesSkills.templates",
      defaultValue: "",
      description:
        "Choose a Rules / Skills template for review agents.",
    },
    {
      key: "reviewModel",
      label: "Review model",
      type: "select",
      defaultValue: "gpt-6-astra",
      options: CODEX_MODEL_OPTIONS,
      description: "Codex model for new review runs and resumes.",
    },
    {
      key: "reviewReasoningEffort",
      label: "Review reasoning effort",
      type: "select",
      defaultValue: "max",
      options: reasoningOptions,
      description: "Choose a reasoning level supported by the review model.",
    },
    {
      key: "maxRunMinutes",
      label: "Worker time limit (minutes)",
      type: "number",
      defaultValue: 180,
      min: 1,
      max: 1440,
      step: 1,
    },
  ];
  return fields;
}

function repositoryTrustKey(repository: ForgeRepository): string {
  return JSON.stringify([repository.provider, repository.apiUrl, repository.projectPath]);
}
