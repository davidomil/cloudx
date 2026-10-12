import { parse, type TomlTable } from "smol-toml";
import { parseTOML, type AST } from "toml-eslint-parser";

type Value = string | number | boolean | Value[] | { [key: string]: Value };
const parts = (key: AST.TOMLKey) => key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, i) => key === b[i]);
const object = (value: unknown): value is Record<string, Value> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const document = (text: string) => parseTOML(text, { tomlVersion: "1.1" });
const replace = (text: string, range: readonly [number, number], value = "") => text.slice(0, range[0]) + value + text.slice(range[1]);

/** Edit only changed values; preserve sibling settings, comments and secret fields. */
export function editCodexConfiguration(text: string, family: string, before: unknown, after: unknown): string {
  const edit = (keys: string[], previous: unknown, next: unknown): void => {
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (object(previous) || object(next)) {
      const left = object(previous) ? previous : {};
      const right = object(next) ? next : {};
      if (!object(previous) && previous !== undefined) text = editValue(text, keys, undefined);
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) edit([...keys, key], left[key], right[key]);
      if (!Object.keys(right).length && object(next)) text = editValue(text, keys, {});
      if (next !== undefined && !object(next)) {
        text = removeEmptyTables(text, family);
        text = editValue(text, keys, next as Value);
      }
      return;
    }
    text = editValue(text, keys, next as Value | undefined);
  };
  edit([family], before, after === null ? undefined : after);
  // Empty table headers are no longer overrides. Keep their comments in place.
  text = removeEmptyTables(text, family);
  parse(text);
  return text;
}

function removeEmptyTables(text: string, family: string): string {
  for (const table of [...document(text).body[0].body].reverse()) {
    if (table.type === "TOMLTable" && parts(table.key)[0] === family && !table.body.length)
      text = replace(text, [table.range[0], table.key.range[1] + (table.kind === "array" ? 2 : 1)]);
  }
  return text;
}

function find(text: string, keys: string[]) {
  let found: { entry: AST.TOMLKeyValue; inline?: AST.TOMLInlineTable } | undefined;
  const visit = (entry: AST.TOMLKeyValue, prefix: string[], inline?: AST.TOMLInlineTable) => {
    const path = [...prefix, ...parts(entry.key)];
    if (same(path, keys)) found = { entry, inline };
    if (entry.value.type === "TOMLInlineTable") entry.value.body.forEach(child => visit(child, path, entry.value as AST.TOMLInlineTable));
  };
  for (const node of document(text).body[0].body) {
    if (node.type === "TOMLKeyValue") visit(node, []);
    else node.body.forEach(entry => visit(entry, parts(node.key)));
  }
  return found;
}

function render(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(render).join(", ")}]`;
  if (object(value)) return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${render(item)}`).join(", ")} }`;
  return JSON.stringify(value);
}

function editValue(text: string, keys: string[], value: Value | undefined): string {
  const found = find(text, keys);
  if (found) {
    if (value !== undefined) return replace(text, found.entry.value.range, render(value));
    let range = found.entry.range;
    if (found.inline) {
      const siblings = found.inline.body;
      const index = siblings.indexOf(found.entry);
      const end = siblings[index + 1]?.range[0] ?? found.inline.range[1] - 1;
      const start = siblings[index - 1]?.range[1] ?? found.inline.range[0] + 1;
      const commas = document(text).tokens.filter(token => token.type === "Punctuator" && token.value === ",");
      const comma = commas.find(token => token.range[0] >= range[1] && token.range[1] <= end)
        ?? commas.find(token => token.range[0] >= start && token.range[1] <= range[0]);
      if (comma) range = [Math.min(range[0], comma.range[0]), Math.max(range[1], comma.range[1])];
    }
    return replace(text, range);
  }
  const arrayTables = document(text).body[0].body.filter(node => node.type === "TOMLTable" && parts(node.key).length >= keys.length && keys.every((part, i) => parts(node.key)[i] === part));
  if (arrayTables.length) {
    for (const table of [...arrayTables].reverse()) {
      if (table.type !== "TOMLTable") continue;
      for (const entry of [...table.body].reverse()) text = replace(text, entry.range);
      text = replace(text, [table.range[0], table.key.range[1] + 2]);
    }
  }
  if (value === undefined) return text;
  // Join an existing inline parent, or a matching explicit table, before using a root dotted key.
  for (let count = keys.length - 1; count > 0; count--) {
    const parent = find(text, keys.slice(0, count))?.entry.value;
    const key = keys.slice(count).map(part => JSON.stringify(part)).join(".");
    if (parent?.type === "TOMLInlineTable") return replace(text, [parent.range[0] + 1, parent.range[0] + 1], ` ${key} = ${render(value)}${parent.body.length ? "," : ""} `);
    const table = document(text).body[0].body.find(node => node.type === "TOMLTable" && node.kind !== "array" && same(parts(node.key), keys.slice(0, count)));
    if (table?.type === "TOMLTable") {
      const line = text.indexOf("\n", table.key.range[1]);
      const position = line < 0 ? text.length : line + 1;
      return replace(text, [position, position], `${line < 0 ? "\n" : ""}${key} = ${render(value)}\n`);
    }
  }
  return `${keys.map(key => JSON.stringify(key)).join(".")} = ${render(value)}\n${text}`;
}

export function parseCodexConfiguration(text: string): TomlTable {
  try { return parse(text); }
  catch { throw new Error("Codex configuration contains invalid TOML. No settings were saved."); }
}

export function mergeCodexConfigurationLayers<T extends Record<string, unknown>>(base: T, profile: T): T {
  const result = { ...base };
  for (const [key, value] of Object.entries(profile)) {
    const previous = result[key];
    (result as Record<string, unknown>)[key] = object(previous) && object(value) ? mergeCodexConfigurationLayers(previous, value) : value;
  }
  return result;
}

/** A visible entry can be removed explicitly; hidden sibling fields survive edits to retained entries. */
export function preserveHiddenCodexValues(original: unknown, visible: unknown, replacement: unknown): unknown {
  if (object(original) && object(replacement)) {
    const publicFields = object(visible) ? visible : {};
    return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(replacement)])].flatMap(key => {
      const value = !Object.hasOwn(publicFields, key) && !Object.hasOwn(replacement, key) ? original[key]
        : preserveHiddenCodexValues(original[key], publicFields[key], replacement[key]);
      return value === undefined ? [] : [[key, value]];
    }));
  }
  if (Array.isArray(original) && Array.isArray(replacement)) return replacement.map((item, index) => preserveHiddenCodexValues(original[index], Array.isArray(visible) ? visible[index] : undefined, item));
  return replacement;
}
