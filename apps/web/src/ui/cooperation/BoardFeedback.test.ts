// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard, CooperationOperation, CooperationPrecondition, CooperationTarget } from "@cloudx/shared";
import { BoardFeedback, hasFeedbackDrafts, type BoardFeedbackDrafts } from "./BoardFeedback.js";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const target: CooperationTarget = { kind: "item", id: "note" };
const board = (): CooperationBoard => ({ schemaVersion: 1, boardId: "board", title: "Design", revision: 1, status: "active", eventCursor: 0, members: [{ tabId: "agent", providerId: "codex", label: "Architect", role: "responder", assignmentGeneration: 1 }], connections: [], regions: [], reactions: [], threads: [], assets: [], items: [{ id: "note", kind: "note", revision: 1, createdBy: "agent:agent", updatedBy: "agent:agent", geometry: { x: 0, y: 0, width: 300, height: 180, rotation: 0 }, content: { title: "Proposal", blocks: [{ id: "body", revision: 1, text: "Receipt only" }] } }] });
const drafts = (): BoardFeedbackDrafts => ({ compositions: new Map(), replies: new Map(), reactions: new Map() });
const button = (container: Element, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text || button.getAttribute("aria-label") === text)!;
async function fill(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => { const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function setup(scene = board()) {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const store = drafts();
  const onOperations = vi.fn(async (_operations: CooperationOperation[], _options?: { observedPreconditions?: CooperationPrecondition[] }) => true);
  const props = { board: scene, target, inbox: [], readOnly: false, busy: false, drafts: store, onDraftChanged: vi.fn(), onOperations, onThread: vi.fn(), onDeliveryChanged: vi.fn(), refreshKey: 0 };
  const render = async (nextTarget = target, threadId?: string, nextBoard = scene) => act(async () => root.render(createElement(BoardFeedback, { ...props, board: nextBoard, target: nextTarget, threadId, key: `${nextTarget.id}:${threadId ?? "new"}` })));
  await render();
  return { container, store, onOperations, render };
}

describe("retained feedback drafts", () => {
  it("retains category, glyph and description while closing the drawer and discussing another target", async () => {
    const { container, store, render, onOperations } = await setup();
    await act(async () => button(container, "Custom").click());
    await fill(container.querySelector<HTMLInputElement>('input[maxlength="16"]')!, "🔍");
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Feedback description"]')!, "Keep this unfinished review");
    await act(async () => root.render(null));
    await render({ kind: "connection", id: "other" });
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    await render();
    expect(button(container, "Custom").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLInputElement>('input[maxlength="16"]')!.value).toBe("🔍");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep this unfinished review");
    expect(hasFeedbackDrafts(store)).toBe(true);
    expect(onOperations).not.toHaveBeenCalled();
  });
  it("submits an explicit unassigned recipient even when an author and default responder are available", async () => {
    const { container, onOperations } = await setup();
    await fill(container.querySelector<HTMLSelectElement>('select[aria-label="Responder"]')!, "");
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!, "Review this later");
    await act(async () => container.querySelector<HTMLFormElement>("form.cooperation-feedback-compose")!.requestSubmit());
    expect(onOperations).toHaveBeenCalledWith([expect.objectContaining({ kind: "addReaction", recipientTabId: null })]);
  });
  it("labels and prefers the original author after another assigned agent edits the item", async () => {
    const scene = board(); scene.items[0]!.updatedBy = "agent:editor"; scene.members.push({ tabId: "editor", providerId: "claude", label: "Recent editor", assignmentGeneration: 1, role: "observer" });
    const { container } = await setup(scene);
    const responder = container.querySelector<HTMLSelectElement>('select[aria-label="Responder"]')!;
    expect(responder.value).toBe("agent");
    expect(responder.selectedOptions[0]?.textContent).toBe("Architect · author");
  });
  it("retains reply text, sources and responder choice until the exact thread is submitted", async () => {
    const scene = board(); scene.threads = [{ id: "thread", revision: 1, target, status: "open", messages: [{ id: "question", author: "user:local", text: "Replay?", sourceRefs: [] }] }];
    const { container, store, render, onOperations } = await setup(scene);
    await render(target, "thread");
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!, "Unsent answer");
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sources · one per line"]')!, "src/payments.ts:12\nhttps://example.com/spec");
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await fill(container.querySelector<HTMLSelectElement>('select[aria-label="Reply responder"]')!, "");
    await act(async () => root.render(null));
    await render({ kind: "region", id: "different" });
    await render(target, "thread");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!.value).toBe("Unsent answer");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sources · one per line"]')!.value).toContain("payments.ts");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Reply responder"]')!.value).toBe("");
    await act(async () => container.querySelector<HTMLFormElement>("form.cooperation-thread-reply")!.requestSubmit());
    expect(onOperations).toHaveBeenCalledWith([expect.objectContaining({ kind: "appendThreadMessage", threadId: "thread", requestResponse: true, recipientTabId: null, message: expect.objectContaining({ text: "Unsent answer", sourceRefs: ["src/payments.ts:12", "https://example.com/spec"] }) })]);
    expect(hasFeedbackDrafts(store)).toBe(false);
  });
  it("retains reaction edits when the drawer closes and discards them only on Cancel", async () => {
    const scene = board(); scene.reactions = [{ id: "reaction", revision: 1, kind: "idea", glyph: "+", description: "Original", target, author: "user:local" }];
    const { container, render, store } = await setup(scene);
    await act(async () => button(container, "Edit reaction: Original").click());
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!, "Unsent edit");
    await act(async () => root.render(null));
    await render();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("Unsent edit");
    await act(async () => button(container, "Cancel").click());
    expect(hasFeedbackDrafts(store)).toBe(false);
    await act(async () => button(container, "Edit reaction: Original").click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("Original");
  });
  it("starts a reaction edit from its latest saved text after a remote update", async () => {
    const scene = board(); scene.reactions = [{ id: "reaction", revision: 1, kind: "idea", glyph: "+", description: "Original", target, author: "user:local" }];
    const { container, render, onOperations } = await setup(scene);
    const newer = structuredClone(scene); newer.revision = 2; Object.assign(newer.reactions[0]!, { revision: 2, description: "Coworker feedback", glyph: "!" });
    await render(target, undefined, newer);
    await act(async () => button(container, "Edit reaction: Coworker feedback").click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("Coworker feedback");
    await fill(container.querySelector<HTMLInputElement>('input[maxlength="16"]')!, "★");
    await act(async () => button(container, "Save reaction").click());
    expect(onOperations).toHaveBeenCalledWith([{ kind: "updateReaction", reactionId: "reaction", patch: { description: "Coworker feedback", glyph: "★" } }], { observedPreconditions: [{ targetKind: "reaction", targetId: "reaction", expectedRevision: 2 }] });
  });
  it("retains a stale reaction edit through closing the drawer and requires explicit current-record review", async () => {
    const scene = board(); scene.reactions = [{ id: "reaction", revision: 1, kind: "idea", glyph: "+", description: "Original", target, author: "user:local" }];
    const { container, render, onOperations, store } = await setup(scene);
    await act(async () => button(container, "Edit reaction: Original").click());
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!, "My unfinished review");
    const newer = structuredClone(scene); newer.revision = 2; Object.assign(newer.reactions[0]!, { revision: 2, description: "Coworker feedback" });
    await render(target, undefined, newer);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This reaction changed");
    expect(button(container, "Save reaction").disabled).toBe(true);
    await act(async () => root.render(null));
    await render(target, undefined, newer);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("My unfinished review");
    expect(button(container, "Save reaction").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLFormElement>(".cooperation-reaction-row form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onOperations).not.toHaveBeenCalled();
    expect(hasFeedbackDrafts(store)).toBe(true);
    await act(async () => button(container, "Discard draft and load current reaction").click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("Coworker feedback");
    expect(button(container, "Save reaction").disabled).toBe(false);
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!, "Reviewed feedback");
    onOperations.mockResolvedValueOnce(false);
    await act(async () => button(container, "Save reaction").click());
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit reaction"]')!.value).toBe("Reviewed feedback");
    expect(hasFeedbackDrafts(store)).toBe(true);
    expect(onOperations).toHaveBeenLastCalledWith([{ kind: "updateReaction", reactionId: "reaction", patch: { description: "Reviewed feedback", glyph: "+" } }], { observedPreconditions: [{ targetKind: "reaction", targetId: "reaction", expectedRevision: 2 }] });
  });
  it("clears a committed compose draft even if the drawer closes before the save response", async () => {
    const { container, store, onOperations } = await setup();
    let complete!: (saved: boolean) => void;
    onOperations.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!, "Question saving now");
    await act(async () => container.querySelector<HTMLFormElement>("form.cooperation-feedback-compose")!.requestSubmit());
    await act(async () => root.render(null));
    expect(hasFeedbackDrafts(store)).toBe(true);
    await act(async () => complete(true));
    expect(hasFeedbackDrafts(store)).toBe(false);
  });
  it("clears a committed question in a drawer reopened before its original save response", async () => {
    const { container, store, onOperations, render } = await setup();
    let complete!: (saved: boolean) => void;
    onOperations.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!, "Question saving now");
    await act(async () => container.querySelector<HTMLFormElement>("form.cooperation-feedback-compose")!.requestSubmit());
    await act(async () => root.render(null));
    await render();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!.value).toBe("Question saving now");
    await act(async () => complete(true));
    await render();
    expect(hasFeedbackDrafts(store)).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!.value).toBe("");
    expect(onOperations).toHaveBeenCalledOnce();
  });
  it("retains stale-selection text for review and disables new feedback until the target is reattached", async () => {
    const { container, render, onOperations } = await setup();
    await render({ ...target, anchor: { blockId: "body", blockRevision: 1, start: 0, end: 7, exact: "Receipt", prefix: "", suffix: " only", status: "stale" } });
    await fill(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]')!, "Question on the original evidence");
    expect(button(container, "Ask question").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLFormElement>("form.cooperation-feedback-compose")!.requestSubmit());
    expect(onOperations).not.toHaveBeenCalled();
    expect(container.textContent).toContain("choose a new target");
  });
});
