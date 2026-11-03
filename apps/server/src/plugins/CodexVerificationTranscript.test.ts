import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { completedNativeTurn, completedVerificationTurn, readVerificationTranscript, type VerificationTranscriptEvent } from "./CodexVerificationTranscript.js";

const header = { type: "session_meta", payload: { id: "selected-thread" } };
const start = (turnId: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
const roots = ["/workspace", "/workspace/data/rules-skills"];
const context = (turnId: string) => ({ type: "turn_context", payload: { turn_id: turnId, approval_policy: "never", workspace_roots: roots } });
const complete = (turnId: string) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "answer" } });
const completedTurn = (events: VerificationTranscriptEvent[], firstNewEvent = 0) => completedVerificationTurn(events, firstNewEvent, "selected-thread", "answer");

it("requires a fresh native start, matching completion and launch context in the selected thread", () => {
  const events = [header, start("old"), context("old"), complete("old")];
  const boundary = events.length;
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(start("new"), context("new"));
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(complete("old"));
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(complete("new"));
  expect(completedTurn(events, boundary)).toEqual({ threadId: "selected-thread", turnId: "new", context: context("new").payload, workspaceRoots: roots });
});

it("does not mistake a displayed answer or an old checkpoint for native completion", () => {
  expect(completedTurn([header, complete("old"), start("new"), context("new"), {
    type: "response_item", payload: { type: "message", text: "answer" }
  }])).toBeUndefined();
});

it.each([
  { events: [{ ...header, payload: { id: "other-thread" } }], message: "different selected conversation" },
  { events: [header, start("one"), start("two")], message: "multiple native turns" },
  { events: [header, start("one"), context("other"), complete("one")], message: "no matching launch context" },
  { events: [header, start("one"), context("one"), { ...complete("one"), payload: { ...complete("one").payload, last_agent_message: "wrong" } }], message: "different answer" }
])("rejects invalid completion evidence: $message", ({ events, message }) => {
  expect(() => completedTurn(events)).toThrow(message);
});

it("rejects transcript replacement or truncation across resume", () => {
  expect(() => completedTurn([header], 4)).toThrow("truncated");
});

it("reads only complete persisted events and bounds the synthetic transcript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-transcript-"));
  const file = path.join(root, "transcript.jsonl");
  try {
    expect(await readVerificationTranscript(file)).toEqual([]);
    await fs.writeFile(file, JSON.stringify(header) + '\n{"type":"event_msg"');
    expect(await readVerificationTranscript(file)).toEqual([header]);
    await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(readVerificationTranscript(file)).rejects.toThrow("2 MiB limit");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const filesystem = (workspaceRoots = roots) => `<filesystem><workspace_roots>${workspaceRoots.map(root => `<root>${root}</root>`).join("")}</workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>`;
const worldState = (state: Record<string, unknown>, full = true) => ({ type: "world_state", payload: { full, state } });
const environment = (xml = filesystem()) => ({ environments: { filesystem: xml, environments: { local: { cwd: "/workspace", status: "available" } } } });
const currentContext = { type: "turn_context", payload: { turn_id: "new", cwd: "/workspace", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } };
const currentTurn = (evidence: VerificationTranscriptEvent[]) => [header, start("new"), ...evidence, currentContext, complete("new")];

it("confirms native completion independently while verification still requires filesystem evidence", () => {
  const events = currentTurn([worldState({ model: "changed" }, false)]);
  expect(completedNativeTurn(events, 0, "selected-thread", "answer")).toEqual({ threadId: "selected-thread", turnId: "new", context: currentContext.payload });
  expect(() => completedTurn(events)).toThrow("filesystem evidence");
  expect(() => completedNativeTurn(events, 0, "another-thread", "answer")).toThrow("different selected conversation");
  expect(() => completedNativeTurn(events, 0, "selected-thread", "another answer")).toThrow("different answer");
});

it("reads sanitized Codex 0.166.0 filesystem evidence without turn-context roots", async () => {
  const events = await readVerificationTranscript(new URL("./fixtures/codex-0.166.0-verification.jsonl", import.meta.url).pathname);
  const completed = completedTurn(events);
  expect(completed?.workspaceRoots).toEqual(roots);
  expect(completed?.context).toMatchObject({ cwd: "/workspace", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } });
  expect(completed?.context).not.toHaveProperty("workspace_roots");
});

it("resolves a fresh delta against the previous full state for the completed turn", () => {
  const old = [header, start("old"), worldState(environment(filesystem(["/old"]))), { ...currentContext, payload: { ...currentContext.payload, turn_id: "old" } }, complete("old")];
  const boundary = old.length;
  const events = [...old, start("new"), worldState({ environments: { filesystem: filesystem() } }, false), currentContext, complete("new")];
  expect(completedTurn(events, boundary)?.workspaceRoots).toEqual(roots);
  expect(completedTurn(events, boundary)?.context).toEqual(currentContext.payload);
});

it("keeps unchanged filesystem evidence through a current-turn delta to another section", () => {
  const events = [header, start("old"), worldState(environment()), { ...currentContext, payload: { ...currentContext.payload, turn_id: "old" } }, complete("old")];
  const boundary = events.length;
  events.push(start("new"), worldState({ model: "changed" }, false), currentContext, complete("new"));
  expect(completedTurn(events, boundary)?.workspaceRoots).toEqual(roots);
});

it("reads complete filesystem evidence from a child fork delta without a full world-state baseline", () => {
  const events = currentTurn([worldState({ environments: { filesystem: filesystem() } }, false)]);
  events[0] = { ...header, payload: { ...header.payload, forked_from_id: "parent-thread" } };
  expect(completedTurn(events)?.workspaceRoots).toEqual(roots);
});

it("keeps known filesystem evidence when a delta updates another environment field", () => {
  const events = currentTurn([worldState(environment()), worldState({ environments: { timezone: "Etc/UTC" } }, false)]);
  expect(completedTurn(events)?.workspaceRoots).toEqual(roots);
});

it("decodes XML escapes in native roots without interpreting root-like text elsewhere", () => {
  const xml = filesystem(["/workspace/a&amp;b&lt;c&gt;&quot;&apos;", "&#47;workspace/data/rules-skills"]);
  expect(completedTurn(currentTurn([worldState(environment(xml))]))?.workspaceRoots).toEqual(["/workspace/a&b<c>\"'", roots[1]]);
});

it("preserves CDATA in root text instead of accepting a truncated skills root", () => {
  const xml = filesystem([roots[0]!, `${roots[1]}<![CDATA[/other]]>`]);
  expect(completedTurn(currentTurn([worldState(environment(xml))]))?.workspaceRoots).toEqual([roots[0], `${roots[1]}/other`]);
});

it("returns the observed missing skills root for the runtime contract to reject", () => {
  expect(completedTurn(currentTurn([worldState(environment(filesystem([roots[0]!])))]))?.workspaceRoots).toEqual([roots[0]]);
});

it.each([
  { name: "no current state", evidence: [], message: "current turn" },
  { name: "patch without filesystem evidence", evidence: [worldState({ model: "changed" }, false)], message: "filesystem evidence" },
  { name: "missing full flag", evidence: [{ type: "world_state", payload: { state: environment() } }], message: "Malformed native world state" },
  { name: "invalid state", evidence: [{ type: "world_state", payload: { full: true, state: [] } }], message: "Malformed native world state" },
  { name: "deleted filesystem", evidence: [worldState(environment()), worldState({ environments: { filesystem: null } }, false)], message: "filesystem evidence" },
  { name: "deleted environment", evidence: [worldState(environment()), worldState({ environments: null }, false)], message: "filesystem evidence" },
  { name: "replaced environment", evidence: [worldState(environment()), worldState({ environments: [] }, false)], message: "filesystem evidence" },
  { name: "scalar environment", evidence: [worldState(environment()), worldState({ environments: "changed" }, false)], message: "filesystem evidence" },
  { name: "replaced filesystem", evidence: [worldState(environment()), worldState({ environments: { filesystem: {} } }, false)], message: "filesystem evidence" },
  { name: "full state replaces prior roots", evidence: [worldState(environment()), worldState({ model: "changed" })], message: "filesystem evidence" },
  { name: "compaction clears the baseline", evidence: [worldState(environment()), { type: "compacted", payload: {} }, worldState({ model: "changed" }, false)], message: "filesystem evidence" },
  { name: "malformed XML", evidence: [worldState(environment(filesystem().replace("</filesystem>", "")))], message: "filesystem XML" },
  { name: "wrong XML root", evidence: [worldState(environment("<other>" + filesystem() + "</other>"))], message: "filesystem XML" },
  { name: "roots nested elsewhere", evidence: [worldState(environment("<filesystem><other><workspace_roots><root>/workspace</root></workspace_roots></other></filesystem>"))], message: "workspace roots" },
  { name: "duplicate roots blocks", evidence: [worldState(environment(filesystem().replace("</workspace_roots>", "</workspace_roots><workspace_roots><root>/stale</root></workspace_roots>")))], message: "filesystem XML" },
  { name: "nested root markup", evidence: [worldState(environment(filesystem(["/workspace<other />"])))], message: "filesystem XML" },
  { name: "empty root", evidence: [worldState(environment(filesystem([""])))], message: "workspace roots" },
  { name: "DTD", evidence: [worldState(environment('<!DOCTYPE filesystem [<!ENTITY root "/workspace">]>' + filesystem()))], message: "filesystem XML" }
])("rejects $name", ({ evidence, message }) => {
  expect(() => completedTurn(currentTurn(evidence))).toThrow(message);
});

it("rejects stale state from before the fresh native turn", () => {
  const events = [header, worldState(environment()), start("new"), currentContext, complete("new")];
  expect(() => completedTurn(events, 2)).toThrow("current turn");
});

it("inherits unchanged state only from a completed native turn with a matching context", () => {
  const oldContext = { ...currentContext, payload: { ...currentContext.payload, turn_id: "old" } };
  const baseline = [header, start("old"), worldState(environment()), oldContext, complete("old")];
  const nextTurn = [start("new"), currentContext, complete("new")];
  expect(completedTurn([...baseline, ...nextTurn], baseline.length)?.workspaceRoots).toEqual(roots);
  for (const stale of [baseline.slice(0, -1), baseline.filter(event => event !== oldContext), [...baseline, worldState(environment())], [...baseline, { type: "compacted" }], [...baseline, { type: "event_msg", payload: { type: "thread_rolled_back" } }]]) {
    expect(() => completedTurn([...stale, ...nextTurn], stale.length)).toThrow("current turn");
  }
});

it.each([
  { name: "a later turn never completed", intervening: [start("abandoned"), { ...currentContext, payload: { ...currentContext.payload, turn_id: "abandoned" } }] },
  { name: "a later turn has no matching context", intervening: [start("abandoned"), complete("abandoned")] },
  { name: "a mismatched context follows the baseline context", intervening: [context("other"), complete("old")] }
])("does not inherit a completed baseline after $name", ({ intervening }) => {
  const oldContext = { ...currentContext, payload: { ...currentContext.payload, turn_id: "old" } };
  const baseline = [header, start("old"), worldState(environment()), oldContext, complete("old")];
  const stale = [...baseline, ...intervening];
  expect(() => completedTurn([...stale, start("new"), currentContext, complete("new")], stale.length)).toThrow("current turn");
});

it("does not promote a baseline whose completed turn contains a mismatched context", () => {
  const oldContext = { ...currentContext, payload: { ...currentContext.payload, turn_id: "old" } };
  const stale = [header, start("old"), worldState(environment()), oldContext, context("other"), complete("old")];
  expect(() => completedTurn([...stale, start("new"), currentContext, complete("new")], stale.length)).toThrow("current turn");
});

it("does not use state written after the matching launch context or completion", () => {
  expect(() => completedTurn([header, start("new"), currentContext, worldState(environment()), complete("new")])).toThrow("current turn");
  expect(() => completedTurn([header, start("new"), currentContext, complete("new"), worldState(environment())])).toThrow("current turn");
});

it("rejects mismatched or out-of-order context rather than borrowing its world state", () => {
  expect(() => completedTurn(currentTurn([worldState(environment()), context("other")]))).toThrow("different native turn");
  expect(() => completedTurn([header, currentContext, start("new"), worldState(environment()), complete("new")])).toThrow("no matching launch context");
  expect(completedTurn([header, complete("new"), start("new"), worldState(environment()), currentContext])).toBeUndefined();
});

it("rejects malformed legacy roots instead of switching evidence formats", () => {
  expect(() => completedTurn([header, start("new"), worldState(environment()), { ...context("new"), payload: { ...context("new").payload, workspace_roots: [3] } }, complete("new")])).toThrow("workspace roots");
});
