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
import { DOCUMENTATION_HELPER_FILES, DOCUMENTATION_HELPER_SCRIPT_PATH } from "./documentationSkillHelpers.js";

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
        const cwd = optionalString(input.cwd);
        const path = this.pathPolicy.resolve(requireString(input.path, "path"), cwd ? { relativeBaseDir: this.pathPolicy.resolve(cwd) } : undefined);
        const { cwd: _cwd, ...clientInput } = input;
        return this.enqueueIngest("path", titleOrFallback(input.title, path), path, "Reading local path and extracting source evidence.", async (job) => {
          job.update({ progress: 35, stage: "Indexer is reading the local path and extracting source evidence." });
          return this.enrichQueued(await this.client.ingestPath({ ...clientInput, path }), job);
        }, context);
      }, {
        path: { type: "string" },
        cwd: { type: "string" },
        title: { type: "string" },
        sourceType: { type: "string" },
        collection: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }, ["path"]),
      externalHook("documentation.ingest.url", "Ingest Documentation URL", "Download a URL source, ingest a YouTube video with transcript and keyframes, or ingest every video in a YouTube playlist.", async (input, context) => this.enqueueIngest("url", titleOrFallback(input.title, requireString(input.url, "url")), requireString(input.url, "url"), "Downloading URL and extracting source evidence.", async (job) => {
        job.update({ progress: 30, stage: urlIngestStage(requireString(input.url, "url")) });
        return this.enrichQueued(await this.client.ingestUrl(input, {
          onProgress: (event) => job.update({
            progress: typeof event.progress === "number" ? Math.max(30, Math.min(76, event.progress)) : undefined,
            stage: event.stage,
            etaSeconds: event.etaSeconds,
            metrics: event.metrics,
            ...progressChannelPatch(event)
          })
        }), job);
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
    position: snapshot.position,
    etaSeconds: snapshot.etaSeconds,
    metrics: snapshot.metrics,
    progressChannels: snapshot.progressChannels
  };
}

function progressChannelPatch(event: { stage?: string; channel?: string; channelLabel?: string; channelProgress?: number }) {
  const explicitId = optionalString(event.channel);
  const explicitLabel = optionalString(event.channelLabel);
  const parsed = progressChannelFromStage(event.stage);
  if (explicitId) {
    const normalizedExplicitId = progressChannelId(explicitId);
    return {
      channelId: explicitId,
      channelLabel: explicitLabel ?? parsed?.label ?? explicitId,
      channelStage: parsed && parsed.id === normalizedExplicitId ? parsed.stage : event.stage,
      channelProgress: event.channelProgress
    };
  }
  return parsed ? { channelId: parsed.id, channelLabel: parsed.label, channelStage: parsed.stage, channelProgress: event.channelProgress } : {};
}

function progressChannelFromStage(stage: string | undefined): { id: string; label: string; stage: string } | undefined {
  const match = /^([^:]{2,32}):\s*(.+)$/u.exec(stage ?? "");
  if (!match) {
    return undefined;
  }
  const label = match[1]!.trim();
  const id = progressChannelId(label);
  return id ? { id, label, stage: match[2]!.trim() } : undefined;
}

function progressChannelId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function defaultDocumentationSkills(): PluginSkillContribution[] {
  return [
    {
      id: "documentation-search",
      name: "Documentation Search",
      description: "Mandatory local-first lookup for factual, research, recipe, troubleshooting, and source-grounded answer tasks; enrich the archive from reliable online sources when local evidence is missing.",
      instructions: skillInstructions("Search", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        `Use the bundled helper to keep commands short: \`DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-search/${DOCUMENTATION_HELPER_SCRIPT_PATH}"\`; then run \`node "$DOC" search "query"\`, \`node "$DOC" open DOCUMENT_ID\`, or \`node "$DOC" ingest-url URL\`.`,
        "Before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded question, run local archive search first even when the question looks general or answerable from memory.",
        "Use the user's exact topic as the first helper search query, then broaden or narrow only after seeing local results.",
        "When Codex is answering the user, use this direct search path instead of `documentation.answer`; Codex should inspect sources itself rather than chaining through another AI answer pass.",
        "Open the strongest matching documents with the helper and read relevant chunks, transcripts, tables, descriptions, and artifact metadata before answering.",
        "Use only results whose `state` is `active` unless the user explicitly asks for stale, revoked, deleted, or audit history.",
        "If active local results are absent, weak, stale, or do not cover the user's question, use built-in web search before answering. Prefer official product/project documentation, vendor datasheets, standards/specs, peer-reviewed or government/institutional sources for high-stakes domains, and reputable news sources for current events. Avoid forum or blog claims unless they are explicitly requested or corroborated by stronger sources.",
        "When adding evidence, ingest the original file, PDF, image, URL, YouTube video, or playlist through the ingest skill so the full extractor can capture text, tables, figures, screenshots, transcripts, and keyframes; use `/ingest/text` only when no original source is available. Preserve title, URI, source type, and collection metadata.",
        "After ingesting web sources, rerun local archive search and answer from the local documentation records. If no reliable source can be ingested, say so and answer only with the evidence that was actually inspected.",
        "When writing, carry forward each result's title, source type, locator, URI, and content SHA."
      ]),
      files: DOCUMENTATION_HELPER_FILES
    },
    {
      id: "documentation-ingest",
      name: "Documentation Ingest",
      description: "Add uploaded files, local files, directories, websites, YouTube videos/playlists, copied text, or transcripts to the documentation archive.",
      instructions: skillInstructions("Ingest", [
        "Read `CLOUDX_SERVER_URL` and `CLOUDX_DOCUMENTATION_URL`. If both are missing, stop and explain that no documentation ingest endpoint is available.",
        `Use the bundled helper to keep commands short: \`DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-ingest/${DOCUMENTATION_HELPER_SCRIPT_PATH}"\`; then run \`node "$DOC" ingest-url URL\`, \`node "$DOC" ingest-path PATH\`, \`node "$DOC" ingest-text "text"\`, \`node "$DOC" search "query"\`, or \`node "$DOC" open DOCUMENT_ID\`.`,
        "Use `ingest-path` for local files or directories visible to the server, `ingest-url` for websites, URLs, YouTube videos, and YouTube playlists, and `ingest-text` only for copied text that has no retrievable original source.",
        "The helper uses the CloudX streaming hook when `CLOUDX_SERVER_URL` is set, so keep the command running until progress ends with a final result or error.",
        "When ingesting a relative local path, run the helper from the intended workspace with `CLOUDX_SERVER_URL` set. If only `CLOUDX_DOCUMENTATION_URL` is available, pass an absolute path.",
        "Always ingest PDFs, images, documents, YouTube videos, and YouTube playlists as original sources, not pasted excerpts or transcripts, so the extractor can preserve pages, tables, figures, screenshots, visual keyframes, timestamps, and source artifacts.",
        "Set `sourceType` to one of `datasheet`, `book`, `website`, `repo_code`, `readme`, `media`, `image`, or `text` when the user gives enough context.",
        "Leave `title` and `collection` blank when the indexer should autodetect them from the file, folder, URL, playlist, upload, or first text line.",
        "When ingesting sources found online, prefer durable primary URLs and include the original source URL. Do not ingest search-result pages, low-trust mirrors, or unsupported summaries when a better source is available.",
        "When AI enrichment is disabled, only source text and extracted artifact metadata are immediately searchable. Do manual follow-up by searching, opening full documents, reading transcript chunks or table artifacts, and writing source-grounded notes yourself.",
        "Do not ingest outdated or untrusted material silently. Preserve precise source URI metadata whenever the user provides it."
      ]),
      files: DOCUMENTATION_HELPER_FILES
    },
    {
      id: "documentation-invalidate",
      name: "Documentation Invalidate",
      description: "Invalidate outdated or wrong documentation in the local archive.",
      instructions: skillInstructions("Invalidate", [
        "Read `CLOUDX_DOCUMENTATION_URL`. If it is missing, stop and explain that the documentation indexer URL is not available.",
        `Use the bundled helper to keep commands short: \`DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-invalidate/${DOCUMENTATION_HELPER_SCRIPT_PATH}"\`; then run \`node "$DOC" search "query"\`, \`node "$DOC" open DOCUMENT_ID\`, or \`node "$DOC" invalidate DOCUMENT_ID stale --reason "reason"\`.`,
        "Find and open the target document before invalidating it.",
        "Invalidate with a concrete reason.",
        "Use `stale` for outdated sources, `revoked` for wrong sources, `superseded` for replaced revisions, `quarantined` for trust or extraction concerns, and `deleted` for removal."
      ]),
      files: DOCUMENTATION_HELPER_FILES
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
        "For video keyframes, use the timestamped `media keyframe ...` chunk, keyframe artifact path, and nearby transcript context to write one concise visual span per meaningful frame.",
        "Keep each video-frame span grounded to that frame's timestamp and visible image evidence; do not collapse all frames into one generic video summary.",
        "Call out where the current extraction looks incomplete, such as cropped figures, missing axis labels, unreadable callouts, or tables that need manual review.",
        "Do not infer visual details unless they are present in artifact previews, filenames, nearby text, or keyframe evidence."
      ])
    },
    {
      id: "documentation-enrich-media",
      name: "Documentation Enrich Media",
      description: "Improve media imports using transcripts and selected visual keyframes when they are available.",
      instructions: skillInstructions("Enrich Media", [
        "Use transcript text, ASR transcript evidence, and timestamped selected slide or keyframe offsets to identify meaningful sections in videos or audio.",
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
        `Use the bundled helper to keep commands short: \`DOC="$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-archive-control/${DOCUMENTATION_HELPER_SCRIPT_PATH}"\`; then run \`node "$DOC" health\`, \`node "$DOC" stats\`, \`node "$DOC" manifest\`, \`node "$DOC" list\`, or \`node "$DOC" rebuild\`.`,
        "Use health, stats, and manifest output to inspect archive state before advising backup or restore work.",
        "The portable archive is the complete directory reported by `/health.archiveRoot`; back it up as a directory after stopping writes.",
        "Run rebuild after restoring an archive or changing active documentation state."
      ]),
      files: DOCUMENTATION_HELPER_FILES
    }
  ];
}

function defaultDocumentationRules(): PluginRuleContribution[] {
  return [
    {
      id: "documentation-ingest-evidence",
      description: "Capture task evidence in the local documentation archive before relying on it.",
      text: "Before answering source-grounded questions, search active records in the local CloudX documentation archive first. When adding evidence from a file, PDF, image, URL, YouTube video, or playlist, ingest the original source through the documentation ingest hooks so the full extractor runs; use text ingest only when no original source is available, then rerun search and answer from the archive."
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
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n");
}
