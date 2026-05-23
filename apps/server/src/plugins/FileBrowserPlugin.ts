import fs from "node:fs/promises";
import { constants, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { ConfigFieldDescriptor, ConfigValue, FileSearchMode, FileSearchResult, GitDiffFile, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { GitService } from "../git/GitService.js";
import type { PathPolicy } from "../pathPolicy.js";
import { isSameOrChildPath, relativeChildPath } from "../pathBoundary.js";
import { FileSearchService } from "../search/FileSearchService.js";
import { ArchiveExtractionService, type ArchiveExtractionDestination } from "../archive/ArchiveExtractionService.js";

export const FILE_BROWSER_TEXT_PREVIEW_BYTES = 512_000;
export const FILE_BROWSER_VOICE_PREVIEW_BYTES = 8_000;
const SYMLINK_FILE_ERROR = "File browser paths must not be symbolic links.";

interface FileListingEntry {
  name: string;
  type: "directory" | "file";
}

interface DirectoryVoiceState {
  path: string;
  relativePath: string;
  entries: FileListingEntry[];
}

interface OpenFileVoiceState {
  path: string;
  relativePath: string;
  previewKind: FilePreviewKind;
  mimeType: string;
  contentPreview: string;
  truncated: boolean;
  sizeBytes: number;
  updatedAt: string;
}

export type FilePreviewKind = "text" | "markdown" | "image" | "pdf";

export interface FilePreviewMetadata {
  previewKind: FilePreviewKind;
  mimeType: string;
}

interface GitVoiceState {
  state?: GitRepositoryState;
  diff?: GitDiffSummary;
  openDiffFile?: GitDiffFile;
}

interface SearchVoiceState {
  result?: FileSearchResult;
}

interface TextFilePreview {
  content: string;
  truncated: boolean;
}

export class FileBrowserPlugin implements WorkspacePlugin {
  readonly id = "file-browser";
  readonly acronym = "FB";
  readonly displayName = "Files";
  readonly description = "Browses and opens files under the tab working directory.";
  readonly panelKind = "file-browser" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly configFields: ConfigFieldDescriptor[] = [
    {
      key: "showGitDiff",
      label: "Show Git diff",
      type: "boolean",
      description: "Show Git repository setup controls, tree change badges, and rendered diffs in the file browser.",
      defaultValue: true
    },
    {
      key: "gitAutoRefresh",
      label: "Git auto-refresh",
      type: "boolean",
      description: "Automatically refresh Git repository state and changed-file badges in the file browser.",
      defaultValue: true
    },
    {
      key: "gitAutoRefreshSeconds",
      label: "Git refresh frequency",
      type: "number",
      description: "Seconds between automatic Git status refreshes.",
      defaultValue: 15,
      min: 1,
      step: 1
    }
  ];

  readonly actions: PluginActionDefinition[] = [
    {
      name: "list_directory",
      description: "List entries in a directory below the tab working directory. Use this to inspect folders before opening or editing files.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative directory path. Empty string means tab cwd." }
        },
        required: ["relativePath"],
        additionalProperties: false
      }
    },
    {
      name: "open_file",
      description: "Open a file below the tab working directory and expose preview metadata in voiceContext.openFile. Text and Markdown files include text content; images and PDFs include renderable metadata for the web UI.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to open." }
        },
        required: ["relativePath"],
        additionalProperties: false
      }
    },
    {
      name: "extract_archive",
      description: "Extract a supported archive below the tab working directory. Supports .zip, .tar, .tar.gz, and .tgz archives.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative archive file path to extract." },
          destination: { type: "string", enum: ["here", "folder"], description: "Use here to extract next to the archive, or folder to extract into a same-named folder." }
        },
        required: ["relativePath", "destination"],
        additionalProperties: false
      }
    },
    {
      name: "search_files",
      description: "Search files below the tab working directory by filename or by grep-style file contents.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filename substring or ripgrep-compatible content regular expression." },
          mode: { type: "string", enum: ["all", "filename", "content"], description: "Search mode. Use all for path/name and content search, filename for path/name search, and content for grep-style text search." },
          relativePath: { type: "string", description: "Optional relative directory scope. Empty string means tab cwd." },
          caseSensitive: { type: "boolean", description: "Whether matching should be case-sensitive. Default is false." },
          glob: { type: "string", description: "Optional ripgrep glob such as *.ts or !*.test.ts." },
          maxResults: { type: "number", description: "Maximum number of matching files to return, capped by the server." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: "replace_in_file",
      description: "Replace one exact text span in a file below the tab working directory. Use the active openFile when the transcript refers to the current file.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to edit." },
          oldText: { type: "string", description: "Exact existing text to replace. It must appear once." },
          newText: { type: "string", description: "Replacement text." }
        },
        required: ["relativePath", "oldText", "newText"],
        additionalProperties: false
      }
    },
    {
      name: "write_file",
      description: "Write full text content to a file below the tab working directory. Use only when the intended complete file content is known.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Full file content to write." },
          create: { type: "boolean", description: "Whether a missing file may be created." }
        },
        required: ["relativePath", "content"],
        additionalProperties: false
      }
    },
    {
      name: "get_git_state",
      description: "Inspect whether the file browser working directory is inside a Git repository and return available setup or diff controls.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "initialize_repository",
      description: "Initialize a Git repository in the file browser working directory.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "clone_repository",
      description: "Clone a Git repository URL into the empty file browser working directory.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Git repository URL to clone." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "set_origin",
      description: "Set the Git origin remote URL, initializing the working directory first when needed.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Git repository URL for the origin remote." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "list_git_diff",
      description: "List changed files under the file browser working directory against a comparison branch or ref.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          compareRef: { type: "string", description: "Optional comparison branch or ref. Empty uses the repository default." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "open_git_diff_file",
      description: "Open the rendered diff patch for one changed file under the file browser working directory.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path of the changed file." },
          compareRef: { type: "string", description: "Optional comparison branch or ref. Empty uses the repository default." }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  ];

  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly gitService = new GitService(),
    private readonly fileSearchService = new FileSearchService(),
    private readonly archiveExtractionService = new ArchiveExtractionService()
  ) {}

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
      actions: this.actions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new FileBrowserSession(input.tab, this.pathPolicy, this.gitService, this.fileSearchService, this.archiveExtractionService, input.getConfig ?? (() => input.config ?? {}));
  }
}

class FileBrowserSession implements PluginSession {
  private currentDirectory: DirectoryVoiceState | undefined;
  private openFile: OpenFileVoiceState | undefined;
  private git: GitVoiceState = {};
  private search: SearchVoiceState = {};

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly pathPolicy: PathPolicy,
    private readonly gitService: GitService,
    private readonly fileSearchService: FileSearchService,
    private readonly archiveExtractionService: ArchiveExtractionService,
    private readonly getConfig: () => Record<string, ConfigValue>
  ) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      recentOutput: this.openFile ? `${this.openFile.path}\n${this.openFile.contentPreview}` : this.currentDirectoryText()
    };
  }

  voiceContext(): PluginVoiceContext {
    const directoryText = this.currentDirectoryText();
    const openFileText = this.openFile ? `Open file ${this.openFile.relativePath}:\n${this.openFile.contentPreview}` : undefined;
    const searchText = this.searchContextText();
    const gitText = this.gitDiffEnabled() ? this.gitContextText() : undefined;
    const visibleText = [directoryText, openFileText, searchText, gitText].filter(Boolean).join("\n\n");
    return {
      kind: "file-browser",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "File browser session. Use list_directory, search_files, and open_file to inspect files, Git diff actions to review repository changes, and replace_in_file or write_file to edit files.",
      visibleText: visibleText || undefined,
      currentPath: this.currentDirectory?.path,
      currentRelativePath: this.currentDirectory?.relativePath,
      openFile: this.openFile,
      metadata: {
        listedEntryCount: this.currentDirectory?.entries.length ?? 0,
        searchResultCount: this.search.result?.files.length ?? 0,
        gitRepository: this.git.state?.isRepository,
        gitChangedFileCount: this.git.diff?.files.length
      }
    };
  }

  async handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "list_directory") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const directory = this.resolveUnderCwd(relativePath);
      await this.requireDirectory(directory);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const listedEntries = (await Promise.all(entries.map((entry) => fileListingEntry(directory, entry))))
        .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
      this.currentDirectory = {
        path: directory,
        relativePath: relativePath || ".",
        entries: listedEntries
      };
      return {
        path: directory,
        relativePath: relativePath || ".",
        entries: listedEntries
      };
    }
    if (action === "open_file") {
      const result = await this.openFilePreview(requireString(input.relativePath, "relativePath"));
      return result;
    }
    if (action === "extract_archive") {
      const archivePath = this.resolveUnderCwd(requireString(input.relativePath, "relativePath"));
      await this.requireFile(archivePath);
      const result = await this.archiveExtractionService.extract({
        cwd: this.tab.cwd,
        archivePath,
        destination: requireArchiveExtractionDestination(input.destination)
      });
      return result as unknown as Record<string, unknown>;
    }
    if (action === "search_files") {
      const result = await this.fileSearchService.search(this.tab.cwd, {
        query: requireString(input.query, "query"),
        mode: optionalSearchMode(input.mode),
        relativePath: await this.searchRelativePath(optionalString(input.relativePath, "relativePath")),
        caseSensitive: optionalBoolean(input.caseSensitive, "caseSensitive"),
        glob: optionalString(input.glob, "glob"),
        maxResults: optionalNumber(input.maxResults, "maxResults")
      });
      this.search.result = result;
      return result as unknown as Record<string, unknown>;
    }
    if (action === "replace_in_file") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const oldText = requireString(input.oldText, "oldText");
      const newText = requireString(input.newText, "newText");
      if (!oldText) {
        throw new Error("oldText must not be empty.");
      }
      const filePath = this.resolveUnderCwd(relativePath);
      const stat = await this.requireFile(filePath);
      const content = await readTextFileNoFollow(filePath, stat);
      const occurrences = countOccurrences(content, oldText);
      if (occurrences !== 1) {
        throw new Error(`Expected oldText to appear exactly once in ${relativePath}; found ${occurrences}.`);
      }
      const nextContent = content.replace(oldText, newText);
      await writeTextFileNoFollow(filePath, nextContent, stat, this.tab.cwd);
      this.setOpenFile(filePath, relativePath, filePreviewMetadataForPath(filePath), nextContent, Buffer.byteLength(nextContent, "utf8"), false);
      return {
        path: filePath,
        relativePath,
        replaced: true,
        content: nextContent
      };
    }
    if (action === "write_file") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const content = requireString(input.content, "content");
      const create = typeof input.create === "boolean" ? input.create : false;
      const filePath = this.resolveUnderCwd(relativePath);
      const stat = await this.ensureWritableFileTarget(filePath, create);
      if (create) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await this.requireDirectory(path.dirname(filePath));
      }
      await writeTextFileNoFollow(filePath, content, stat, this.tab.cwd);
      this.setOpenFile(filePath, relativePath, filePreviewMetadataForPath(filePath), content, Buffer.byteLength(content, "utf8"), false);
      return {
        path: filePath,
        relativePath,
        written: true,
        bytes: Buffer.byteLength(content, "utf8")
      };
    }
    if (action === "get_git_state") {
      this.requireGitDiffEnabled();
      const state = await this.gitService.getState(this.tab.cwd);
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "initialize_repository") {
      this.requireGitDiffEnabled();
      const state = await this.gitService.initializeRepository(this.tab.cwd);
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "clone_repository") {
      this.requireGitDiffEnabled();
      const state = await this.gitService.cloneRepository(this.tab.cwd, requireString(input.url, "url"));
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "set_origin") {
      this.requireGitDiffEnabled();
      const state = await this.gitService.setOrigin(this.tab.cwd, requireString(input.url, "url"));
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "list_git_diff") {
      this.requireGitDiffEnabled();
      const diff = await this.gitService.listDiff(this.tab.cwd, optionalString(input.compareRef, "compareRef"));
      this.git.diff = diff;
      return diff as unknown as Record<string, unknown>;
    }
    if (action === "open_git_diff_file") {
      this.requireGitDiffEnabled();
      const diffFile = await this.gitService.openDiffFile(this.tab.cwd, requireString(input.path, "path"), optionalString(input.compareRef, "compareRef"));
      this.git.openDiffFile = diffFile;
      return diffFile as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported file browser action: ${action}`);
  }

  private resolveUnderCwd(relativePath: string): string {
    const cwd = path.resolve(this.tab.cwd);
    const resolved = path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(cwd, relativePath || ".");
    if (!isSameOrChildPath(cwd, resolved)) {
      throw new Error("Path is outside the tab working directory.");
    }
    return this.pathPolicy.resolve(resolved);
  }

  private async searchRelativePath(relativePath: string | undefined): Promise<string> {
    const directory = this.resolveUnderCwd(relativePath ?? ".");
    const relative = relativeChildPath(this.tab.cwd, directory);
    if (relative === undefined) {
      throw new Error("Search path is outside the tab working directory.");
    }
    await this.requireDirectory(directory);
    return relative ? relative.split(path.sep).join("/") : ".";
  }

  private async openFilePreview(relativePath: string): Promise<Record<string, unknown>> {
    const filePath = this.resolveUnderCwd(relativePath);
    const stat = await this.requireFile(filePath);
    const metadata = filePreviewMetadataForPath(filePath);
    if (metadata.previewKind === "image" || metadata.previewKind === "pdf") {
      await verifyFileNoFollow(filePath, stat);
      const content = `${metadata.previewKind.toUpperCase()} preview: ${metadata.mimeType}, ${stat.size} bytes.`;
      this.setOpenFile(filePath, relativePath, metadata, content, stat.size, false);
      return { path: filePath, relativePath, truncated: false, content: "", sizeBytes: stat.size, ...metadata };
    }
    const preview = await readTextFilePreview(filePath, stat);
    this.setOpenFile(filePath, relativePath, metadata, preview.content, stat.size, preview.truncated);
    return { path: filePath, relativePath, truncated: preview.truncated, content: preview.content, sizeBytes: stat.size, ...metadata };
  }

  private async requireFile(filePath: string) {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${SYMLINK_FILE_ERROR}: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    await this.requireRealPathUnderCwd(filePath);
    return stat;
  }

  private async requireDirectory(directoryPath: string) {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${directoryPath}`);
    }
    await this.requireRealPathUnderCwd(directoryPath);
    return stat;
  }

  private async ensureWritableFileTarget(filePath: string, create: boolean): Promise<Stats | undefined> {
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      if (!create) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      await this.requireCreatablePathUnderCwd(filePath);
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${SYMLINK_FILE_ERROR}: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    await this.requireRealPathUnderCwd(filePath);
    return stat;
  }

  private async requireCreatablePathUnderCwd(filePath: string): Promise<void> {
    let ancestor = path.dirname(filePath);
    const cwd = path.resolve(this.tab.cwd);
    while (isSameOrChildPath(cwd, ancestor)) {
      const stat = await fs.stat(ancestor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (!stat) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          break;
        }
        ancestor = parent;
        continue;
      }
      if (!stat.isDirectory()) {
        throw new Error(`Writable file parent is not a directory: ${ancestor}`);
      }
      await this.requireRealPathUnderCwd(ancestor);
      return;
    }
    throw new Error("Path is outside the tab working directory.");
  }

  private async requireRealPathUnderCwd(filePath: string): Promise<void> {
    const [realCwd, realPath] = await Promise.all([
      fs.realpath(this.tab.cwd),
      fs.realpath(filePath)
    ]);
    if (!isSameOrChildPath(realCwd, realPath)) {
      throw new Error("Path resolves outside the tab working directory.");
    }
  }

  private setOpenFile(filePath: string, relativePath: string, metadata: FilePreviewMetadata, content: string, sizeBytes: number, truncated: boolean): void {
    const contentPreview = trimUtf8ToFirstBytes(content, FILE_BROWSER_VOICE_PREVIEW_BYTES);
    const previewTruncated = truncated || Buffer.byteLength(content, "utf8") > Buffer.byteLength(contentPreview, "utf8");
    this.openFile = {
      path: filePath,
      relativePath,
      previewKind: metadata.previewKind,
      mimeType: metadata.mimeType,
      contentPreview,
      truncated: previewTruncated,
      sizeBytes,
      updatedAt: new Date().toISOString()
    };
  }

  private currentDirectoryText(): string | undefined {
    if (!this.currentDirectory) {
      return undefined;
    }
    const entries = this.currentDirectory.entries.map((entry) => `${entry.type}\t${entry.name}`).join("\n");
    return `Directory ${this.currentDirectory.relativePath}:\n${entries}`;
  }

  private gitContextText(): string | undefined {
    if (!this.git.state) {
      return undefined;
    }
    if (!this.git.state.isRepository) {
      const controls = [
        this.git.state.setup.canInitialize ? "initialize_repository" : undefined,
        this.git.state.setup.canClone ? "clone_repository" : undefined,
        this.git.state.setup.canSetOrigin ? "set_origin" : undefined
      ]
        .filter(Boolean)
        .join(", ");
      return `Git: not a repository. Available controls: ${controls || "none"}.`;
    }
    const files = this.git.diff?.files.map((file) => `${file.statusCode}\t${file.path}`).join("\n");
    const open = this.git.openDiffFile ? `Open diff ${this.git.openDiffFile.path}${this.git.openDiffFile.message ? `: ${this.git.openDiffFile.message}` : ""}` : undefined;
    return [`Git repository ${this.git.state.currentBranch ?? this.git.state.headRef ?? ""}`.trim(), files ? `Changed files:\n${files}` : undefined, open].filter(Boolean).join("\n");
  }

  private searchContextText(): string | undefined {
    const result = this.search.result;
    if (!result) {
      return undefined;
    }
    const files = result.files.map((file) => {
      const firstMatch = file.matches[0];
      const location = firstMatch?.lineNumber ? `:${firstMatch.lineNumber}` : "";
      const text = firstMatch?.text ? `\t${firstMatch.text.trim()}` : "";
      return `${file.path}${location}${text}`;
    });
    return [`Search ${result.mode} "${result.query}" in ${result.relativePath}:`, files.length ? files.join("\n") : "No matches."].join("\n");
  }

  private gitDiffEnabled(): boolean {
    return this.getConfig().showGitDiff !== false;
  }

  private requireGitDiffEnabled(): void {
    if (!this.gitDiffEnabled()) {
      throw new Error("Git diff is disabled for the file browser plugin.");
    }
  }
}

async function readTextFilePreview(filePath: string, expectedStat: Stats): Promise<TextFilePreview> {
  const sizeBytes = expectedStat.size;
  const bytesToRead = Math.min(sizeBytes, FILE_BROWSER_TEXT_PREVIEW_BYTES);
  if (bytesToRead === 0) {
    return { content: "", truncated: false };
  }
  const file = await openFileNoFollow(filePath, constants.O_RDONLY, expectedStat);
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
    return {
      content: decodeUtf8Prefix(buffer.subarray(0, bytesRead)),
      truncated: sizeBytes > FILE_BROWSER_TEXT_PREVIEW_BYTES
    };
  } finally {
    await file.close();
  }
}

async function readTextFileNoFollow(filePath: string, expectedStat: Stats): Promise<string> {
  const file = await openFileNoFollow(filePath, constants.O_RDONLY, expectedStat);
  try {
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function writeTextFileNoFollow(filePath: string, content: string, expectedStat: Stats | undefined, cwd: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (expectedStat ? 0 : constants.O_CREAT | constants.O_EXCL);
  const file = await openFileNoFollow(filePath, flags, expectedStat);
  try {
    await requireRealPathUnderCwd(cwd, filePath);
    await file.truncate(0);
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

async function verifyFileNoFollow(filePath: string, expectedStat: Stats): Promise<void> {
  const file = await openFileNoFollow(filePath, constants.O_RDONLY, expectedStat);
  await file.close();
}

async function openFileNoFollow(filePath: string, flags: number, expectedStat?: Stats) {
  const file = await fs.open(filePath, flags | constants.O_NOFOLLOW).catch((error) => {
    if (isSymbolicLinkOpenError(error)) {
      throw new Error(`${SYMLINK_FILE_ERROR}: ${filePath}`);
    }
    throw error;
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (expectedStat && !sameFilesystemObject(stat, expectedStat))) {
      throw new Error(`File browser path changed during file access: ${filePath}`);
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function sameFilesystemObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function requireRealPathUnderCwd(cwd: string, filePath: string): Promise<void> {
  const [realCwd, realPath] = await Promise.all([fs.realpath(cwd), fs.realpath(filePath)]);
  if (!isSameOrChildPath(realCwd, realPath)) {
    throw new Error("Path resolves outside the tab working directory.");
  }
}

function trimUtf8ToFirstBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return decodeUtf8Prefix(Buffer.from(value, "utf8").subarray(0, maxBytes));
}

function decodeUtf8Prefix(buffer: Buffer): string {
  return new StringDecoder("utf8").write(buffer);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

async function fileListingEntry(directory: string, entry: Dirent): Promise<FileListingEntry> {
  const type = entry.isDirectory() || await isSymlinkedDirectory(path.join(directory, entry.name), entry) ? "directory" : "file";
  return { name: entry.name, type };
}

async function isSymlinkedDirectory(entryPath: string, entry: Dirent): Promise<boolean> {
  if (!entry.isSymbolicLink()) {
    return false;
  }
  const stat = await fs.stat(entryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
      return undefined;
    }
    throw error;
  });
  return stat?.isDirectory() ?? false;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }
  return value;
}

function optionalSearchMode(value: unknown): FileSearchMode | undefined {
  const mode = optionalString(value, "mode");
  if (mode === undefined) {
    return undefined;
  }
  if (mode !== "all" && mode !== "filename" && mode !== "content") {
    throw new Error("mode must be all, filename, or content.");
  }
  return mode;
}

function requireArchiveExtractionDestination(value: unknown): ArchiveExtractionDestination {
  if (value === "here" || value === "folder") {
    return value;
  }
  throw new Error("destination must be here or folder.");
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf(needle, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + 1;
  }
}

export function filePreviewMetadataForPath(filePath: string): FilePreviewMetadata {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".mdown" || extension === ".mkd") {
    return { previewKind: "markdown", mimeType: "text/markdown; charset=utf-8" };
  }
  const imageMimeType = imageMimeTypeForExtension(extension);
  if (imageMimeType) {
    return { previewKind: "image", mimeType: imageMimeType };
  }
  if (extension === ".pdf") {
    return { previewKind: "pdf", mimeType: "application/pdf" };
  }
  return { previewKind: "text", mimeType: "text/plain; charset=utf-8" };
}

function imageMimeTypeForExtension(extension: string): string | undefined {
  switch (extension) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function isSymbolicLinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}
