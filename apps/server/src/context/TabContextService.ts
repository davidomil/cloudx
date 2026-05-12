import fs from "node:fs/promises";
import path from "node:path";

import type { WorkspaceTab } from "@cloudx/shared";

const MAX_CONTEXT_BYTES = 64_000;

export class TabContextService {
  constructor(private readonly dataDir: string) {}

  async create(tab: Pick<WorkspaceTab, "id" | "pluginId" | "title" | "cwd" | "status">): Promise<string> {
    const contextDir = path.join(this.dataDir, "context");
    await fs.mkdir(contextDir, { recursive: true });
    const contextPath = path.join(contextDir, `${tab.id}.md`);
    await fs.writeFile(
      contextPath,
      [
        "# Cloudx Tab Context",
        "",
        `- tabId: ${tab.id}`,
        `- plugin: ${tab.pluginId}`,
        `- title: ${tab.title}`,
        `- cwd: ${tab.cwd}`,
        `- status: ${tab.status}`,
        "",
        "## Events",
        ""
      ].join("\n"),
      { flag: "wx" }
    );
    return contextPath;
  }

  async record(tab: WorkspaceTab, kind: string, payload: string): Promise<void> {
    if (!tab.contextPath) {
      return;
    }
    const sanitized = sanitize(payload);
    if (!sanitized) {
      return;
    }
    const entry = [`### ${new Date().toISOString()} ${kind}`, "", "```text", sanitized, "```", ""].join("\n");
    await fs.appendFile(tab.contextPath, entry);
    await this.truncate(tab.contextPath);
  }

  async read(tab: WorkspaceTab): Promise<string> {
    if (!tab.contextPath) {
      return "";
    }
    return fs.readFile(tab.contextPath, "utf8").catch(() => "");
  }

  private async truncate(contextPath: string): Promise<void> {
    const stat = await fs.stat(contextPath).catch(() => undefined);
    if (!stat || stat.size <= MAX_CONTEXT_BYTES) {
      return;
    }
    const content = await fs.readFile(contextPath, "utf8");
    const keep = content.slice(-MAX_CONTEXT_BYTES);
    await fs.writeFile(contextPath, `# Cloudx Tab Context\n\n_Trimmed to the latest ${MAX_CONTEXT_BYTES} bytes._\n\n${keep}`);
  }
}

function sanitize(payload: string): string {
  return payload
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n")
    .slice(-12_000);
}
