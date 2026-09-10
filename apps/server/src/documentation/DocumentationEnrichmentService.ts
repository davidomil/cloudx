import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CloudxSkill, RulesSkillsStore } from "@cloudx/shared";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { runCodexExec } from "../voice/VoicePlanner.js";
import { DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL, DOCUMENTATION_AI_USE_VOICE_MODEL } from "../aiModelOptions.js";
import { DEFAULT_DOCUMENTATION_TIMEOUT_MS, type DocumentationClient } from "./DocumentationClient.js";

export const DOCUMENTATION_PLUGIN_ID = "documentation";
export const DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY = "aiEnrichmentEnabled";
export const DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY = "aiEnrichmentSkillIds";
export const DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY = "aiImageAnalysisModel";
export const DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY = "aiTextAnalysisModel";
export const DOCUMENTATION_AI_ANSWER_MODEL_KEY = "aiAnswerModel";
export { DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL, DOCUMENTATION_AI_MODEL_OPTIONS, DOCUMENTATION_AI_USE_VOICE_MODEL } from "../aiModelOptions.js";
export const DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS = [
  "documentation-enrich-metadata",
  "documentation-enrich-visuals",
  "documentation-enrich-media"
];

const ENRICHMENT_SCHEMA_PATH = fileURLToPath(new URL("./documentation-enrichment.schema.json", import.meta.url));
const ANSWER_SCHEMA_PATH = fileURLToPath(new URL("./documentation-answer.schema.json", import.meta.url));
const ENRICHMENT_BATCH_TARGET_CHARS = 60_000;
const ENRICHMENT_IMAGE_ATTACHMENT_BATCH_SIZE = 8;
const ENRICHMENT_DOCUMENT_CHUNK_PAGE_SIZE = 100;
const ENRICHMENT_DOCUMENT_ARTIFACT_PAGE_SIZE = 100;
const ENRICHMENT_CHUNK_TEXT_MAX_CHARS = 4_000;
const ANSWER_DOCUMENT_TARGET_CHARS = 40_000;
const ANSWER_EVIDENCE_TARGET_CHARS = 90_000;
const ANSWER_CHUNK_CONTEXT = 1;
const ANSWER_CHUNK_TEXT_MAX_CHARS = 4_000;
const MEDIA_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const MEDIA_TOOL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const MEDIA_TOOL_TERMINATION_GRACE_MS = 250;
const TRANSCRIPT_SEGMENT_TARGET_CHARS = 12_000;
const MEDIA_SCENE_KEYFRAME_FILTER = "fps=1,select='eq(n,0)+gt(scene,0.08)',showinfo,scale=960:-2:flags=fast_bilinear";

export interface DocumentationEnrichmentRunner {
  readonly model: string;
  run(prompt: string, options?: DocumentationRunnerOptions): Promise<unknown>;
}

export interface DocumentationRunnerOptions {
  schemaPath?: string;
  outputPrefix?: string;
  timeoutMs?: number;
  taskLabel?: string;
  model?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
}

export interface DocumentationEnrichmentRequestOptions {
  signal?: AbortSignal;
}

export interface DocumentationEnrichmentSource {
  filename?: string;
  content?: Buffer;
  contentPath?: string;
  contentType?: string;
  sourceType?: string;
}

interface ArchivedMediaSource extends DocumentationEnrichmentSource {
  contentPath: string;
  hasVideo: boolean;
}

type MediaProcessLauncher = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: ["ignore", "pipe", "pipe"] }
) => ReturnType<typeof spawn>;

export interface DocumentationEnrichmentOptions {
  client: DocumentationClient;
  config: ConfigService;
  rulesSkills: RulesSkillsCatalogService;
  runner: DocumentationEnrichmentRunner;
  asr?: AsrClient;
  mediaProcessLauncher?: MediaProcessLauncher;
  pluginContributionsReady?: () => Promise<RulesSkillsStore> | undefined;
}

export class CodexDocumentationEnrichmentRunner implements DocumentationEnrichmentRunner {
  constructor(
    readonly model: string,
    private readonly timeoutMs = DEFAULT_DOCUMENTATION_TIMEOUT_MS
  ) {}

  async run(prompt: string, options: DocumentationRunnerOptions = {}): Promise<unknown> {
    const model = options.model ?? this.model;
    return JSON.parse(
      await runCodexExec(model, prompt, {
        schemaPath: options.schemaPath ?? ENRICHMENT_SCHEMA_PATH,
        outputPrefix: options.outputPrefix ?? "cloudx-doc-enrich-",
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        taskLabel: options.taskLabel ?? "documentation enrichment",
        imagePaths: options.imagePaths,
        signal: options.signal
      })
    );
  }
}

export class DocumentationEnrichmentService {
  constructor(private readonly options: DocumentationEnrichmentOptions) {}

  isEnabled(): boolean {
    if (!this.options.config.isAiControlEnabled()) {
      return false;
    }
    return this.options.config.getPluginConfig(DOCUMENTATION_PLUGIN_ID)[DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY] === true;
  }

  async enrichIngestResponse(
    response: Record<string, unknown>,
    source: DocumentationEnrichmentSource = {},
    options: DocumentationEnrichmentRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    if (!this.isEnabled()) {
      return response;
    }
    const documents = uniqueDocuments(response);
    if (documents.length === 0) {
      return response;
    }
    const results = [];
    for (const document of documents) {
      try {
        results.push(await this.enrichDocument(document, source, options.signal));
      } catch (error) {
        if (options.signal?.aborted) {
          throw documentationAbortReason(options.signal);
        }
        results.push({
          documentId: document.documentId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { ...response, enrichment: { enabled: true, results } };
  }

  async answerQuestion(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      throw new Error("Documentation AI assistance is disabled. Manual search can inspect source text only.");
    }
    const model = this.configuredModel(DOCUMENTATION_AI_ANSWER_MODEL_KEY, this.options.runner.model);
    const question = requiredQuestion(input);
    const searchInput = answerSearchInput(input, question);
    const searchResponse = await this.options.client.search(searchInput);
    const results = recordsArray(searchResponse.results);
    if (results.length === 0) {
      return {
        answer: "No matching source material was found.",
        answerHtml: "<p>No matching source material was found.</p>",
        citations: [],
        warnings: ["No archive search results matched the question."],
        results,
        model
      };
    }
    const evidence = await this.answerEvidence(results);
    const output = normalizeAnswerOutput(
      await this.options.runner.run(buildAnswerPrompt(question, evidence), {
        schemaPath: ANSWER_SCHEMA_PATH,
        outputPrefix: "cloudx-doc-answer-",
        taskLabel: "documentation answer",
        model
      })
    );
    return { ...output, results, model };
  }

  private async enrichDocument(document: IngestedDocumentRef, source: DocumentationEnrichmentSource, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const skillIds = configuredSkillIds(this.options.config.getPluginConfig(DOCUMENTATION_PLUGIN_ID)[DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY]);
    const skills = await this.resolveSkills(skillIds, signal);
    const fullDocument = await this.enrichmentDocument(document.documentId, signal);
    const cleanup: Array<() => Promise<void>> = [];
    try {
      const archivedMedia = source.content || source.contentPath ? undefined : await this.archivedMediaSource(fullDocument, signal);
      const mediaEvidence = await this.prepareMediaEvidence(archivedMedia ?? source, cleanup, signal);
      if (archivedMedia && !mediaEvidence?.transcript?.trim() && !mediaEvidence?.keyframes.length) {
        throw new Error("Archived media enrichment produced no transcript or keyframe evidence.");
      }
      const evidence = {
        document: documentSummary(fullDocument),
        chunks: archivedMedia ? [] : documentChunks(fullDocument),
        artifacts: await this.documentArtifacts(fullDocument, signal),
        media: mediaEvidence
      };
      const model = this.enrichmentModel(skillIds, evidence);
      const batches = buildEvidenceBatches(evidence);
      const outputs = [];
      for (const batch of batches) {
        signal?.throwIfAborted();
        const imagePaths = batchImagePaths(batch);
        const runnerOptions = imagePaths.length > 0 ? { model, imagePaths } : { model };
        outputs.push(normalizeEnrichmentOutput(await this.options.runner.run(
          buildEnrichmentPrompt(skills, batch),
          signal ? { ...runnerOptions, signal } : runnerOptions
        )));
      }
      const output = mergeEnrichmentOutputs(outputs);
      if (output.spans.length === 0) {
        return {
          documentId: document.documentId,
          status: "skipped",
          reason: "Codex returned no enrichment spans.",
          warnings: output.warnings
        };
      }
      const enrichment = {
        documentId: document.documentId,
        spans: output.spans,
        model,
        skillIds,
        summary: output.summary,
        payload: {
          metadata: output.metadata,
          warnings: output.warnings,
          evidence: evidenceSummary(evidence, batches)
        }
      };
      if (signal) {
        await this.options.client.enrichDocument(enrichment, { signal });
      } else {
        await this.options.client.enrichDocument(enrichment);
      }
      return {
        documentId: document.documentId,
        status: "written",
        chunkCount: output.spans.length,
        warnings: output.warnings
      };
    } finally {
      await Promise.allSettled(cleanup.map((operation) => operation()));
    }
  }

  private async enrichmentDocument(documentId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let chunkOffset = 0;
    let artifactOffset = 0;
    let needsChunks = true;
    let needsArtifacts = true;
    let document: Record<string, unknown> | undefined;
    const chunks: Record<string, unknown>[] = [];
    const artifacts: Record<string, unknown>[] = [];
    while (!document || needsChunks || needsArtifacts) {
      signal?.throwIfAborted();
      const loadChunks = !document || needsChunks;
      const loadArtifacts = !document || needsArtifacts;
      const input = {
        documentId,
        chunkOffset: loadChunks ? chunkOffset : 0,
        chunkLimit: loadChunks ? ENRICHMENT_DOCUMENT_CHUNK_PAGE_SIZE : 0,
        chunkTextMaxChars: ENRICHMENT_CHUNK_TEXT_MAX_CHARS,
        artifactOffset: loadArtifacts ? artifactOffset : 0,
        artifactLimit: loadArtifacts ? ENRICHMENT_DOCUMENT_ARTIFACT_PAGE_SIZE : 0,
        includeEnrichments: false,
        includeEvents: false
      };
      const response = signal
        ? await this.options.client.getDocument(input, { signal })
        : await this.options.client.getDocument(input);
      const nextDocument = getRecord(response.document, "document");
      document ??= nextDocument;
      if (loadChunks) {
        const nextChunks = recordsArray(nextDocument.chunks);
        chunks.push(...nextChunks);
        needsChunks = windowHasMore(nextDocument.chunkWindow);
        if (needsChunks && nextChunks.length === 0) {
          throw new Error("Documentation enrichment chunk window did not advance.");
        }
        chunkOffset = nextWindowOffset(nextDocument.chunkWindow, chunkOffset, nextChunks.length);
      }
      if (loadArtifacts) {
        const nextArtifacts = recordsArray(nextDocument.artifacts);
        artifacts.push(...nextArtifacts);
        needsArtifacts = windowHasMore(nextDocument.artifactWindow);
        if (needsArtifacts && nextArtifacts.length === 0) {
          throw new Error("Documentation enrichment artifact window did not advance.");
        }
        artifactOffset = nextWindowOffset(nextDocument.artifactWindow, artifactOffset, nextArtifacts.length);
      }
    }
    if (!document) {
      throw new Error("Documentation enrichment could not load document details.");
    }
    return { ...document, chunks, artifacts, enrichments: [], events: [] };
  }

  private async resolveSkills(skillIds: string[], signal?: AbortSignal): Promise<CloudxSkill[]> {
    const store = await (this.options.pluginContributionsReady?.() ?? this.options.rulesSkills.list());
    signal?.throwIfAborted();
    const skills = new Map([...store.systemSkills, ...store.skills].map((skill) => [skill.id, skill]));
    return skillIds.map((skillId) => {
      const skill = skills.get(skillId);
      if (!skill?.instructions?.trim()) {
        throw new Error(`Documentation enrichment skill is not available: ${skillId}`);
      }
      return skill;
    });
  }

  private async answerEvidence(results: Record<string, unknown>[]): Promise<AnswerEvidence[]> {
    const evidence: AnswerEvidence[] = [];
    const documents = new Map<string, Record<string, unknown>>();
    const resultGroups = groupAnswerResults(results);
    let evidenceChars = 0;
    for (const [documentId, documentResults] of resultGroups) {
      const chunkIds = answerChunkIds(documentResults);
      if (chunkIds.length === 0) {
        continue;
      }
      let document = documents.get(documentId);
      if (!document) {
        document = getRecord((await this.options.client.getDocument({
          documentId,
          chunkIds,
          chunkContext: ANSWER_CHUNK_CONTEXT,
          chunkTextMaxChars: ANSWER_CHUNK_TEXT_MAX_CHARS,
          artifactLimit: 0,
          includeEnrichments: false,
          includeEvents: false
        })).document, "document");
        documents.set(documentId, document);
      }
      for (const chunk of selectAnswerChunks(recordsArray(document.chunks), documentResults)) {
        const nextChars = chunk.text.length + 400;
        if (evidence.length > 0 && evidenceChars + nextChars > ANSWER_EVIDENCE_TARGET_CHARS) {
          return evidence;
        }
        const result = documentResults.find((candidate) => candidate.chunkId === chunk.chunkId) ?? documentResults[0];
        evidence.push({
          result: {
            chunkId: chunk.chunkId,
            documentId,
            title: result?.title ?? "",
            sourceType: result?.sourceType ?? "",
            locator: chunk.locator,
            uri: result?.uri
          },
          text: chunk.text
        });
        evidenceChars += nextChars;
      }
    }
    return evidence.filter((item) => item.text.trim());
  }

  private async documentArtifacts(document: Record<string, unknown>, signal?: AbortSignal): Promise<ArtifactEvidence[]> {
    const availableArtifacts = availableArtifactRecords(document);
    const archiveRoot = await this.archiveRoot(signal);
    const snapshotPath = typeof document.snapshot_path === "string" ? document.snapshot_path : undefined;
    if (!archiveRoot || !snapshotPath) {
      if (availableArtifacts.length > 0) {
        throw new Error(sharedArtifactFilesystemMessage("archive root or snapshot path is missing"));
      }
      return [];
    }
    const root = path.resolve(archiveRoot);
    const snapshot = path.resolve(root, snapshotPath);
    if (!isSameOrChild(root, snapshot)) {
      if (availableArtifacts.length > 0) {
        throw new Error(sharedArtifactFilesystemMessage(`snapshot path escapes the archive root: ${snapshotPath}`));
      }
      return [];
    }
    const extracted = path.join(path.dirname(snapshot), "extracted");
    const structuredArtifacts = await documentArtifactEvidence(document, root, extracted);
    signal?.throwIfAborted();
    if (structuredArtifacts.length > 0) {
      return structuredArtifacts;
    }
    if (!fs.existsSync(extracted)) {
      if (availableArtifacts.length > 0) {
        throw new Error(sharedArtifactFilesystemMessage(`extracted artifact directory is missing for ${snapshotPath}`));
      }
      return [];
    }
    const paths = await listFiles(extracted, signal);
    const artifacts: ArtifactEvidence[] = [];
    for (const artifactPath of paths) {
      signal?.throwIfAborted();
      const relativePath = path.relative(root, artifactPath);
      const stat = await fsp.stat(artifactPath);
      artifacts.push({
        path: artifactPath,
        archivePath: relativePath,
        bytes: stat.size,
        kind: artifactKind(artifactPath)
      });
    }
    return artifacts;
  }

  private async archiveRoot(signal?: AbortSignal): Promise<string | undefined> {
    const health = signal ? await this.options.client.health({ signal }) : await this.options.client.health();
    return typeof health.archiveRoot === "string" ? health.archiveRoot : undefined;
  }

  private async archivedMediaSource(document: Record<string, unknown>, signal?: AbortSignal): Promise<ArchivedMediaSource | undefined> {
    const snapshotPath = optionalRecordString(document, "snapshot_path");
    const hasMediaSuffix = snapshotPath && /\.(mp3|wav|m4a|aac|ogg|webm|mp4|mov|mkv|avi)$/iu.test(snapshotPath);
    const sourceChunks = recordsArray(document.chunks).filter((chunk) => chunk.chunk_origin === "source");
    const retainsStructuredEvidence = sourceChunks.some((chunk) => chunk.locator !== "text");
    const hasTextChunks = sourceChunks.length > 0 && sourceChunks.every((chunk) => chunk.locator === "text");
    if (!snapshotPath || retainsStructuredEvidence) {
      return undefined;
    }
    const archiveRoot = await this.archiveRoot(signal);
    if (!archiveRoot) {
      throw new Error("Archived media enrichment requires a shared documentation archive root.");
    }
    const root = path.resolve(archiveRoot);
    const snapshot = path.resolve(root, snapshotPath);
    if (!isSameOrChild(root, snapshot)) {
      throw new Error("Archived media source escapes the documentation archive root.");
    }
    const metadataPath = path.join(path.dirname(snapshot), "metadata.json");
    if (metadataPath === snapshot) {
      return undefined;
    }
    const metadataStat = await fsp.lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!metadataStat && document.source_type === "media" && !path.extname(snapshotPath)) {
      throw new Error("Archived media source metadata is missing.");
    }
    let contentType: string | undefined;
    let retainsMediaUpload = false;
    if (metadataStat) {
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
        throw new Error("Archived source metadata must be a regular file inside its snapshot directory.");
      }
      const realMetadataPath = await fsp.realpath(metadataPath);
      if (!isSameOrChild(await fsp.realpath(root), realMetadataPath)) {
        throw new Error("Archived source metadata escapes the documentation archive root.");
      }
      const metadataBytes = await fsp.readFile(realMetadataPath);
      const metadataIsSource = createHash("sha256").update(metadataBytes).digest("hex") === document.content_sha256;
      if (!metadataIsSource) {
        const metadata = getRecord(JSON.parse(metadataBytes.toString("utf8")), "archived source metadata");
        if (metadata.contentType != null && typeof metadata.contentType !== "string") {
          throw new Error("Archived source content type must be a string.");
        }
        contentType = optionalRecordString(metadata, "contentType");
        retainsMediaUpload = document.source_type === "media"
          && document.uri === `upload://${path.basename(snapshotPath)}`;
      }
    }
    const hasMediaHint = Boolean(retainsMediaUpload || hasMediaSuffix || contentType && /^(audio|video)\//iu.test(contentType));
    if (!hasTextChunks && !hasMediaHint) {
      return undefined;
    }
    const realRoot = await fsp.realpath(root);
    const realSnapshot = await fsp.realpath(snapshot);
    if (!isSameOrChild(realRoot, realSnapshot)) {
      throw new Error("Archived media source escapes the documentation archive root.");
    }
    const stat = await fsp.lstat(snapshot);
    signal?.throwIfAborted();
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Archived media source must be a regular file.");
    }
    if (hasTextChunks && await isTextFile(realSnapshot, signal)) {
      return undefined;
    }
    const hasVideo = await containsVideoStream(realSnapshot, signal, this.options.mediaProcessLauncher);
    return { filename: path.basename(snapshotPath), contentPath: realSnapshot, contentType, sourceType: optionalRecordString(document, "source_type"), hasVideo };
  }

  private async prepareMediaEvidence(source: DocumentationEnrichmentSource | ArchivedMediaSource, cleanup: Array<() => Promise<void>>, signal?: AbortSignal): Promise<MediaEvidence | undefined> {
    signal?.throwIfAborted();
    if ((!source.content && !source.contentPath) || !("hasVideo" in source || isMediaSource(source))) {
      return undefined;
    }
    let mediaPath: string;
    let mediaWorkDir: string | undefined;
    const hasVideo = "hasVideo" in source ? source.hasVideo : isVideoSource(source);
    if (source.contentPath) {
      mediaPath = path.resolve(source.contentPath);
      const stat = await fsp.lstat(mediaPath);
      signal?.throwIfAborted();
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Documentation media source must be a regular spool file.");
      }
      if (hasVideo) {
        mediaWorkDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-media-"));
        cleanup.push(() => fsp.rm(mediaWorkDir!, { recursive: true, force: true }));
      }
    } else {
      mediaWorkDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-media-"));
      cleanup.push(() => fsp.rm(mediaWorkDir!, { recursive: true, force: true }));
      mediaPath = path.join(mediaWorkDir, safeMediaFilename(source.filename));
      await fsp.writeFile(mediaPath, source.content!);
      signal?.throwIfAborted();
    }
    if (!this.options.asr) {
      throw new Error("Documentation media enrichment requires the ASR service so uploaded audio/video is not indexed without transcript evidence.");
    }
    const filename = source.filename || "upload.media";
    const transcript = source.contentPath
      ? signal ? await this.options.asr.transcribeFile(mediaPath, filename, { signal }) : await this.options.asr.transcribeFile(mediaPath, filename)
      : signal ? await this.options.asr.transcribe(source.content!, filename, { signal }) : await this.options.asr.transcribe(source.content!, filename);
    const keyframes = hasVideo
      ? await captureSceneKeyframes(mediaPath, path.join(mediaWorkDir!, "frames"), signal, this.options.mediaProcessLauncher)
      : [];
    return {
      filename: source.filename,
      contentType: source.contentType,
      sourceType: source.sourceType,
      transcript: transcript?.text,
      transcriptSegments: transcript?.segments?.map((segment) => ({
        startSeconds: segment.start_seconds,
        endSeconds: segment.end_seconds,
        text: segment.text
      })),
      language: transcript?.language,
      languageProbability: transcript?.language_probability,
      keyframes
    };
  }

  private enrichmentModel(skillIds: string[], evidence: EnrichmentEvidence): string {
    const imageAnalysis = usesImageAnalysis(skillIds, evidence);
    return this.configuredModel(
      imageAnalysis ? DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY : DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY,
      imageAnalysis ? DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL : this.options.runner.model
    );
  }

  private configuredModel(key: string, defaultModel: string): string {
    const value = this.options.config.getPluginConfig(DOCUMENTATION_PLUGIN_ID)[key];
    if (typeof value !== "string" || value === DOCUMENTATION_AI_USE_VOICE_MODEL) {
      return value === DOCUMENTATION_AI_USE_VOICE_MODEL ? this.options.runner.model : defaultModel;
    }
    return value;
  }
}

interface IngestedDocumentRef {
  documentId: string;
}

interface ArtifactEvidence {
  path: string;
  archivePath: string;
  bytes: number;
  kind: string;
  mimeType?: string;
  locator?: string;
  id?: string;
  type?: string;
  imagePath?: string;
  imageArchivePath?: string;
  jsonPath?: string;
  jsonArchivePath?: string;
  descriptionPath?: string;
  descriptionArchivePath?: string;
  referenceDesignators?: string[];
  labels?: string[];
  connectionCues?: string[];
  classificationReasons?: string[];
  analysisOutputs?: unknown[];
  offsetSeconds?: number;
  transcriptStartSeconds?: number;
  transcriptEndSeconds?: number;
  reason?: string;
  changeScore?: number;
}

interface MediaEvidence {
  filename?: string;
  contentType?: string;
  sourceType?: string;
  transcript?: string;
  transcriptSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  language?: string;
  languageProbability?: number;
  keyframes: Array<{ path: string; offsetSeconds?: number }>;
}

interface EnrichmentOutput {
  summary: string;
  spans: Array<{ locator: string; text: string }>;
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
}

interface AnswerEvidence {
  result: {
    chunkId?: number;
    documentId: string;
    title: string;
    sourceType: string;
    locator: string;
    uri?: string;
  };
  text: string;
}

interface AnswerResultRef {
  chunkId?: number;
  title: string;
  sourceType: string;
  locator: string;
  uri?: string;
}

interface AnswerChunkRef {
  chunkId?: number;
  locator: string;
  text: string;
}

interface AnswerOutput {
  answer: string;
  answerHtml: string;
  citations: Array<{ documentId: string; title: string; locator: string }>;
  warnings: string[];
}

interface EnrichmentEvidence {
  document: Record<string, unknown>;
  chunks: DocumentChunkEvidence[];
  artifacts: ArtifactEvidence[];
  media?: MediaEvidence;
}

interface DocumentChunkEvidence {
  locator: unknown;
  origin: unknown;
  text: string;
}

interface EnrichmentEvidenceBatch {
  document: Record<string, unknown>;
  batch: {
    index: number;
    total: number;
    itemCount: number;
    attachedImageBatchSize?: number;
    attachedImageCount?: number;
  };
  chunks: DocumentChunkEvidence[];
  artifacts: ArtifactEvidence[];
  attachedImages?: AttachedImageEvidence[];
  media?: BatchedMediaEvidence;
}

interface AttachedImageEvidence {
  path: string;
  archivePath?: string;
  artifactId?: string;
  artifactType?: string;
  locator?: string;
  role: string;
}

interface BatchedMediaEvidence {
  filename?: string;
  contentType?: string;
  sourceType?: string;
  language?: string;
  languageProbability?: number;
  transcriptSegments: Array<{ segmentIndex: number; text: string; startSeconds?: number; endSeconds?: number }>;
  keyframes: Array<{ path: string; offsetSeconds?: number }>;
}

type EvidenceBatchItem =
  | { kind: "chunk"; value: DocumentChunkEvidence }
  | { kind: "artifact"; value: ArtifactEvidence }
  | { kind: "transcript"; value: { segmentIndex: number; text: string; startSeconds?: number; endSeconds?: number } }
  | { kind: "keyframe"; value: { path: string; offsetSeconds?: number } };

function uniqueDocuments(response: Record<string, unknown>): IngestedDocumentRef[] {
  const documents = [
    ...recordsArray(response.documents),
    ...(isRecord(response.document) ? [response.document] : [])
  ];
  const unique = new Map<string, IngestedDocumentRef>();
  for (const document of documents) {
    if (typeof document.documentId === "string" && document.documentId.trim()) {
      unique.set(document.documentId, { documentId: document.documentId });
    }
  }
  return [...unique.values()];
}

function configuredSkillIds(value: unknown): string[] {
  if (typeof value !== "string") {
    return DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS;
  }
  const skillIds = value
    .split(/[,\s]+/u)
    .map((skillId) => skillId.trim())
    .filter(Boolean);
  return skillIds.length > 0 ? skillIds : DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS;
}

function usesImageAnalysis(skillIds: string[], evidence: EnrichmentEvidence): boolean {
  return skillIds.some((skillId) => /(?:visual|image)/iu.test(skillId))
    || evidence.artifacts.length > 0
    || Boolean(evidence.media?.keyframes.length);
}

function requiredQuestion(input: Record<string, unknown>): string {
  const value = typeof input.question === "string" ? input.question : typeof input.query === "string" ? input.query : "";
  const question = value.trim();
  if (!question) {
    throw new Error("question must be a non-empty string.");
  }
  return question;
}

function answerSearchInput(input: Record<string, unknown>, question: string): Record<string, unknown> {
  return compactRecord({
    query: question,
    limit: answerLimit(input.limit),
    mode: input.mode,
    sourceTypes: arrayOfStrings(input.sourceTypes),
    states: arrayOfStrings(input.states),
    collection: typeof input.collection === "string" ? input.collection.trim() : undefined
  });
}

function answerLimit(value: unknown): number {
  if (value === undefined) {
    return 8;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("limit must be an integer between 1 and 20.");
  }
  return value;
}

function groupAnswerResults(results: Record<string, unknown>[]): Map<string, AnswerResultRef[]> {
  const groups = new Map<string, AnswerResultRef[]>();
  for (const result of results) {
    const documentId = typeof result.documentId === "string" ? result.documentId : "";
    if (!documentId) {
      continue;
    }
    const group = groups.get(documentId) ?? [];
    group.push({
      chunkId: typeof result.chunkId === "number" ? result.chunkId : undefined,
      title: typeof result.title === "string" ? result.title : "",
      sourceType: typeof result.sourceType === "string" ? result.sourceType : "",
      locator: typeof result.locator === "string" ? result.locator : "",
      uri: typeof result.uri === "string" ? result.uri : undefined
    });
    groups.set(documentId, group);
  }
  return groups;
}

function answerChunkIds(results: AnswerResultRef[]): number[] {
  return [...new Set(results.map((result) => result.chunkId).filter((chunkId): chunkId is number => typeof chunkId === "number"))];
}

function selectAnswerChunks(chunks: Record<string, unknown>[], results: AnswerResultRef[]): AnswerChunkRef[] {
  const sourceChunks = chunks
    .filter((chunk) => chunk.chunk_origin !== "ai" && chunk.chunkOrigin !== "ai")
    .map((chunk): AnswerChunkRef => ({
      chunkId: typeof chunk.chunk_id === "number" ? chunk.chunk_id : typeof chunk.chunkId === "number" ? chunk.chunkId : undefined,
      locator: typeof chunk.locator === "string" ? chunk.locator : "",
      text: typeof chunk.text === "string" ? chunk.text : ""
    }))
    .filter((chunk) => chunk.locator && chunk.text);
  const documentChars = sourceChunks.reduce((total, chunk) => total + chunk.text.length, 0);
  if (documentChars <= ANSWER_DOCUMENT_TARGET_CHARS) {
    return sourceChunks;
  }
  const matchedChunkIds = new Set(results.map((result) => result.chunkId).filter((chunkId): chunkId is number => typeof chunkId === "number"));
  const selectedIndexes = new Set<number>();
  for (const [index, chunk] of sourceChunks.entries()) {
    if (chunk.chunkId !== undefined && matchedChunkIds.has(chunk.chunkId)) {
      selectedIndexes.add(index);
      if (index > 0) {
        selectedIndexes.add(index - 1);
      }
      if (index + 1 < sourceChunks.length) {
        selectedIndexes.add(index + 1);
      }
    }
  }
  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => sourceChunks[index])
    .filter((chunk): chunk is AnswerChunkRef => Boolean(chunk));
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0) && value !== ""));
}

function windowHasMore(value: unknown): boolean {
  return isRecord(value) && value.hasMore === true;
}

function nextWindowOffset(value: unknown, fallbackOffset: number, count: number): number {
  if (!isRecord(value)) {
    return fallbackOffset + count;
  }
  const offset = typeof value.offset === "number" ? value.offset : fallbackOffset;
  const limit = typeof value.limit === "number" ? value.limit : count;
  return offset + Math.max(limit, count);
}

function buildEnrichmentPrompt(skills: CloudxSkill[], evidence: EnrichmentEvidenceBatch): string {
  return [
    "You are improving a CloudX documentation archive import.",
    "Use only the configured skills below and the provided source-grounded evidence.",
    "Return only JSON matching the requested schema.",
    "Create derived spans that make missing metadata, tables, graphs, flowcharts, screenshots, media transcript details, and extraction gaps searchable.",
    "When `attachedImages` is non-empty, those files are attached to this Codex exec request. Inspect the attached image pixels directly instead of relying only on OCR, filenames, or heuristic metadata.",
    "Large imports are split so each Codex exec request receives a bounded number of attached images. Every attached image group is processed by a separate request.",
    "For schematic artifacts, extract detailed visual facts from the rendered schematic image: visible components/reference designators, component roles or values when legible, pin/net labels, power and ground symbols, and how wires connect components and nets.",
    "For schematic outputs, prefer separate spans with locators like `ai:schematic:<artifact-id>:components`, `ai:schematic:<artifact-id>:connections`, and `ai:schematic:<artifact-id>:uncertainties`.",
    "State uncertain readings as uncertain; do not infer hidden wires, values, or nets that are not visible in the image or source text.",
    "Do not invent facts not grounded in the document chunks, extracted artifacts, ASR transcript, or keyframe evidence.",
    "When the evidence is insufficient, describe the limitation in warnings instead of guessing.",
    "Return `metadata` as an array of { key, value } entries so each metadata value is source-grounded and explicitly named.",
    `This is evidence batch ${evidence.batch.index} of ${evidence.batch.total}. Process this batch only; CloudX will run every batch and merge all returned spans and warnings.`,
    "",
    "Configured skills:",
    JSON.stringify(skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions ?? ""
    })), null, 2),
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2)
  ].join("\n");
}

function buildAnswerPrompt(question: string, evidence: AnswerEvidence[]): string {
  return [
    "You answer questions using the CloudX documentation archive.",
    "Use only the source chunks below. If the chunks are insufficient, say what is missing in warnings.",
    "Return only JSON matching the requested schema.",
    "Return `answer` as concise plaintext and `answerHtml` as semantic HTML using only these tags: div, section, h4, h5, p, ol, ul, li, strong, em, code, pre, blockquote, table, thead, tbody, tr, th, and td. Do not include attributes, scripts, styles, images, links, forms, or iframes.",
    "Use short sections, paragraphs, lists, or tables in `answerHtml`; do not put numbered steps into one long paragraph.",
    "For procedural content such as recipes, include enough concrete steps and ingredients from the source chunks for the user to act manually.",
    "Citations must reference documentId, title, and locator from the evidence.",
    "",
    `Question: ${question}`,
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2)
  ].join("\n");
}

function normalizeEnrichmentOutput(value: unknown): EnrichmentOutput {
  const record = getRecord(value, "enrichment output");
  return {
    summary: typeof record.summary === "string" ? record.summary.trim() : "",
    spans: recordsArray(record.spans)
      .map((span) => ({
        locator: typeof span.locator === "string" ? span.locator.trim() : "",
        text: typeof span.text === "string" ? span.text.trim() : ""
      }))
      .filter((span) => span.locator && span.text),
    metadata: metadataEntriesRecord(record.metadata),
    warnings: arrayOfStrings(record.warnings)
  };
}

function normalizeAnswerOutput(value: unknown): AnswerOutput {
  const record = getRecord(value, "answer output");
  return {
    answer: typeof record.answer === "string" ? record.answer.trim() : "",
    answerHtml: typeof record.answerHtml === "string" ? record.answerHtml.trim() : "",
    citations: recordsArray(record.citations)
      .map((citation) => ({
        documentId: typeof citation.documentId === "string" ? citation.documentId.trim() : "",
        title: typeof citation.title === "string" ? citation.title.trim() : "",
        locator: typeof citation.locator === "string" ? citation.locator.trim() : ""
      }))
      .filter((citation) => citation.documentId && citation.title && citation.locator),
    warnings: arrayOfStrings(record.warnings)
  };
}

function mergeEnrichmentOutputs(outputs: EnrichmentOutput[]): EnrichmentOutput {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [batchIndex, output] of outputs.entries()) {
    for (const [key, value] of Object.entries(output.metadata)) {
      const metadataKey = Object.hasOwn(metadata, key) ? `batch_${batchIndex + 1}_${key}` : key;
      metadata[metadataKey] = value;
    }
  }
  return {
    summary: outputs
      .map((output, index) => output.summary ? `Batch ${index + 1}: ${output.summary}` : "")
      .filter(Boolean)
      .join("\n\n"),
    spans: outputs.flatMap((output) => output.spans),
    metadata,
    warnings: outputs.flatMap((output, index) => output.warnings.map((warning) => `batch ${index + 1}: ${warning}`))
  };
}

function metadataEntriesRecord(value: unknown): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const entry of recordsArray(value)) {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) {
      continue;
    }
    const candidate = entry.value;
    if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean" || candidate === null) {
      metadata[key] = candidate;
    }
  }
  return metadata;
}

function documentSummary(document: Record<string, unknown>): Record<string, unknown> {
  return {
    documentId: document.document_id,
    title: document.title,
    sourceType: document.source_type,
    uri: document.uri,
    collection: document.collection,
    contentSha256: document.content_sha256,
    snapshotPath: document.snapshot_path
  };
}

async function documentArtifactEvidence(document: Record<string, unknown>, archiveRoot: string, extractedRoot: string): Promise<ArtifactEvidence[]> {
  const evidence: ArtifactEvidence[] = [];
  for (const artifact of availableArtifactRecords(document)) {
    const relativePath = typeof artifact.path === "string" ? artifact.path : "";
    if (!relativePath) {
      continue;
    }
    const artifactPath = resolvedArtifactPath(extractedRoot, relativePath, "artifact file");
    if (!artifactPath) {
      continue;
    }
    const stat = await fsp.stat(artifactPath);
    const imagePath = resolvedArtifactPath(extractedRoot, optionalRecordString(artifact, "imagePath"), "image artifact file");
    const jsonPath = resolvedArtifactPath(extractedRoot, optionalRecordString(artifact, "jsonPath"), "JSON artifact file");
    const descriptionPath = resolvedArtifactPath(extractedRoot, optionalRecordString(artifact, "descriptionPath"), "description artifact file");
    evidence.push({
      path: artifactPath,
      archivePath: path.relative(archiveRoot, artifactPath),
      bytes: typeof artifact.bytes === "number" ? artifact.bytes : stat.size,
      kind: typeof artifact.kind === "string" ? artifact.kind : artifactKind(relativePath),
      mimeType: optionalRecordString(artifact, "mimeType"),
      locator: optionalRecordString(artifact, "locator"),
      id: optionalRecordString(artifact, "id"),
      type: optionalRecordString(artifact, "type"),
      imagePath,
      imageArchivePath: imagePath ? path.relative(archiveRoot, imagePath) : undefined,
      jsonPath,
      jsonArchivePath: jsonPath ? path.relative(archiveRoot, jsonPath) : undefined,
      descriptionPath,
      descriptionArchivePath: descriptionPath ? path.relative(archiveRoot, descriptionPath) : undefined,
      referenceDesignators: recordStringArray(artifact, "referenceDesignators"),
      labels: recordStringArray(artifact, "labels"),
      connectionCues: recordStringArray(artifact, "connectionCues"),
      classificationReasons: recordStringArray(artifact, "classificationReasons"),
      analysisOutputs: Array.isArray(artifact.analysisOutputs) ? artifact.analysisOutputs : undefined,
      offsetSeconds: optionalRecordNumber(artifact, "offsetSeconds"),
      transcriptStartSeconds: optionalRecordNumber(artifact, "transcriptStartSeconds"),
      transcriptEndSeconds: optionalRecordNumber(artifact, "transcriptEndSeconds"),
      reason: optionalRecordString(artifact, "reason"),
      changeScore: optionalRecordNumber(artifact, "changeScore")
    });
  }
  return evidence;
}

function availableArtifactRecords(document: Record<string, unknown>): Record<string, unknown>[] {
  return recordsArray(document.artifacts).filter((artifact) => artifact.available !== false);
}

function documentChunks(document: Record<string, unknown>): DocumentChunkEvidence[] {
  return recordsArray(document.chunks)
    .filter((chunk) => chunk.chunk_origin !== "ai")
    .map((chunk) => ({
      locator: chunk.locator,
      origin: chunk.chunk_origin,
      text: typeof chunk.text === "string" ? chunk.text : ""
    }))
    .filter((chunk) => chunk.text);
}

function buildEvidenceBatches(evidence: EnrichmentEvidence): EnrichmentEvidenceBatch[] {
  const items = buildEvidenceItems(evidence);
  const grouped = groupEvidenceItems(items);
  return grouped.map((batchItems, index) => evidenceBatch(evidence, batchItems, index + 1, grouped.length));
}

function buildEvidenceItems(evidence: EnrichmentEvidence): EvidenceBatchItem[] {
  const items: EvidenceBatchItem[] = [];
  const remainingArtifacts = new Set(evidence.artifacts);
  for (const chunk of evidence.chunks) {
    items.push({ kind: "chunk", value: chunk });
    for (const artifact of evidence.artifacts) {
      if (remainingArtifacts.has(artifact) && artifactMatchesChunk(artifact, chunk)) {
        items.push({ kind: "artifact", value: artifact });
        remainingArtifacts.delete(artifact);
      }
    }
  }
  for (const artifact of evidence.artifacts) {
    if (remainingArtifacts.has(artifact)) {
      items.push({ kind: "artifact", value: artifact });
    }
  }
  items.push(...mediaTranscriptSegments(evidence.media).map((value) => ({ kind: "transcript" as const, value })));
  items.push(...(evidence.media?.keyframes ?? []).map((value) => ({ kind: "keyframe" as const, value })));
  return items;
}

function artifactMatchesChunk(artifact: ArtifactEvidence, chunk: DocumentChunkEvidence): boolean {
  const chunkLocator = typeof chunk.locator === "string" ? chunk.locator : "";
  if (artifact.locator && artifact.locator === chunkLocator) {
    return true;
  }
  if (artifact.id && (chunkLocator.includes(artifact.id) || chunk.text.includes(artifact.id))) {
    return true;
  }
  return Boolean(artifact.archivePath && chunk.text.includes(path.basename(artifact.archivePath)));
}

function groupEvidenceItems(items: EvidenceBatchItem[]): EvidenceBatchItem[][] {
  if (items.length === 0) {
    return [[]];
  }
  const groups: EvidenceBatchItem[][] = [];
  let current: EvidenceBatchItem[] = [];
  let currentChars = 0;
  let currentImages = 0;
  for (const item of items) {
    const itemChars = JSON.stringify(item).length;
    const itemImages = imageAttachmentCountForItem(item);
    if (current.length > 0 && (currentChars + itemChars > ENRICHMENT_BATCH_TARGET_CHARS || currentImages + itemImages > ENRICHMENT_IMAGE_ATTACHMENT_BATCH_SIZE)) {
      groups.push(current);
      current = [];
      currentChars = 0;
      currentImages = 0;
    }
    current.push(item);
    currentChars += itemChars;
    currentImages += itemImages;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function imageAttachmentCountForItem(item: EvidenceBatchItem): number {
  if (item.kind === "artifact") {
    return attachedImagesForArtifact(item.value).length;
  }
  if (item.kind === "keyframe") {
    return isReadableImagePath(item.value.path) ? 1 : 0;
  }
  return 0;
}

function evidenceBatch(evidence: EnrichmentEvidence, items: EvidenceBatchItem[], index: number, total: number): EnrichmentEvidenceBatch {
  const batch: EnrichmentEvidenceBatch = {
    document: evidence.document,
    batch: {
      index,
      total,
      itemCount: items.length
    },
    chunks: [],
    artifacts: []
  };
  for (const item of items) {
    if (item.kind === "chunk") {
      batch.chunks.push(item.value);
    } else if (item.kind === "artifact") {
      batch.artifacts.push(item.value);
    } else {
      batch.media ??= mediaBatchMetadata(evidence.media);
      if (item.kind === "transcript") {
        batch.media.transcriptSegments.push(item.value);
      } else {
        batch.media.keyframes.push(item.value);
      }
    }
  }
  const attachedImages = attachedImagesForBatch(batch);
  if (attachedImages.length > 0) {
    batch.attachedImages = attachedImages;
    batch.batch.attachedImageBatchSize = ENRICHMENT_IMAGE_ATTACHMENT_BATCH_SIZE;
    batch.batch.attachedImageCount = attachedImages.length;
  }
  if (evidence.media && !batch.media && total === 1) {
    batch.media = mediaBatchMetadata(evidence.media);
  }
  return batch;
}

function attachedImagesForBatch(batch: EnrichmentEvidenceBatch): AttachedImageEvidence[] {
  const images = new Map<string, AttachedImageEvidence>();
  for (const artifact of batch.artifacts) {
    for (const image of attachedImagesForArtifact(artifact)) {
      images.set(image.path, image);
    }
  }
  for (const keyframe of batch.media?.keyframes ?? []) {
    if (isReadableImagePath(keyframe.path)) {
      images.set(keyframe.path, {
        path: keyframe.path,
        role: "media keyframe",
        locator: keyframe.offsetSeconds !== undefined ? `media keyframe ${keyframe.offsetSeconds}s` : "media keyframe"
      });
    }
  }
  return [...images.values()];
}

function attachedImagesForArtifact(artifact: ArtifactEvidence): AttachedImageEvidence[] {
  const images: AttachedImageEvidence[] = [];
  if (isReadableImagePath(artifact.path) && isImageEvidence(artifact.path, artifact.mimeType, artifact.kind, artifact.type)) {
    images.push({
      path: artifact.path,
      archivePath: artifact.archivePath,
      artifactId: artifact.id,
      artifactType: artifact.type,
      locator: artifact.locator,
      role: artifact.type === "schematic" ? "schematic rendered image" : "visual artifact"
    });
  }
  if (artifact.imagePath && isReadableImagePath(artifact.imagePath)) {
    images.push({
      path: artifact.imagePath,
      archivePath: artifact.imageArchivePath,
      artifactId: artifact.id,
      artifactType: artifact.type,
      locator: artifact.locator,
      role: artifact.type === "schematic" ? "schematic rendered image" : "related image artifact"
    });
  }
  return images;
}

function batchImagePaths(batch: EnrichmentEvidenceBatch): string[] {
  return (batch.attachedImages ?? []).map((image) => image.path);
}

function mediaBatchMetadata(media: MediaEvidence | undefined): BatchedMediaEvidence {
  return {
    filename: media?.filename,
    contentType: media?.contentType,
    sourceType: media?.sourceType,
    language: media?.language,
    languageProbability: media?.languageProbability,
    transcriptSegments: [],
    keyframes: []
  };
}

function mediaTranscriptSegments(media: MediaEvidence | undefined): Array<{ segmentIndex: number; text: string; startSeconds?: number; endSeconds?: number }> {
  if (media?.transcriptSegments?.length) {
    return media.transcriptSegments
      .filter((segment) => segment.text.trim())
      .map((segment, index) => ({
        segmentIndex: index + 1,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds
      }));
  }
  return transcriptSegments(media?.transcript);
}

function transcriptSegments(transcript: string | undefined): Array<{ segmentIndex: number; text: string }> {
  if (!transcript?.trim()) {
    return [];
  }
  const segments: Array<{ segmentIndex: number; text: string }> = [];
  for (const text of splitText(transcript, TRANSCRIPT_SEGMENT_TARGET_CHARS)) {
    segments.push({ segmentIndex: segments.length + 1, text });
  }
  return segments;
}

function splitText(text: string, targetChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const segments: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + targetChars, normalized.length);
    if (end < normalized.length) {
      const newline = normalized.lastIndexOf("\n", end);
      const sentence = normalized.lastIndexOf(". ", end);
      const boundary = Math.max(newline, sentence);
      if (boundary > start) {
        end = boundary + (boundary === sentence ? 1 : 0);
      }
    }
    segments.push(normalized.slice(start, end).trim());
    start = end;
  }
  return segments.filter(Boolean);
}

function evidenceSummary(evidence: EnrichmentEvidence, batches: EnrichmentEvidenceBatch[]): Record<string, unknown> {
  const transcript = evidence.media?.transcript ?? "";
  return {
    chunkCount: evidence.chunks.length,
    artifactCount: evidence.artifacts.length,
    mediaTranscriptChars: transcript.length,
    keyframeCount: evidence.media?.keyframes.length ?? 0,
    batchCount: batches.length,
    batchItemCounts: batches.map((batch) => batch.batch.itemCount)
  };
}

async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function containsVideoStream(inputPath: string, signal?: AbortSignal, mediaProcessLauncher?: MediaProcessLauncher): Promise<boolean> {
  const result = await runMediaTool("ffprobe", [
    "-v", "error",
    "-protocol_whitelist", "file,pipe",
    "-select_streams", "V",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    inputPath
  ], signal, mediaProcessLauncher);
  if (result.status !== 0) {
    throw new Error(`ffprobe media inspection failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const { streams } = getRecord(JSON.parse(result.stdout), "ffprobe output");
  if (!Array.isArray(streams) || !streams.every((stream) => isRecord(stream) && stream.codec_type === "video")) {
    throw new Error("ffprobe output must contain an array of selected video streams.");
  }
  return streams.length > 0;
}

async function captureSceneKeyframes(
  inputPath: string,
  outputDir: string,
  signal?: AbortSignal,
  mediaProcessLauncher: MediaProcessLauncher = spawn
): Promise<Array<{ path: string; offsetSeconds?: number }>> {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = await runMediaTool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "info",
    "-i",
    inputPath,
    "-vf",
    MEDIA_SCENE_KEYFRAME_FILTER,
    "-fps_mode",
    "vfr",
    path.join(outputDir, "frame-%04d.jpg")
  ], signal, mediaProcessLauncher);
  if (result.status !== 0) {
    throw new Error(`ffmpeg keyframe extraction failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const frameNames = (await fsp.readdir(outputDir))
    .filter((name) => name.endsWith(".jpg"))
    .sort();
  const offsets = parseFfmpegShowinfoPtsTimes(result.stderr);
  if (frameNames.length !== offsets.length) {
    throw new Error(`ffmpeg keyframe extraction produced ${frameNames.length} frame files but ${offsets.length} frame timestamps.`);
  }
  return frameNames.map((name, index) => ({ path: path.join(outputDir, name), offsetSeconds: Math.max(0, Math.round(offsets[index] ?? 0)) }));
}

function runMediaTool(
  command: string,
  args: string[],
  signal?: AbortSignal,
  mediaProcessLauncher: MediaProcessLauncher = spawn
): Promise<{ status: number; stdout: string; stderr: string }> {
  if (signal?.aborted) {
    return Promise.reject(documentationAbortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const child = mediaProcessLauncher(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let processGroupId: number | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stoppingError: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let processGroupPoll: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let childClosed = false;
    let processGroupStopped = false;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      if (processGroupPoll) {
        clearTimeout(processGroupPoll);
      }
      signal?.removeEventListener("abort", abort);
      child.off("error", onChildError);
      child.off("close", onChildClose);
      child.stdout?.off("data", onStdoutData);
      child.stdout?.off("error", onStdoutError);
      child.stderr?.off("data", onStderrData);
      child.stderr?.off("error", onStderrError);
    };
    const rejectAfterCleanup = () => {
      if (settled || !stoppingError || !childClosed || !processGroupStopped) {
        return;
      }
      settled = true;
      cleanup();
      reject(stoppingError);
    };
    const terminate = (processSignal: NodeJS.Signals) => {
      stopMediaProcess(child, processSignal, processGroupId);
      if (processSignal === "SIGTERM" && !killTimeout) {
        killTimeout = setTimeout(() => {
          stopMediaProcess(child, "SIGKILL", processGroupId);
          waitForMediaProcessGroupExit(processGroupId, (timer) => {
            processGroupPoll = timer;
          }).then(
            () => {
              processGroupStopped = true;
              rejectAfterCleanup();
            },
            (error) => {
              stoppingError = error instanceof Error ? error : new Error(String(error));
              processGroupStopped = true;
              rejectAfterCleanup();
            }
          );
        }, MEDIA_TOOL_TERMINATION_GRACE_MS);
      }
    };
    const stopWithError = (error: Error) => {
      stoppingError ??= error;
      terminate("SIGTERM");
    };
    const abort = () => stopWithError(documentationAbortReason(signal!));
    const appendOutput = (stream: "stdout" | "stderr", chunk: string) => {
      if (stoppingError) {
        return;
      }
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stream === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes > MEDIA_TOOL_OUTPUT_MAX_BYTES) {
          stopWithError(new Error(`${command} stdout exceeded the ${MEDIA_TOOL_OUTPUT_MAX_BYTES} byte output limit.`));
          return;
        }
        stdout += chunk;
        return;
      }
      stderrBytes += bytes;
      if (stderrBytes > MEDIA_TOOL_OUTPUT_MAX_BYTES) {
        stopWithError(new Error(`${command} stderr exceeded the ${MEDIA_TOOL_OUTPUT_MAX_BYTES} byte output limit.`));
        return;
      }
      stderr += chunk;
    };
    function onChildError(error: Error): void {
      stoppingError ??= error;
      if (!processGroupId) {
        processGroupStopped = true;
        rejectAfterCleanup();
        return;
      }
      terminate("SIGTERM");
    }
    function onChildClose(code: number | null): void {
      if (settled) {
        return;
      }
      childClosed = true;
      if (stoppingError) {
        rejectAfterCleanup();
        return;
      }
      settled = true;
      cleanup();
      resolve({ status: code ?? 1, stdout, stderr });
    }
    function onStdoutData(chunk: string): void {
      appendOutput("stdout", chunk);
    }
    function onStderrData(chunk: string): void {
      appendOutput("stderr", chunk);
    }
    function onStdoutError(error: Error): void {
      stopWithError(error);
    }
    function onStderrError(error: Error): void {
      stopWithError(error);
    }
    child.on("error", onChildError);
    child.on("close", onChildClose);
    processGroupId = child.pid;
    timeout = setTimeout(() => stopWithError(new Error(`${command} media processing timed out after ${MEDIA_TOOL_TIMEOUT_MS} ms.`)), MEDIA_TOOL_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (!child.stdout || !child.stderr) {
      stopWithError(new Error(`${command} did not expose piped output streams.`));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.stdout.on("error", onStdoutError);
    child.stderr.on("error", onStderrError);
  });
}

async function waitForMediaProcessGroupExit(processGroupId: number | undefined, observeTimer: (timer: ReturnType<typeof setTimeout>) => void): Promise<void> {
  if (process.platform === "win32" || !processGroupId) {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10);
      observeTimer(timer);
    });
  }
  throw new Error("Media process group did not stop after SIGKILL.");
}

function stopMediaProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, processGroupId = child.pid): void {
  if (!processGroupId) {
    child.kill(signal);
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
      }
      return;
    }
  }
  child.kill(signal);
}

function documentationAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Documentation enrichment was cancelled.");
}

export function parseFfmpegShowinfoPtsTimes(output: string): number[] {
  return Array.from(output.matchAll(/\bpts_time:(-?\d+(?:\.\d+)?)/gu), (match) => Number.parseFloat(match[1] ?? "0"))
    .filter((value) => Number.isFinite(value));
}

function artifactKind(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./u, "") || "file";
}

function resolvedArtifactPath(extractedRoot: string, relativePath: string | undefined, label: string): string | undefined {
  if (!relativePath) {
    return undefined;
  }
  const artifactPath = path.resolve(extractedRoot, relativePath);
  if (!isSameOrChild(extractedRoot, artifactPath)) {
    throw new Error(sharedArtifactFilesystemMessage(`${label} escapes the extracted artifact directory: ${relativePath}`));
  }
  if (!fs.existsSync(artifactPath)) {
    throw new Error(sharedArtifactFilesystemMessage(`${label} is missing from the local archive filesystem: ${relativePath}`));
  }
  return artifactPath;
}

function sharedArtifactFilesystemMessage(reason: string): string {
  return `Documentation artifact enrichment requires CloudX server and documentation indexer to share the documentation archive filesystem; ${reason}.`;
}

function isReadableImagePath(filePath: string): boolean {
  return fs.existsSync(filePath) && isImageEvidence(filePath);
}

function isImageEvidence(filePath: string, mimeType?: string, kind?: string, type?: string): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  const label = `${kind ?? ""} ${type ?? ""}`.toLowerCase();
  if (/(?:image|figure|keyframe|page-render|schematic)/u.test(label) && /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/iu.test(filePath)) {
    return true;
  }
  return /\.(?:png|jpe?g|webp|gif|bmp|tiff?)$/iu.test(filePath);
}

function optionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalRecordNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

async function isTextFile(filename: string, signal?: AbortSignal): Promise<boolean> {
  let decoder: TextDecoder | undefined;
  let firstChunk = true;
  for await (const bytes of fs.createReadStream(filename, { signal })) {
    if (firstChunk) {
      // A BOM selects an encoding; media such as MP1 can share the same prefix.
      if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        decoder = new TextDecoder("utf-16be", { fatal: true });
      } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        decoder = new TextDecoder("utf-16le", { fatal: true });
      } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        decoder = new TextDecoder("utf-8", { fatal: true });
      }
      firstChunk = false;
    }
    let text: string;
    try {
      text = decoder ? decoder.decode(bytes, { stream: true }) : bytes.toString("latin1");
    } catch {
      return false;
    }
    // Apply the existing binary-control check to decoded characters for BOM text.
    if (/[\u0000-\u0008\u000b\u000e-\u001a\u001c-\u001f]/u.test(text)) {
      return false;
    }
  }
  try {
    decoder?.decode();
  } catch {
    return false;
  }
  return true;
}

function isMediaSource(source: DocumentationEnrichmentSource): boolean {
  const value = `${source.sourceType ?? ""} ${source.contentType ?? ""} ${source.filename ?? ""}`.toLowerCase();
  return /\bmedia\b/u.test(value) || /\baudio\//u.test(value) || /\bvideo\//u.test(value) || /\.(mp3|wav|m4a|aac|ogg|webm|mp4|mov|mkv|avi)\b/u.test(value);
}

function isVideoSource(source: DocumentationEnrichmentSource): boolean {
  const value = `${source.contentType ?? ""} ${source.filename ?? ""}`.toLowerCase();
  return /\bvideo\//u.test(value) || /\.(webm|mp4|mov|mkv|avi)\b/u.test(value);
}

function safeMediaFilename(filename: string | undefined): string {
  const safe = path.basename(filename || "upload.media").replace(/[^A-Za-z0-9._-]+/gu, "_");
  return safe || "upload.media";
}

function recordsArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function getRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSameOrChild(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
