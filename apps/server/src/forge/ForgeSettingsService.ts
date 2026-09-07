import type {
  ConfigFieldDescriptor,
  ForgeCredentialRole,
  ForgeRepository,
} from "@cloudx/shared";
import type { ConfigService } from "../configService.js";
import {
  ForgeCredentials,
  validateRepository,
  type ForgeCredential,
} from "./providers/ForgeCredentials.js";
import { createForgeProvider } from "./providers/index.js";
import type { ForgeProvider } from "./providers/ForgeProvider.js";
import type { ForgeSettings } from "./ForgeWorkflowService.js";

export class ForgeSettingsService {
  constructor(private readonly config: ConfigService) {}
  settings(): ForgeSettings {
    const values = this.config.getPluginConfig("forge");
    const required = (key: string) => {
      const value = values[key];
      if (typeof value !== "string" || !value.trim())
        throw new Error(`Configure ${key} in Forge Workers settings.`);
      return value.trim();
    };
    const provider = required("provider");
    if (provider !== "github" && provider !== "gitlab")
      throw new Error("Select GitHub or GitLab in Forge Workers settings.");
    const repository: ForgeRepository = {
      provider,
      apiUrl: required("apiUrl"),
      projectPath: required("projectPath"),
    };
    validateRepository(repository);
    this.credential("worker");
    this.credential("reviewer");
    return {
      repository,
      repositoryPath: required("repositoryPath"),
      baseBranch: required("baseBranch"),
      workerTemplateId: required("workerTemplateId"),
      reviewTemplateId: required("reviewTemplateId"),
      maxRunMinutes: Number(values.maxRunMinutes),
    };
  }
  provider(
    repository: ForgeRepository,
    role: ForgeCredentialRole,
    signal?: AbortSignal,
  ): ForgeProvider {
    const current = this.settings().repository;
    if (
      current.provider !== repository.provider ||
      current.apiUrl !== repository.apiUrl ||
      current.projectPath !== repository.projectPath
    )
      throw new Error(
        "This worker belongs to a different repository. Restore its repository settings before continuing.",
      );
    return createForgeProvider(
      repository,
      new ForgeCredentials(repository, async (requestedRole) =>
        this.credential(requestedRole),
      ),
      { role, signal },
    );
  }
  private credential(role: ForgeCredentialRole): ForgeCredential {
    const values = this.config.getPluginConfig("forge");
    const kind = values[`${role}CredentialKind`];
    const secret = (key: string) => {
      const value = this.config.getPluginSecret("forge", key);
      if (!value)
        throw new Error(
          `Configure ${role} application credentials in Forge Workers settings.`,
        );
      return value;
    };
    if (kind === "github-app") {
      const appId = values[`${role}AppId`];
      const installationId = values[`${role}InstallationId`];
      if (
        typeof appId !== "string" ||
        !appId.trim() ||
        typeof installationId !== "string" ||
        !installationId.trim()
      )
        throw new Error(
          `Configure the ${role} GitHub App and installation IDs.`,
        );
      return {
        kind,
        appId,
        installationId,
        privateKey: secret(`${role}PrivateKey`),
      };
    }
    if (kind === "token" || kind === "gitlab-oauth")
      return { kind, token: secret(`${role}Token`) };
    throw new Error(
      `Select a ${role} credential type in Forge Workers settings.`,
    );
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
      key: "repositoryPath",
      label: "Local repository path",
      type: "string",
      defaultValue: "",
      description:
        "An existing local Git repository with origin configured and authenticated for fetch/push. Its parent directory must be an allowed CloudX root.",
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
  for (const role of ["worker", "reviewer"] as const) {
    const title = role === "worker" ? "Issue worker" : "Reviewer";
    fields.push(
      {
        key: `${role}CredentialKind`,
        label: `${title} credential type`,
        type: "select",
        defaultValue: "token",
        options: [
          { label: "Bot / access token", value: "token" },
          { label: "GitHub App installation", value: "github-app" },
          { label: "GitLab OAuth application token", value: "gitlab-oauth" },
        ],
      },
      {
        key: `${role}Token`,
        label: `${title} access token`,
        type: "secret",
        defaultValue: "",
        description:
          "Use a separate application or bot identity for reviews. GitLab needs api scope; GitHub needs issues, pull requests and repository contents permissions appropriate to this role.",
      },
      {
        key: `${role}AppId`,
        label: `${title} GitHub App client ID`,
        type: "string",
        defaultValue: "",
      },
      {
        key: `${role}InstallationId`,
        label: `${title} GitHub installation ID`,
        type: "string",
        defaultValue: "",
      },
      {
        key: `${role}PrivateKey`,
        label: `${title} GitHub App private key (PEM)`,
        type: "secret",
        acceptFile: ".pem,.key",
        defaultValue: "",
        description: "Import the private key file to preserve its PEM formatting. Maximum 64 KB.",
      },
    );
  }
  return fields;
}
