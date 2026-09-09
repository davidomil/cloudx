import type { ForgeKind, ForgeListScope } from "@cloudx/shared";
import { ForgeProviderError, type ForgeListIdentity } from "./ForgeProvider.js";

export function resolveListScope(
  scope: ForgeListScope | undefined,
  provider: ForgeKind,
  readIdentity?: () => ForgeListIdentity,
): { field: "assignee" | "author"; users: string[] } | undefined {
  if (scope === undefined) return;
  if (!["assigned_to_me", "created_by_me", "created_by_workers"].includes(scope))
    throw new ForgeProviderError("Choose a supported Forge list scope.");
  const identity = readIdentity?.();
  const username = /^[A-Za-z0-9_.-]{1,255}$/;
  if (scope !== "created_by_workers") {
    if (typeof identity?.username !== "string" || !username.test(identity.username))
      throw new ForgeProviderError("Set your Forge username in settings to use personal filters.");
    return { field: scope === "assigned_to_me" ? "assignee" : "author", users: [identity.username] };
  }
  const authors = identity?.workerAuthors;
  const author = provider === "github" ? /^app\/[A-Za-z0-9_-]{1,100}$/ : username;
  if (!Array.isArray(authors) || !authors.length || authors.length > 2 || authors.some(value => typeof value !== "string" || !author.test(value)))
    throw new ForgeProviderError("Connect the Forge worker applications to load their author identities.");
  return { field: "author", users: [...new Set(authors)] };
}

export function assertGitHubScopedFilter(filter: string, field: "assignee" | "author"): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let unquoted = "";
  for (const character of filter) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; unquoted += " "; continue; }
    if (quoted) continue;
    unquoted += character;
    if (character === "(") depth++;
    if (character === ")" && --depth < 0) break;
  }
  if (depth !== 0 || quoted)
    throw new ForgeProviderError("Balance parentheses and quotes in the native filter before using a quick scope.");
  if (new RegExp(`(?:^|\\s|\\()[+-]?${field}:`, "i").test(unquoted))
    throw new ForgeProviderError(`Remove ${field} qualifiers from the native filter when using this quick scope.`);
}
