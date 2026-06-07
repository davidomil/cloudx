import type { CreatePluginSessionInput, HookCallContext, HookDefinition, JsonSchemaLike, PluginRuleContribution, PluginSession, PluginSessionSnapshot, PluginSkillContribution, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { ConfigFieldDescriptor, WorkspaceTab } from "@cloudx/shared";

import type { DocumentationClient } from "../documentation/DocumentationClient.js";
import { DocumentationIngestQueue, type DocumentationIngestJobSnapshot, type DocumentationIngestQueueOperationContext } from "../documentation/DocumentationIngestQueue.js";
import {
  DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
  DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
  DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
  DOCUMENTATION_AI_ANSWER_MODEL_KEY,
  DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY,
  DOCUMENTATION_AI_MODEL_OPTIONS,
  DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY,
  DOCUMENTATION_AI_USE_VOICE_MODEL,
  DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY,
  DOCUMENTATION_PLUGIN_ID,
  type DocumentationEnrichmentService
} from "../documentation/DocumentationEnrichmentService.js";
import type { PathPolicy } from "../pathPolicy.js";

export class DocumentationPlugin implements WorkspacePlugin {
  readonly id = DOCUMENTATION_PLUGIN_ID;
  readonly acronym = "DOC";
  readonly displayName = "Documentation";
  readonly description = "Stores, searches, and invalidates portable local knowledge archives.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly configFields: ConfigFieldDescriptor[] = [
    {
      key: DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
      label: "AI enrichment",
      type: "boolean",
      description: "Use the configured CloudX AI model to improve documentation imports after the source extraction completes.",
      defaultValue: true
    },
    {
      key: DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY,
      label: "Image analysis model",
      type: "select",
      description: "Model used for visual, image, table, graph, and keyframe enrichment. Defaults to the cheapest Codex image-capable model from current OpenAI docs.",
      defaultValue: DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
      options: DOCUMENTATION_AI_MODEL_OPTIONS
    },
    {
      key: DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY,
      label: "Text enrichment model",
      type: "select",
      description: "Model used for non-visual documentation enrichment such as metadata and text-only imports.",
      defaultValue: DOCUMENTATION_AI_USE_VOICE_MODEL,
      options: DOCUMENTATION_AI_MODEL_OPTIONS
    },
    {
      key: DOCUMENTATION_AI_ANSWER_MODEL_KEY,
      label: "Assisted answer model",
      type: "select",
      description: "Model used when the Documentation panel synthesizes source-grounded answers.",
      defaultValue: DOCUMENTATION_AI_USE_VOICE_MODEL,
      options: DOCUMENTATION_AI_MODEL_OPTIONS
    },
    {
      key: DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY,
      label: "AI enrichment skills",
      type: "string",
      description: "Comma-separated CloudX skill ids that define how imported documentation should be improved.",
      visibility: "internal",
      defaultValue: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS.join(",")
    }
  ];
  readonly adoptUserRuleContributionIds = ["documentation-ingest-evidence"];
  readonly adoptUserSkillContributionIds = [
    "documentation-search",
    "documentation-ingest",
    "documentation-invalidate",
    "documentation-archive-control"
  ];
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
    private readonly pathPolicy: PathPolicy,
    private readonly ingestQueue: DocumentationIngestQueue,
    private readonly enrichmentProvider: () => DocumentationEnrichmentService | undefined = () => undefined
  ) {
    this.hooks = [
      readHook("documentation.health", "Documentation Health", "Return documentation indexer health.", () => this.client.health()),
      readHook("documentation.stats", "Documentation Stats", "Return archive counts and portable paths.", () => this.client.stats()),
      readHook("documentation.ingest.queue", "Documentation Ingest Queue", "Return queued, running, and recent documentation ingest jobs.", () => this.ingestQueue.list()),
      writeHook("documentation.ingest.queue.clearFinished", "Clear Documentation Ingest Queue", "Remove completed and failed documentation ingest jobs from the queue view.", () => this.ingestQueue.clearFinished()),
      readHook("documentation.portableManifest", "Documentation Portable Manifest", "Return files that make up the portable archive.", () => this.client.portableManifest()),
      readHook("documentation.documents.list", "List Documentation", "List documentation records.", (input) => this.client.listDocuments(input), {
        states: { type: "array", items: { type: "string" } }
      }),
      readHook("documentation.documents.get", "Get Documentation", "Fetch one documentation record with chunks and events.", (input) => this.client.getDocument(input), {
        documentId: { type: "string" },
        chunkOffset: { type: "number" },
        chunkLimit: { type: "number" },
        chunkTextMaxChars: { type: "number" },
        artifactOffset: { type: "number" },
        artifactLimit: { type: "number" }
      }, ["documentId"]),
      readHook("documentation.search", "Search Documentation", "Search active local documentation and return source-grounded results.", (input) => this.client.search(input), {
        query: { type: "string" },
        limit: { type: "number" },
        states: { type: "array", items: { type: "string" } },
        sourceTypes: { type: "array", items: { type: "string" } },
        collection: { type: "string" },
        mode: { type: "string", enum: ["hybrid", "dense", "lexical"] }
      }, ["query"], ["plugin", "ui", "http", "automation", "voice"]),
      readHook("documentation.answer", "Answer Documentation Question", "Use AI assistance to answer a question from source-grounded documentation search results.", (input) => {
        const service = this.enrichmentProvider();
        if (!service) {
          throw new Error("Documentation AI assistance is not available. Use documentation.search for manual source-text search.");
        }
        return service.answerQuestion(input);
      }, {
        question: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        states: { type: "array", items: { type: "string" } },
        sourceTypes: { type: "array", items: { type: "string" } },
        collection: { type: "string" },
        mode: { type: "string", enum: ["hybrid", "dense", "lexical"] }
      }, ["question"], ["ui", "http"]),
      writeHook("documentation.ingest.path", "Ingest Documentation Path", "Ingest a local file or directory under configured allowed roots.", async (input, context) => {
        const path = this.pathPolicy.resolve(requireString(input.path, "path"));
        return this.enqueueIngest("path", titleOrFallback(input.title, path), path, "Reading local path and extracting source evidence.", async (job) => {
          job.update({ progress: 35, stage: "Indexer is reading the local path and extracting source evidence." });
          return this.enrichQueued(await this.client.ingestPath({ ...input, path }), job);
        }, context);
      }, {
        path: { type: "string" },
        title: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }, ["path"]),
      externalHook("documentation.ingest.url", "Ingest Documentation URL", "Download a URL source, ingest a YouTube video with transcript and keyframes, or ingest every video in a YouTube playlist.", async (input, context) => this.enqueueIngest("url", titleOrFallback(input.title, requireString(input.url, "url")), requireString(input.url, "url"), "Downloading URL and extracting source evidence.", async (job) => {
        job.update({ progress: 30, stage: urlIngestStage(requireString(input.url, "url")) });
        return this.enrichQueued(await this.client.ingestUrl(input), job);
      }, context), {
        url: { type: "string" },
        title: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        transcript: { type: "string" }
      }, ["url"]),
      writeHook("documentation.ingest.text", "Ingest Documentation Text", "Ingest direct text, transcript, or copied source material.", async (input, context) => this.enqueueIngest("text", titleOrFallback(input.title, "Text source"), optionalString(input.uri) ?? "direct text", "Writing text into the archive.", async (job) => {
        job.update({ progress: 35, stage: "Indexer is writing text into the archive." });
        return this.enrichQueued(await this.client.ingestText(input), job);
      }, context), {
        title: { type: "string" },
        text: { type: "string" },
        uri: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }, ["text"]),
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

  private enrich(response: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown> {
    return this.enrichmentProvider()?.enrichIngestResponse(response) ?? response;
  }

  private enqueueIngest(
    kind: "path" | "url" | "text",
    label: string,
    detail: string,
    runningStage: string,
    operation: (context: DocumentationIngestQueueOperationContext) => Promise<Record<string, unknown>>,
    hookContext?: HookCallContext
  ): Promise<Record<string, unknown>> {
    return this.ingestQueue.enqueue({
      kind,
      label,
      detail,
      runningStage,
      operation
    }, hookContext?.reportProgress ? (snapshot) => hookContext.reportProgress?.(hookProgress(snapshot)) : undefined);
  }

  private async enrichQueued(response: Record<string, unknown>, job: DocumentationIngestQueueOperationContext): Promise<Record<string, unknown>> {
    job.update({ progress: 78, stage: "Running AI enrichment for the imported documentation." });
    const enriched = await this.enrich(response);
    job.update({ progress: 92, stage: "Finalizing documentation import." });
    return enriched;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function titleOrFallback(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function urlIngestStage(url: string): string {
  return /(?:youtube\.com|youtu\.be)/iu.test(url)
    ? "Fetching media metadata, transcript, keyframes, and enrichment evidence."
    : "Downloading URL and extracting source evidence.";
}

function hookProgress(snapshot: DocumentationIngestJobSnapshot) {
  return {
    message: `${snapshot.label}: ${snapshot.stage}`,
    progress: snapshot.progress,
    stage: snapshot.stage,
    status: snapshot.status,
    jobId: snapshot.id,
    detail: snapshot.detail,
    position: snapshot.position
  };
}

function defaultDocumentationSkills(): PluginSkillContribution[] {
  return [
    {
      id: "documentation-search",
      name: "Documentation Search",
      description: "Mandatory local-first lookup for factual, research, recipe, troubleshooting, and source-grounded answer tasks; enrich the archive from reliable online sources when local evidence is missing.",
      instructions: skillInstructions("Search", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        "Before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded question, run local archive search first even when the question looks general or answerable from memory.",
        "Call `POST $CLOUDX_DOCUMENTATION_URL/search` with JSON containing `query`, `mode: \"hybrid\"`, optional `limit`, and optional filters. Use the user's exact topic as the first query, then broaden or narrow only after seeing local results.",
        "When Codex is answering the user, use this direct search path instead of `documentation.answer`; Codex should inspect sources itself rather than chaining through another AI answer pass.",
        "Open the strongest matching documents with `GET $CLOUDX_DOCUMENTATION_URL/documents/{documentId}` and read relevant chunks, transcripts, tables, descriptions, and artifact metadata before answering.",
        "Use only results whose `state` is `active` unless the user explicitly asks for stale, revoked, deleted, or audit history.",
        "If active local results are absent, weak, stale, or do not cover the user's question, use built-in web search before answering. Prefer official product/project documentation, vendor datasheets, standards/specs, peer-reviewed or government/institutional sources for high-stakes domains, and reputable news sources for current events. Avoid forum or blog claims unless they are explicitly requested or corroborated by stronger sources.",
        "Ingest reliable online sources that materially answer the question with `/ingest/url` whenever the source has a stable URL; use `/ingest/text` only for source text that cannot be downloaded directly. Preserve title, URI, source type, and collection metadata.",
        "After ingesting web sources, rerun local archive search and answer from the local documentation records. If no reliable source can be ingested, say so and answer only with the evidence that was actually inspected.",
        "When writing, carry forward each result's title, source type, locator, URI, and content SHA."
      ])
    },
    {
      id: "documentation-ingest",
      name: "Documentation Ingest",
      description: "Add uploaded files, local files, directories, websites, YouTube videos/playlists, copied text, or transcripts to the documentation archive.",
      instructions: skillInstructions("Ingest", [
        "Read `CLOUDX_SERVER_URL` and `CLOUDX_DOCUMENTATION_URL`. If both are missing, stop and explain that no documentation ingest endpoint is available.",
        "For Codex or automation ingest, prefer the CloudX server streaming hook when `CLOUDX_SERVER_URL` is set: call `POST $CLOUDX_SERVER_URL/api/hooks/documentation.ingest.url?stream=1`, `documentation.ingest.path?stream=1`, or `documentation.ingest.text?stream=1` with JSON `{ \"input\": ... }`; read NDJSON `progress` events until the final `result` or `error` event so the blocking call stays visibly alive and the plugin UI shows the queued job.",
        "Use `documentation.ingest.path` for local files or directories visible to the server, `documentation.ingest.url` for websites, URLs, YouTube videos, and YouTube playlists, and `documentation.ingest.text` for copied text or manual transcripts. Use direct `$CLOUDX_DOCUMENTATION_URL/ingest/*` endpoints only when `CLOUDX_SERVER_URL` is unavailable; direct indexer calls bypass the CloudX queue and streamed progress.",
        "Set `sourceType` to one of `datasheet`, `book`, `website`, `repo_code`, `readme`, `media`, `image`, or `text` when the user gives enough context.",
        "Leave `title` and `collection` blank when the indexer should autodetect them from the file, folder, URL, playlist, upload, or first text line.",
        "When ingesting sources found online, prefer durable primary URLs and include the original source URL. Do not ingest search-result pages, low-trust mirrors, or unsupported summaries when a better source is available.",
        "When AI enrichment is disabled, only source text and extracted artifact metadata are immediately searchable. Do manual follow-up by searching, opening full documents, reading transcript chunks or table artifacts, and writing source-grounded notes yourself.",
        "Do not ingest outdated or untrusted material silently. Preserve precise source URI metadata whenever the user provides it."
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
      id: "documentation-enrich-metadata",
      name: "Documentation Enrich Metadata",
      description: "Derive source-grounded metadata and searchable import-improvement notes for newly ingested documentation.",
      instructions: skillInstructions("Enrich Metadata", [
        "Read the provided document title, URI, source type, collection, chunks, and artifact manifest before producing output.",
        "Identify source-grounded title, collection, tags, product names, versions, dates, authors, and section names that the importer may not have captured.",
        "Write concise derived spans using locators that start with `ai:metadata`; include only facts visible in the evidence.",
        "When metadata is ambiguous or absent, put the uncertainty in `warnings` instead of inventing a value."
      ])
    },
    {
      id: "documentation-enrich-visuals",
      name: "Documentation Enrich Visuals",
      description: "Improve imports by describing extracted tables, graphs, diagrams, screenshots, and flowcharts.",
      instructions: skillInstructions("Enrich Visuals", [
        "Use extracted table files, figure indexes, image metadata, keyframe paths, and surrounding chunks as the visual evidence.",
        "Describe tables, graphs, flowcharts, block diagrams, screenshots, and visible labels in short searchable spans with locators that start with `ai:visual`.",
        "Call out where the current extraction looks incomplete, such as cropped figures, missing axis labels, unreadable callouts, or tables that need manual review.",
        "Do not infer visual details unless they are present in artifact previews, filenames, nearby text, or keyframe evidence."
      ])
    },
    {
      id: "documentation-enrich-media",
      name: "Documentation Enrich Media",
      description: "Improve media imports using transcripts and interval keyframes when they are available.",
      instructions: skillInstructions("Enrich Media", [
        "Use transcript text, ASR transcript evidence, and one-frame-per-second keyframe offsets to identify meaningful sections in videos or audio.",
        "Write derived spans with locators that start with `ai:media`; include section titles, timestamps or offsets when evidence supports them, and searchable details that the transcript alone may miss.",
        "When a YouTube playlist import contains separate documents, enrich each document independently using only that document's evidence.",
        "Report missing audio, missing keyframes, low-confidence transcript language, or insufficient visual evidence in `warnings`."
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
      text: "Before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded user question, query `POST $CLOUDX_DOCUMENTATION_URL/search` against the active CloudX documentation archive first and prefer local source-grounded evidence even when the topic seems general; if active local documentation is absent, stale, or insufficient, use reliable online sources, prioritizing official documentation, vendor/source material, standards/specs, peer-reviewed or government/institutional sources for high-stakes domains, and reputable news for current events, then add each useful online source back into the CloudX documentation knowledge base before relying on it when ingestion is possible, preserve precise title and URI metadata, rerun local search after ingestion, and invalidate older conflicting archive records."
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
    "Use `curl -sS` with `-H 'content-type: application/json'` for JSON POST endpoints. For streaming CloudX server hook calls, use `curl -k -N -sS -H 'content-type: application/json' -H 'accept: application/x-ndjson'`. For direct fallback `/ingest/upload` calls, use multipart form fields such as `curl -sS -F file=@source.pdf -F sourceType=datasheet \"$CLOUDX_DOCUMENTATION_URL/ingest/upload\"`. Keep JSON compact and quote user text safely."
  ].join("\n");
}
