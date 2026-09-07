import { ForgeProviderError } from "./ForgeProvider.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string") return invalid();
  return value;
}

export function optionalText(value: unknown): string {
  return value === null || value === undefined ? "" : string(value);
}

export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

export function invalid(): never {
  throw new ForgeProviderError(
    "The provider returned an invalid or incomplete response.",
    502,
  );
}

export function issueNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ForgeProviderError(
      "Issue/request number must be a positive integer.",
    );
  return value;
}

export function webUrl(value: unknown): string {
  const text = string(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid();
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return invalid();
  return text;
}
