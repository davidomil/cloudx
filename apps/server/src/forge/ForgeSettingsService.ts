import type { ConfigFieldDescriptor, ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import type { ConfigService } from "../configService.js";
import type { ForgeConnectionService } from "./connections/ForgeConnectionService.js";
import { ForgeCredentials, validateRepository } from "./providers/ForgeCredentials.js";
import { createForgeProvider } from "./providers/index.js";
import type { ForgeProvider } from "./providers/ForgeProvider.js";
import type { ForgeSettings } from "./ForgeWorkflowService.js";

export class ForgeSettingsService {
  constructor(
    private readonly config: ConfigService,
    private readonly connections: Pick<ForgeConnectionService, "credential">,
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
      maxRunMinutes: Number(this.config.getPluginConfig("forge").maxRunMinutes),
    };
  }

  provider(repository: ForgeRepository, role: ForgeCredentialRole, signal?: AbortSignal): ForgeProvider {
    return createForgeProvider(repository, this.credentials(repository), { role, signal });
  }

  gitAccess(repository: ForgeRepository, role: ForgeCredentialRole, signal?: AbortSignal) {
    return this.credentials(repository).gitAccess(role, signal);
  }

  private credentials(repository: ForgeRepository): ForgeCredentials {
    const current = this.repository();
    if (current.provider !== repository.provider || current.apiUrl !== repository.apiUrl || current.projectPath !== repository.projectPath)
      throw new Error("This worker belongs to a different repository. Restore its repository settings before continuing.");
    return new ForgeCredentials(repository, async role => this.connections.credential(repository, role));
  }

  private required(key: string): string {
    const value = this.config.getPluginConfig("forge")[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Configure ${key} in Forge settings.`);
    return value.trim();
  }
}
export function forgeConfigFields(): ConfigFieldDescriptor[] {
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
      key: "reviewTemplateId",
      label: "Review template",
      type: "string",
      optionSource: "rulesSkills.templates",
      defaultValue: "",
      description:
        "Choose a Rules / Skills template for review agents.",
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
