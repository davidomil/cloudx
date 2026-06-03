import type { CreatePluginSessionInput, HookDefinition, JsonSchemaLike, PluginRuleContribution, PluginSession, PluginSessionSnapshot, PluginSkillContribution, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import type { DocumentationClient } from "../documentation/DocumentationClient.js";
import type { PathPolicy } from "../pathPolicy.js";

export const DOCUMENTATION_PLUGIN_ID = "documentation";

export class DocumentationPlugin implements WorkspacePlugin {
  readonly id = DOCUMENTATION_PLUGIN_ID;
  readonly acronym = "DOC";
  readonly displayName = "Documentation";
  readonly description = "Stores, searches, and invalidates portable local knowledge archives.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly configFields = [];
  readonly ruleContributions = defaultDocumentationRules();
  readonly skillContributions = defaultDocumentationSkills();
  readonly hooks: HookDefinition[];
  readonly uiContributions = [
    {
      id: "documentation.panel",
      owner: { kind: "plugin" as const, pluginId: DOCUMENTATION_PLUGIN_ID },
      slot: "plugin.panel" as const,
      renderer: "documentation.panel" as const,
      title: "Documentation Archive",
      targetPluginId: DOCUMENTATION_PLUGIN_ID
    }
  ];

  constructor(
    private readonly client: DocumentationClient,
    private readonly pathPolicy: PathPolicy
  ) {
    this.hooks = [
      readHook("documentation.health", "Documentation Health", "Return documentation indexer health.", () => this.client.health()),
      readHook("documentation.stats", "Documentation Stats", "Return archive counts and portable paths.", () => this.client.stats()),
      readHook("documentation.portableManifest", "Documentation Portable Manifest", "Return files that make up the portable archive.", () => this.client.portableManifest()),
      readHook("documentation.documents.list", "List Documentation", "List documentation records.", (input) => this.client.listDocuments(input), {
        states: { type: "array", items: { type: "string" } }
      }),
      readHook("documentation.documents.get", "Get Documentation", "Fetch one documentation record with chunks and events.", (input) => this.client.getDocument(input), {
        documentId: { type: "string" }
      }, ["documentId"]),
      readHook("documentation.search", "Search Documentation", "Search active local documentation and return source-grounded results.", (input) => this.client.search(input), {
        query: { type: "string" },
        limit: { type: "number" },
        states: { type: "array", items: { type: "string" } },
        sourceTypes: { type: "array", items: { type: "string" } },
        collection: { type: "string" },
        mode: { type: "string", enum: ["hybrid", "dense", "lexical"] }
      }, ["query"], ["plugin", "ui", "http", "automation", "voice"]),
      writeHook("documentation.ingest.path", "Ingest Documentation Path", "Ingest a local file or directory under configured allowed roots.", async (input) => {
        const path = this.pathPolicy.resolve(requireString(input.path, "path"));
        return this.client.ingestPath({ ...input, path });
      }, {
        path: { type: "string" },
        title: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }, ["path"]),
      externalHook("documentation.ingest.url", "Ingest Documentation URL", "Download or transcript-ingest a URL source.", (input) => this.client.ingestUrl(input), {
        url: { type: "string" },
        title: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        transcript: { type: "string" }
      }, ["url"]),
      writeHook("documentation.ingest.text", "Ingest Documentation Text", "Ingest direct text, transcript, or copied source material.", (input) => this.client.ingestText(input), {
        title: { type: "string" },
        text: { type: "string" },
        uri: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }, ["title", "text", "uri", "sourceType"]),
      writeHook("documentation.invalidate", "Invalidate Documentation", "Mark a document stale, revoked, superseded, quarantined, or deleted.", (input) => this.client.invalidate(input), {
        documentId: { type: "string" },
        state: { type: "string", enum: ["stale", "revoked", "superseded", "quarantined", "deleted"] },
        reason: { type: "string" }
      }, ["documentId", "state", "reason"]),
      writeHook("documentation.remove", "Remove Documentation", "Remove a document from default search by marking it deleted.", (input) => this.client.remove(input), {
        documentId: { type: "string" }
      }, ["documentId"]),
      writeHook("documentation.rebuildIndex", "Rebuild Documentation Index", "Rebuild the Turbovec index from active SQLite chunks.", () => this.client.rebuildIndex())
    ];
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: this.configFields,
      actions: this.actions,
      hooks: this.hooks,
      uiContributions: this.uiContributions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new DocumentationSession(input.tab);
  }
}

class DocumentationSession implements PluginSession {
  constructor(public readonly tab: WorkspaceTab) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status
    };
  }

  voiceContext(): PluginVoiceContext {
    return {
      kind: "documentation",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Documentation archive manager. Use documentation.search for read-only knowledge retrieval."
    };
  }

  handleAction(): Record<string, unknown> {
    throw new Error("Documentation actions are exposed as hooks.");
  }
}

function readHook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike> = {},
  required: string[] = [],
  exposures: HookDefinition["exposures"] = ["plugin", "ui", "http"]
): HookDefinition {
  return hook(id, title, description, execute, properties, required, exposures, "read");
}

function writeHook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike> = {},
  required: string[] = []
): HookDefinition {
  return hook(id, title, description, execute, properties, required, ["ui", "http", "automation"], "write");
}

function externalHook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike>,
  required: string[]
): HookDefinition {
  return hook(id, title, description, execute, properties, required, ["ui", "http", "automation"], "external");
}

function hook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike>,
  required: string[],
  exposures: HookDefinition["exposures"],
  automationSafety: HookDefinition["automationSafety"]
): HookDefinition {
  return {
    id,
    owner: { kind: "plugin", pluginId: DOCUMENTATION_PLUGIN_ID },
    title,
    description,
    exposures,
    automationSafety,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    execute
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function defaultDocumentationSkills(): PluginSkillContribution[] {
  return [
    {
      id: "documentation-search",
      name: "Documentation Search",
      description: "Search the local CloudX documentation archive and use active source-grounded results.",
      instructions: skillInstructions("Search", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        "Call `POST $CLOUDX_DOCUMENTATION_URL/search` with JSON containing `query`, optional `limit`, and optional filters.",
        "Use only results whose `state` is `active` unless the user explicitly asks for stale, revoked, deleted, or audit history.",
        "When writing, carry forward each result's title, source type, locator, URI, and content SHA."
      ])
    },
    {
      id: "documentation-ingest",
      name: "Documentation Ingest",
      description: "Add uploaded files, local files, directories, websites, copied text, or transcripts to the documentation archive.",
      instructions: skillInstructions("Ingest", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        "Use multipart `/ingest/upload` for file bytes, `/ingest/path` for local files or directories already visible to the indexer, `/ingest/url` for websites or URLs, and `/ingest/text` for copied text or video transcripts.",
        "Set `sourceType` to one of `datasheet`, `book`, `website`, `repo_code`, `readme`, `media`, `image`, or `text` when the user gives enough context.",
        "Do not ingest outdated or untrusted material silently. Mark the source title and URI precisely."
      ])
    },
    {
      id: "documentation-invalidate",
      name: "Documentation Invalidate",
      description: "Invalidate outdated or wrong documentation in the local archive.",
      instructions: skillInstructions("Invalidate", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        "Find the target document with `/search` or `/documents` before invalidating it.",
        "Call `/invalidate` with `documentId`, `state`, and a concrete `reason`.",
        "Use `stale` for outdated sources, `revoked` for wrong sources, `superseded` for replaced revisions, `quarantined` for trust or extraction concerns, and `deleted` for removal."
      ])
    },
    {
      id: "documentation-archive-control",
      name: "Documentation Archive Control",
      description: "Inspect portable archive health, backup manifest, and index rebuild status.",
      instructions: skillInstructions("Archive Control", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        "Use `/health`, `/stats`, and `/portable-manifest` to inspect archive state before advising backup or restore work.",
        "The portable archive is the complete directory reported by `/health.archiveRoot`; back it up as a directory after stopping writes.",
        "Use `/rebuild-index` after restoring an archive or changing active documentation state."
      ])
    }
  ];
}

function defaultDocumentationRules(): PluginRuleContribution[] {
  return [
    {
      id: "documentation-ingest-evidence",
      description: "Capture task evidence in the local documentation archive before relying on it.",
      text: "When task evidence such as datasheets, sample code, vendor documentation, screenshots, flowcharts, API references, or local notes is needed, download or otherwise capture the source and add it to the CloudX documentation knowledge base before relying on it; preserve precise title and URI metadata and invalidate older conflicting archive records."
    }
  ];
}

function skillInstructions(title: string, steps: string[]): string {
  return [
    `# Documentation ${title}`,
    "",
    `Use the CloudX documentation archive for ${title.toLowerCase()} tasks.`,
    "",
    "## Procedure",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Request Pattern",
    "",
    "Use `curl -sS` with `-H 'content-type: application/json'` for JSON POST endpoints. For `/ingest/upload`, use multipart form fields such as `curl -sS -F file=@source.pdf -F sourceType=datasheet \"$CLOUDX_DOCUMENTATION_URL/ingest/upload\"`. Keep JSON compact and quote user text safely."
  ].join("\n");
}
