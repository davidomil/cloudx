import {
  descriptorFromPlugin,
  type CreatePluginSessionInput,
  type HookDefinition,
  type JsonSchemaLike,
  type WorkspacePlugin,
} from "@cloudx/plugin-api";
import type { ForgePlacement, ForgeReviewSubmission } from "@cloudx/shared";
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
    const list = {
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
      hook("issues.list", "List issues", "read", list, [], async (input) => ({
        ...(await this.provider().listIssues(input)),
      })),
      hook(
        "changes.list",
        "List pull or merge requests",
        "read",
        list,
        [],
        async (input) => ({
          ...(await this.provider().listChangeRequests(input)),
        }),
      ),
      hook(
        "issue.get",
        "Read issue and comments",
        "read",
        { number },
        ["number"],
        async (input) => ({
          issue: await this.provider().getIssue(Number(input.number)),
        }),
      ),
      hook(
        "change.get",
        "Read change and discussions",
        "read",
        { number },
        ["number"],
        async (input) => ({
          change: await this.provider().getChangeRequest(Number(input.number)),
        }),
      ),
      hook(
        "issue.start",
        "Start issue worker",
        "external",
        { number, ...placement },
        ["number", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.startIssue(
            Number(input.number),
            place(input),
          ),
        }),
      ),
      hook(
        "review.start",
        "Start review worker",
        "external",
        { number, autoPost: { type: "boolean" }, ...placement },
        ["number", "autoPost", "windowId", "paneId"],
        async (input) => ({
          worker: await this.service().workflow.startReview(
            Number(input.number),
            Boolean(input.autoPost),
            place(input),
          ),
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
        "review.save",
        "Save review draft",
        "write",
        {
          id,
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
        ["id", "body", "event", "comments"],
        async (input) => {
          const { body, comments, event } = parseReview({
            ...input,
            headSha: "0".repeat(40),
          });
          return {
            worker: await this.service().workflow.saveReview(String(input.id), {
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
        { id },
        ["id"],
        async (input) => ({
          worker: await this.service().workflow.submitReview(String(input.id)),
        }),
      ),
      hook(
        "change.review",
        "Approve or request changes",
        "external",
        {
          number,
          event: { type: "string", enum: ["approve", "request_changes"] },
          body: { type: "string", maxLength: 100_000 },
        },
        ["number", "event"],
        async (input) => {
          await this.service().workflow.markReview(
            Number(input.number),
            input.event as "approve" | "request_changes",
            typeof input.body === "string"
              ? input.body
              : input.event === "approve"
                ? "Approved."
                : "Changes requested.",
          );
          return {
            change: await this.provider().getChangeRequest(
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
  private provider() {
    const { settings } = this.service();
    return settings.provider(settings.settings().repository, "worker");
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
