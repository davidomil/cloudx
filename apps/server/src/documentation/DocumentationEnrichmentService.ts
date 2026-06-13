import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CloudxSkill, ConfigFieldOption, RulesSkillsStore } from "@cloudx/shared";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { runCodexExec } from "../voice/VoicePlanner.js";
import { DEFAULT_DOCUMENTATION_TIMEOUT_MS, type DocumentationClient } from "./DocumentationClient.js";

export const DOCUMENTATION_PLUGIN_ID = "documentation";
export const DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY = "aiEnrichmentEnabled";
export const DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY = "aiEnrichmentSkillIds";
export const DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY = "aiImageAnalysisModel";
export const DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY = "aiTextAnalysisModel";
export const DOCUMENTATION_AI_ANSWER_MODEL_KEY = "aiAnswerModel";
export const DOCUMENTATION_AI_USE_VOICE_MODEL = "__voice_model__";
export const DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL = "gpt-5.4-mini";
export const DOCUMENTATION_AI_MODEL_OPTIONS: ConfigFieldOption[] = [
  {
    label: "Same as voice control",
    value: DOCUMENTATION_AI_USE_VOICE_MODEL,
    description: "Use the current CloudX voice-control Codex model."
  },
  {
    label: "GPT-5.5",
    value: "gpt-5.5",
    description: "Frontier model for complex coding, research, and real-world work."
  },
  {
    label: "GPT-5.4",
    value: "gpt-5.4",
    description: "Strong model for everyday coding."
  },
  {
    label: "GPT-5.4-Mini",
    value: "gpt-5.4-mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks."
  },
  {
    label: "GPT-5.3-Codex-Spark",
    value: "gpt-5.3-codex-spark",
    description: "Ultra-fast coding model."
  }
];
export const DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS = [
  "documentation-enrich-metadata",
  "documentation-enrich-visuals",
  "documentation-enrich-media"
];

const ENRICHMENT_SCHEMA_PATH = fileURLToPath(new URL("./documentation-enrichment.schema.json", import.meta.url));
const ANSWER_SCHEMA_PATH = fileURLToPath(new URL("./documentation-answer.schema.json", import.meta.url));
const ENRICHMENT_BATCH_TARGET_CHARS = 60_000;
const ENRICHMENT_IMAGE_ATTACHMENT_BATCH_SIZE = 8;
const ANSWER_DOCUMENT_TARGET_CHARS = 40_000;
const ANSWER_EVIDENCE_TARGET_CHARS = 90_000;
const MEDIA_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
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
}

export interface DocumentationEnrichmentSource {
  filename?: string;
  content?: Buffer;
  contentType?: string;
  sourceType?: string;
}

export interface DocumentationEnrichmentOptions {
  client: DocumentationClient;
  config: ConfigService;
  rulesSkills: RulesSkillsCatalogService;
  runner: DocumentationEnrichmentRunner;
  asr?: AsrClient;
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
        imagePaths: options.imagePaths
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

  async enrichIngestResponse(response: Record<string, unknown>, source: DocumentationEnrichmentSource = {}): Promise<Record<string, unknown>> {
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
        results.push(await this.enrichDocument(document, source));
      } catch (error) {
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

  private async enrichDocument(document: IngestedDocumentRef, source: DocumentationEnrichmentSource): Promise<Record<string, unknown>> {
    const skillIds = configuredSkillIds(this.options.config.getPluginConfig(DOCUMENTATION_PLUGIN_ID)[DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY]);
    const skills = await this.resolveSkills(skillIds);
    const fullDocument = getRecord((await this.options.client.getDocument({ documentId: document.documentId })).document, "document");
    const cleanup: Array<() => Promise<void>> = [];
    try {
      const mediaEvidence = await this.prepareMediaEvidence(source, cleanup);
      const evidence = {
        document: documentSummary(fullDocument),
        chunks: documentChunks(fullDocument),
        artifacts: await this.documentArtifacts(fullDocument),
        media: mediaEvidence
      };
      const model = this.enrichmentModel(skillIds, evidence);
      const batches = buildEvidenceBatches(evidence);
      const outputs = [];
      for (const batch of batches) {
        const imagePaths = batchImagePaths(batch);
        outputs.push(normalizeEnrichmentOutput(await this.options.runner.run(buildEnrichmentPrompt(skills, batch), imagePaths.length > 0 ? { model, imagePaths } : { model })));
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
      await this.options.client.enrichDocument({
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
      });
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

  private async resolveSkills(skillIds: string[]): Promise<CloudxSkill[]> {
    const store = await (this.options.pluginContributionsReady?.() ?? this.options.rulesSkills.list());
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
      let document = documents.get(documentId);
      if (!document) {
        document = getRecord((await this.options.client.getDocument({ documentId })).document, "document");
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

  private async documentArtifacts(document: Record<string, unknown>): Promise<ArtifactEvidence[]> {
    const availableArtifacts = availableArtifactRecords(document);
    const archiveRoot = await this.archiveRoot();
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
    if (structuredArtifacts.length > 0) {
      return structuredArtifacts;
    }
    if (!fs.existsSync(extracted)) {
      if (availableArtifacts.length > 0) {
        throw new Error(sharedArtifactFilesystemMessage(`extracted artifact directory is missing for ${snapshotPath}`));
      }
      return [];
    }
    const paths = await listFiles(extracted);
    const artifacts: ArtifactEvidence[] = [];
    for (const artifactPath of paths) {
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

  private async archiveRoot(): Promise<string | undefined> {
    const health = await this.options.client.health();
    return typeof health.archiveRoot === "string" ? health.archiveRoot : undefined;
  }

  private async prepareMediaEvidence(source: DocumentationEnrichmentSource, cleanup: Array<() => Promise<void>>): Promise<MediaEvidence | undefined> {
    if (!source.content || !isMediaSource(source)) {
      return undefined;
    }
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-media-"));
    cleanup.push(() => fsp.rm(tempDir, { recursive: true, force: true }));
    const mediaPath = path.join(tempDir, safeMediaFilename(source.filename));
    await fsp.writeFile(mediaPath, source.content);
    if (!this.options.asr) {
      throw new Error("Documentation media enrichment requires the ASR service so uploaded audio/video is not indexed without transcript evidence.");
    }
    const transcript = await this.options.asr.transcribe(source.content, source.filename || "upload.media");
    const keyframes = isVideoSource(source) ? captureSceneKeyframes(mediaPath, path.join(tempDir, "frames")) : [];
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

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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

function captureSceneKeyframes(inputPath: string, outputDir: string): Array<{ path: string; offsetSeconds?: number }> {
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    [
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
    ],
    { encoding: "utf8", timeout: MEDIA_TOOL_TIMEOUT_MS }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg keyframe extraction failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  const frameNames = fs.readdirSync(outputDir)
    .filter((name) => name.endsWith(".jpg"))
    .sort();
  const offsets = parseFfmpegShowinfoPtsTimes(result.stderr ?? "");
  if (frameNames.length !== offsets.length) {
    throw new Error(`ffmpeg keyframe extraction produced ${frameNames.length} frame files but ${offsets.length} frame timestamps.`);
  }
  return frameNames.map((name, index) => ({ path: path.join(outputDir, name), offsetSeconds: Math.max(0, Math.round(offsets[index] ?? 0)) }));
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
