import {
  descriptorFromPlugin,
  type CreatePluginSessionInput,
  type HookDefinition,
  type JsonSchemaLike,
  type WorkspacePlugin,
} from "@cloudx/plugin-api";
import type { ForgePlacement, ForgeRepository, ForgeReviewSubmission } from "@cloudx/shared";
import {
  forgeConfigFields,
  type ForgeSettingsService,
} from "../forge/ForgeSettingsService.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";
import { parseReview } from "../forge/ForgeWorkflowValidation.js";

export class ForgePlugin implements WorkspacePlugin {
  readonly id = "forge";
  readonly acronym = "FRG";
  readonly displayName = "Forge Workers";
  readonly description =
    "Resolve GitHub and GitLab issues with Codex workers and review pull or merge requests.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly configFields = forgeConfigFields();
  readonly uiContributions = [
    {
      id: "forge.panel",
      owner: { kind: "plugin" as const, pluginId: "forge" },
      slot: "plugin.panel" as const,
      renderer: "forge.panel",
      title: "Forge Workers",
      targetPluginId: "forge",
    },
  ];
  readonly hooks: HookDefinition[];
  constructor(
    private readonly service: () => {
      settings: ForgeSettingsService;
      workflow: ForgeWorkflowService;
    },
  ) {
    const number = { type: "integer", minimum: 1 } satisfies JsonSchemaLike;
    const id = {
      type: "string",
      minLength: 1,
      maxLength: 128,
    } satisfies JsonSchemaLike;
    const placement = { windowId: id, paneId: id };
    const draftId = { type: "string", maxLength: 36, pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$" } satisfies JsonSchemaLike;
    const repository = {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["github", "gitlab"] },
        apiUrl: { type: "string", minLength: 1, maxLength: 4096 },
        projectPath: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["provider", "apiUrl", "projectPath"],
      additionalProperties: false,
    } satisfies JsonSchemaLike;
    const list = {
      repository,
      filter: { type: "string", maxLength: 4096 },
      scope: { type: "string", enum: ["assigned_to_me", "created_by_me", "created_by_workers"] },
      page: { type: "integer", minimum: 1 },
      perPage: { type: "integer", minimum: 1, maximum: 100 },
    } satisfies Record<string, JsonSchemaLike>;
    const event = {
      type: "string",
      enum: ["comment", "approve", "request_changes"],
    } satisfies JsonSchemaLike;
    this.hooks = [
      hook("dashboard", "Worker dashboard", "read", {}, [], async () => ({
        ...(await this.service().workflow.dashboard()),
      })),
      hook("issues.list", "List issues", "read", list, ["repository"], async ({ repository, ...query }) => ({
        ...(await this.provider(repository as ForgeRepository).listIssues(query)),
      })),
      hook(
        "changes.list",
        "List pull or merge requests",
        "read",
        list,
        ["repository"],
        async ({ repository, ...query }) => ({
          ...(await this.provider(repository as ForgeRepository).listChangeRequests(query)),
        }),
      ),
      hook(
        "issue.get",
        "Read issue and comments",
        "read",
        { number, repository },
        ["number", "repository"],
        async (input) => ({
          issue: await this.provider(input.repository as ForgeRepository).getIssue(Number(input.number)),
        }),
      ),
      hook(
        "change.get",
        "Read change and discussions",
        "read",
        { number, repository },
        ["number", "repository"],
        async (input) => ({
          change: await this.provider(input.repository as ForgeRepository).getChangeRequest(Number(input.number)),
        }),
      ),
      hook(
        "issue.start",
        "Start issue worker",
        "external",
        { number, repository, autoReview: { type: "boolean" }, ...placement },
        ["number", "repository", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.startIssue(
            input.repository as ForgeRepository,
            Number(input.number),
            place(input),
            input.autoReview === true,
          ),
        }),
      ),
      hook(
        "review.start",
        "Start review worker",
        "external",
        { number, repository, autoPost: { type: "boolean" }, ...placement },
        ["number", "repository", "autoPost", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.startReview(
            input.repository as ForgeRepository,
            Number(input.number),
            Boolean(input.autoPost),
            place(input),
          ),
        }),
      ),
      hook(
        "worker.autoReview",
        "Set issue auto review",
        "external",
        { id, enabled: { type: "boolean" }, ...placement },
        ["id", "enabled", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.setAutoReview(String(input.id), input.enabled === true, place(input)),
        }),
      ),
      hook(
        "worker.pause",
        "Pause worker",
        "write",
        { id },
        ["id"],
        async (input) => ({
          worker: await this.service().workflow.pause(String(input.id)),
        }),
      ),
      hook(
        "worker.stop",
        "Stop worker",
        "write",
        { id },
        ["id"],
        async (input) => ({
          worker: await this.service().workflow.stop(String(input.id)),
        }),
      ),
      hook(
        "worker.resume",
        "Resume worker",
        "external",
        { id, ...placement },
        ["id", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.resume(
            String(input.id),
            place(input),
          ),
        }),
      ),
      hook(
        "worker.syncAndReview",
        "Sync worker branch and start a fresh review",
        "external",
        { id, ...placement },
        ["id", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.syncAndReview(String(input.id), place(input)),
        }),
      ),
      hook(
        "review.save",
        "Save review draft",
        "write",
        {
          id,
          draftId,
          body: { type: "string", maxLength: 100_000 },
          event,
          comments: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                body: { type: "string", minLength: 1, maxLength: 20_000 },
                path: { type: "string", maxLength: 4096 },
                oldPath: { type: "string", maxLength: 4096 },
                line: { type: "integer", minimum: 1 },
                side: { type: "string", enum: ["LEFT", "RIGHT"] },
              },
              required: ["body"],
              additionalProperties: false,
            },
          },
        },
        ["id", "draftId", "body", "event", "comments"],
        async (input) => {
          const { body, comments, event } = parseReview({
            ...input,
            headSha: "0".repeat(40),
          });
          return {
            worker: await this.service().workflow.saveReview(String(input.id), String(input.draftId), {
              body,
              comments,
              event,
            }),
          };
        },
      ),
      hook(
        "review.submit",
        "Submit saved review",
        "external",
        { id, draftId },
        ["id", "draftId"],
        async (input) => ({
          worker: await this.service().workflow.submitReview(String(input.id), String(input.draftId)),
        }),
      ),
      hook(
        "change.review",
        "Approve or request changes",
        "external",
        {
          number,
          repository,
          headSha: {
            type: "string",
            anyOf: [
              { pattern: "^[a-fA-F0-9]{40}$", maxLength: 40 },
              { pattern: "^[a-fA-F0-9]{64}$", maxLength: 64 },
            ],
          },
          event: { type: "string", enum: ["approve", "request_changes"] },
          body: { type: "string", maxLength: 100_000 },
        },
        ["number", "repository", "headSha", "event"],
        async (input) => {
          const provider = this.provider(input.repository as ForgeRepository);
          await this.service().workflow.markReview(
            input.repository as ForgeRepository,
            Number(input.number),
            String(input.headSha),
            input.event as "approve" | "request_changes",
            typeof input.body === "string"
              ? input.body
              : input.event === "approve"
                ? "Approved."
                : "Changes requested.",
          );
          return {
            change: await provider.getChangeRequest(
              Number(input.number),
            ),
          };
        },
      ),
    ];
  }
  descriptor() {
    return descriptorFromPlugin(this);
  }
  createSession(input: CreatePluginSessionInput) {
    return {
      tab: input.tab,
      snapshot: () => ({
        tabId: input.tab.id,
        pluginId: this.id,
        title: input.tab.title,
        cwd: input.cwd,
        status: "running" as const,
      }),
      voiceContext: () => ({
        kind: "forge",
        summary: "GitHub and GitLab issue workers and code reviews.",
        cwd: input.cwd,
      }),
      handleAction: () => {
        throw new Error("Use Forge Workers hooks.");
      },
    };
  }
  private provider(repository: ForgeRepository) {
    return this.service().settings.provider(repository, "worker");
  }
}
function place(input: Record<string, unknown>): ForgePlacement {
  return { windowId: String(input.windowId), paneId: String(input.paneId) };
}
function hook(
  name: string,
  title: string,
  safety: HookDefinition["automationSafety"],
  properties: Record<string, JsonSchemaLike>,
  required: string[],
  execute: HookDefinition["execute"],
): HookDefinition {
  return {
    id: `forge.${name}`,
    owner: { kind: "plugin", pluginId: "forge" },
    title,
    description: title,
    exposures: ["ui", "http"],
    automationSafety: safety,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    execute,
  };
}
