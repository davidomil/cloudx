import { parseDocument } from "yaml";
import { ForgeProviderError } from "./ForgeProvider.js";
import { record, string } from "./validation.js";

const ambiguous = (): never => { throw new ForgeProviderError("The pinned workflow does not prove unambiguous aggregate job dependencies."); };

type MatrixRow = Record<string, string | number | boolean>;
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);

function jobNames(id: string, job: Record<string, unknown>): string[] {
  const name = job.name === undefined ? id : string(job.name);
  if (!name.includes("${{")) return [name];
  const matrix = record(record(job.strategy).matrix);
  const axes = Object.keys(matrix).filter(key => !["include", "exclude"].includes(key));
  let rows: MatrixRow[] = axes.length ? [{}] : [];
  for (const [key, values] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    if (!Array.isArray(values) || !values.length || rows.length * values.length > 64 || !values.every(scalar)) return ambiguous();
    rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })));
    if (rows.length > 64) return ambiguous();
  }
  const extraRows = (key: string): MatrixRow[] => {
    const values = matrix[key] ?? [];
    if (!Array.isArray(values) || values.length > 64) return ambiguous();
    return values.map(value => {
      const row = record(value);
      if (!Object.values(row).every(scalar)) return ambiguous();
      return row as MatrixRow;
    });
  };
  rows = rows.filter(row => !extraRows("exclude").some(excluded => Object.entries(excluded).every(([key, value]) => row[key] === value)));
  const original = rows.map(row => ({ ...row }));
  for (const included of extraRows("include")) {
    let merged = false;
    original.forEach((row, index) => {
      if (Object.entries(included).every(([key, value]) => row[key] === undefined || row[key] === value)) {
        Object.assign(rows[index], included); merged = true;
      }
    });
    if (!merged) rows.push(included);
  }
  if (!rows.length || rows.length > 64) return ambiguous();
  return rows.map(row => {
    const expanded = name.replace(/\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g, (_expression, key: string) => {
      if (row[key] === undefined) return ambiguous();
      return String(row[key]);
    });
    if (expanded.includes("${{")) return ambiguous();
    return expanded;
  });
}

/** Resolve Actions job names only from literal, bounded workflow definitions. */
export class GitHubWorkflowDependencies {
  private readonly jobs: Record<string, unknown>;

  constructor(text: string) {
    if (Buffer.byteLength(text) > 1_000_000) ambiguous();
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) ambiguous();
    this.jobs = record(record(document.toJS({ maxAliasCount: 0 })).jobs);
    if (Object.keys(this.jobs).length > 200) ambiguous();
  }

  failedDependencies(gate: Record<string, unknown>, runJobs: Record<string, unknown>[]): Record<string, unknown>[] {
    const name = string(gate.name);
    const definitions = Object.entries(this.jobs).filter(([id, value]) => jobNames(id, record(value)).includes(name));
    if (definitions.length !== 1) return ambiguous();
    const [gateId, definition] = definitions[0];
    const needs = record(definition).needs;
    const ids = typeof needs === "string" ? [needs] : needs;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(id => typeof id === "string") || new Set(ids).size !== ids.length) return ambiguous();
    const dependencies = ids.flatMap(id => {
      if (id === gateId || !Object.hasOwn(this.jobs, id)) return ambiguous();
      return jobNames(id, record(this.jobs[id])).map(name => {
        const owners = Object.entries(this.jobs).filter(([key, value]) => jobNames(key, record(value)).includes(name));
        const matches = runJobs.filter(job => job.name === name);
        if (owners.length !== 1 || matches.length !== 1) return ambiguous();
        const job = matches[0];
        if (job.status !== "completed") throw new ForgeProviderError("An aggregate dependency is still running.");
        if (["action_required", "startup_failure", "cancelled"].includes(string(job.conclusion)))
          throw new ForgeProviderError("An aggregate dependency needs policy or infrastructure intervention.");
        return job;
      });
    });
    const failures = dependencies.filter(job => ["failure", "timed_out"].includes(string(job.conclusion)));
    if (!failures.length) return ambiguous();
    return failures;
  }
}
