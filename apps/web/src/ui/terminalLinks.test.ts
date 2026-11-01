import { describe, expect, it } from "vitest";
import { terminalLinkDestination } from "./terminalLinks.js";

describe("terminal citation routing", () => {
  it("preserves web destinations and routes native editor links into the originating workspace", () => {
    expect(terminalLinkDestination("https://example.test/page?q=one#two", "/workspace")).toEqual({ kind: "web", url: "https://example.test/page?q=one#two" });
    for (const url of ["vscode://file/workspace/src/caf%C3%A9%20file.ts:42:3", "cursor://file/workspace/src/caf%C3%A9%20file.ts:42:3", "file:///workspace/src/caf%C3%A9%20file.ts:42:3", "src/café file.ts:42:3"]) {
      expect(terminalLinkDestination(url, "/workspace")).toEqual({ kind: "file", relativePath: "src/café file.ts", line: 42, column: 3 });
    }
    expect(terminalLinkDestination("file:///workspace/a.ts#L12C2", "/workspace")).toEqual({ kind: "file", relativePath: "a.ts", line: 12, column: 2 });
  });
  it.each(["javascript:alert(1)", "command://execute", "file://remote/workspace/file", "file:///workspace/../secret", "file:///workspace-other/a.ts", "../secret.ts:1", "https://user:secret@example.test", "src/a.ts:0", "src/a.ts:9007199254740992", "file:///workspace/a%00.ts"])("rejects unsupported or out-of-workspace destination %s", value => {
    expect(() => terminalLinkDestination(value, "/workspace")).toThrow();
  });
});
