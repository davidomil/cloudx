import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginSkillContributionFile } from "@cloudx/plugin-api";
import type { CloudxSkill } from "@cloudx/shared";

export const SOURCE_GROUNDED_WRITING: CloudxSkill = {
  id: "source-grounded-writing",
  name: "Source Grounded Writing",
  description: "Write source-grounded technical replies and artifacts, using direct drafting for short outputs and a validated evidence-backed compiler for substantial documents.",
  scope: "system"
};

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills/source-grounded-writing");

export const SOURCE_GROUNDED_WRITING_FILES: PluginSkillContributionFile[] = [
  ".gitignore",
  "README.md",
  "SKILL.md",
  "UPSTREAM.md",
  "assets/fixtures/minimal-ir.json",
  "assets/fixtures/reset-design-note.txt",
  "assets/quarto/_quarto.yml",
  "assets/quarto/source-grounded.css",
  "package-lock.json",
  "package.json",
  "references/evidence-policy.md",
  "references/intermediate-schema.json",
  "references/writing-contract.md",
  "requirements.txt",
  "scripts/check_deps.py",
  "scripts/compile_doc.py",
  "scripts/dot_wrapper.mjs",
  "scripts/install_tools.py",
  "scripts/render_doc.py",
  "scripts/render_dot.mjs",
  "scripts/render_visual.mjs",
  "scripts/sgw_common.py",
  "scripts/validate_evidence.py",
  "scripts/validate_presentation.py",
  "tests/test_literal_rendering.py",
  "tests/test_rendering.py",
  "tests/test_validation.py"
].map(file => ({
  path: file,
  content: fs.readFileSync(path.join(bundle, file), "utf8"),
  executable: file.startsWith("scripts/")
}));
