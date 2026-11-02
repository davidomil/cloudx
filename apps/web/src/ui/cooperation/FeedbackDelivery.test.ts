// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard, CooperationInboxEvent } from "@cloudx/shared";
import { FeedbackDelivery } from "./FeedbackDelivery.js";
import { BoardMembers } from "./BoardDrawers.js";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const board: CooperationBoard = { schemaVersion: 1, boardId: "board", title: "Design", revision: 1, status: "active", eventCursor: 1, members: [{ tabId: "codex", providerId: "codex", label: "Codex Architect", assignmentGeneration: 1, role: "responder" }], items: [], connections: [], regions: [], reactions: [], threads: [], assets: [] };
const event = (state: CooperationInboxEvent["state"]): CooperationInboxEvent => ({ eventId: "question", sequence: 1, boardId: "board", boardRevision: 1, kind: "question", author: "user:local", target: { kind: "item", id: "note" }, targetRevision: 1, state, recipientTabId: "codex", assignmentGeneration: 1, createdAt: "2026-11-02T00:00:00.000Z" });
async function render(element: ReturnType<typeof createElement>) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root.render(element)); return container; }
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;

describe("addressed native feedback", () => {
  it("reports native unavailability and sends only an explicitly queued event", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/status") ? { tabId: "codex", state: "unavailable", reason: "Original session control channel not ready.", completions: [] } : { deliveries: [{ state: "queued", reason: "The current turn is still running." }] })));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const container = await render(createElement(FeedbackDelivery, { board, event: event("queued"), onChanged }));
    expect(container.textContent).toContain("Original session control channel not ready");
    await act(async () => button(container, "Send now").click());
    expect(fetchMock).toHaveBeenCalledWith("/api/cooperation/boards/board/inbox/send", expect.objectContaining({ method: "POST", body: JSON.stringify({ eventIds: ["question"] }) }));
    expect(container.textContent).toContain("The current turn is still running");
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("requires explicit inspection before redirecting uncertain delivery and never offers resend", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tabId: "codex", state: "unknown", reason: "Native acceptance receipt missing.", completions: [], events: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const container = await render(createElement(FeedbackDelivery, { board, event: event("unknown"), onChanged: vi.fn() }));
    expect(button(container, "Send now")).toBeUndefined();
    await act(async () => button(container, "Redirect feedback").click());
    expect(button(container, "Confirm responder").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button(container, "Confirm responder").click());
    expect(fetchMock).toHaveBeenCalledWith("/api/cooperation/boards/board/inbox/question/redirect", expect.objectContaining({ method: "POST", body: JSON.stringify({ tabId: "codex" }) }));
  });
  it("refreshes an open coworkers drawer from a runtime status epoch without polling", async () => {
    let incomplete = false;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tabId: "codex", state: "nativeAccepted", completions: [], turnStatus: { state: incomplete ? "incomplete" : "running", providerTurnId: "turn", ...(incomplete ? { reason: "The turn ended without a verified board receipt." } : {}) } })));
    vi.stubGlobal("fetch", fetchMock);
    const props = { board, tabs: [], onUpdated: vi.fn(), refreshKey: 0 };
    const container = await render(createElement(BoardMembers, props));
    expect(container.textContent).toContain("turn running");
    incomplete = true;
    await act(async () => root.render(createElement(BoardMembers, { ...props, refreshKey: 1 })));
    expect(container.textContent).toContain("turn incomplete");
    expect(container.textContent).toContain("without a verified board receipt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
