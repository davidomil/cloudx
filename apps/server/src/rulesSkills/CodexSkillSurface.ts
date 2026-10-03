import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

const MAX_SKILL_METADATA_BYTES = 1024 * 1024;

/** Only entrypoint, native metadata, and its two icons belong in the scanned root. */
export async function materializeCodexSkillSurface(sourceDir: string, targetDir: string): Promise<void> {
  try {
    const original = await readableFile(path.join(sourceDir, "SKILL.md"));
    const instructions = await readBoundedFile(original);
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(instructions)?.[0];
    if (!frontmatter) throw new Error("SKILL.md must have YAML frontmatter with name and description");
    const header = parseDocument(frontmatter.replace(/^---\r?\n/u, "").replace(/\r?\n---(?:\r?\n|$)/u, ""));
    if (header.errors.length) throw new Error("SKILL.md contains invalid YAML frontmatter");
    for (const [key, limit] of [["name", 64], ["description", 1024]] as const) {
      const value = header.get(key);
      if (typeof value !== "string" || !value.trim() || [...value.trim()].length > limit) throw new Error(`SKILL.md ${key} must contain 1–${limit} characters`);
    }
    await fs.mkdir(targetDir, { recursive: true });
    // File symlinks are not discoverable in the native walker. A regular entrypoint
    // directs reads to the original file so relative resources and later edits work.
    await fs.writeFile(path.join(targetDir, "SKILL.md"), [
      frontmatter.trimEnd(), "", "# Skill source", "",
      `Read the original instructions at ${JSON.stringify(original)} before using this skill.`,
      `Resolve relative paths to skill-owned scripts, assets, references, and dependencies against ${JSON.stringify(path.dirname(original))}.`,
      "Resolve task input and output paths from the task working directory, following any explicit working-directory instructions in the original skill. The original instructions and resources are authoritative.", ""
    ].join("\n"));

    const metadata = path.join(sourceDir, "agents", "openai.yaml");
    try { await fs.lstat(metadata); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const document = parseDocument(await readBoundedFile(await readableFile(metadata)));
    if (document.errors.length) throw new Error(`Invalid agents/openai.yaml: ${document.errors[0].message}`);
    for (const key of ["icon_small", "icon_large"]) {
      const icon = document.getIn(["interface", key]);
      if (icon === undefined || icon === null) continue;
      if (typeof icon !== "string" || !icon || path.isAbsolute(icon) || icon.split(/[\\/]/u).includes("..")) {
        throw new Error(`interface.${key} must be a relative file under assets/`);
      }
      const normalized = path.normalize(icon);
      if (!normalized.startsWith(`assets${path.sep}`)) throw new Error(`interface.${key} must be under assets/`);
      const source = await readableFile(path.join(sourceDir, normalized));
      const relative = path.join("assets", `${key}${path.extname(normalized)}`);
      await fs.mkdir(path.join(targetDir, "assets"), { recursive: true });
      await fs.symlink(source, path.join(targetDir, relative), "file");
      document.setIn(["interface", key], relative);
    }
    await fs.mkdir(path.join(targetDir, "agents"), { recursive: true });
    await fs.writeFile(path.join(targetDir, "agents", "openai.yaml"), document.toString());
  } catch (error) {
    throw new Error(`Cannot expose Codex skill ${sourceDir} in ${targetDir}: ${error instanceof Error ? error.message : String(error)}. Check its SKILL.md, optional agents/openai.yaml, and resource permissions.`, { cause: error });
  }
}

async function readableFile(file: string): Promise<string> {
  const canonical = await fs.realpath(file);
  if (!(await fs.stat(canonical)).isFile()) throw new Error(`${file} must be a regular file`);
  await fs.access(canonical, constants.R_OK);
  return canonical;
}

async function readBoundedFile(file: string): Promise<string> {
  if ((await fs.stat(file)).size > MAX_SKILL_METADATA_BYTES) throw new Error(`${file} exceeds the 1 MiB skill metadata limit`);
  return fs.readFile(file, "utf8");
}
