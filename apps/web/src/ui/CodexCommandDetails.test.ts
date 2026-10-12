// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCommandDetailsSnapshot } from "@cloudx/shared";

const read = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ readCodexCommandDetails: read }));
import { CodexCommandDetails } from "./CodexCommandDetails.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
let showModal: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset();
  read.mockResolvedValue(snapshot());
  showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLButtonElement>("button")?.focus();
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: showModal },
    close: { configurable: true, value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    } }
  });
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fullCommand = "python3 - <<'PY'\n\tprint(\"quoted \\\" text and literal \\n\")\n  print('two spaces')\nPY\n";
function snapshot(overrides: Partial<CodexCommandDetailsSnapshot> = {}): CodexCommandDetailsSnapshot {
  return {
    version: 1, tabId: "alpha", executionId: "alpha-execution", status: "available",
    commands: [{ threadId: "thread-1", turnId: "turn-1", id: "command-1", command: fullCommand, cwd: "/workspace/alpha", status: "inProgress", output: "first line\n\tindented output\n", commandTruncated: false, outputTruncated: false }],
    ...overrides
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function mount(props = { tabId: "alpha", tabTitle: "Codex alpha", active: true }, strict = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (next = props) => {
    await act(async () => {
      const control = createElement(CodexCommandDetails, next);
      root.render(strict ? createElement(StrictMode, {}, control) : control);
    });
  };
  await render();
  const opener = () => container.querySelector<HTMLButtonElement>('[aria-label="Open command details"]')!;
  const open = async () => { await act(async () => { opener().focus(); opener().click(); }); };
  const dialog = () => container.querySelector<HTMLDialogElement>("dialog");
  const command = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Full command"]')!;
  const output = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Command output"]')!;
  return { root, container, render, opener, open, dialog, command, output };
}
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); }

describe("Codex command details", () => {
  it("keeps the summary compact and opens exact read-only command/output with its originating identity", async () => {
    const control = await mount();
    expect(control.dialog()).toBeNull();
    expect(control.container.querySelector(".codex-command-summary")?.textContent).not.toContain("\n");
    expect(control.container.textContent).not.toContain("first line");
    await control.open();
    expect(control.dialog()?.open).toBe(true);
    expect(control.dialog()?.textContent).toContain("Codex alpha");
    expect(control.dialog()?.textContent).toContain("Tab: alpha · Execution: alpha-execution · Command: command-1");
    expect(control.dialog()?.textContent).toContain("Thread: thread-1 · Turn: turn-1");
    expect(control.dialog()?.textContent).toContain("Directory: /workspace/alpha");
    expect(control.command().value).toBe(fullCommand);
    expect(control.output().value).toBe(snapshot().commands[0].output);
    for (const text of [control.command(), control.output()]) {
      expect(text.readOnly).toBe(true);
      expect(text.wrap).toBe("off");
      text.select();
      expect(text.selectionEnd).toBe(text.value.length);
    }
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it("updates continued output without stealing focus or reopening a dismissed dialog", async () => {
    const control = await mount();
    await control.open();
    const dialog = control.dialog();
    control.command().focus();
    const next = snapshot();
    next.commands[0].output += "continued output\n";
    read.mockResolvedValue(next);
    await tick();
    expect(control.dialog()).toBe(dialog);
    expect(control.output().value).toBe(next.commands[0].output);
    expect(document.activeElement).toBe(control.command());
    expect(showModal).toHaveBeenCalledTimes(1);
    await act(async () => control.container.querySelector<HTMLButtonElement>('[aria-label="Close command details"]')!.click());
    expect(control.dialog()).toBeNull();
    expect(document.activeElement).toBe(control.opener());
    await tick();
    expect(control.dialog()).toBeNull();
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it.each(["Escape", "cancel"])("dismisses with %s, consumes the event and restores the trigger", async method => {
    const control = await mount();
    await control.open();
    const outsideKey = vi.fn();
    window.addEventListener("keydown", outsideKey);
    const event = method === "Escape"
      ? new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      : new Event("cancel", { bubbles: false, cancelable: true });
    await act(async () => control.dialog()!.dispatchEvent(event));
    window.removeEventListener("keydown", outsideKey);
    expect(event.defaultPrevented).toBe(true);
    expect(outsideKey).not.toHaveBeenCalled();
    expect(control.dialog()).toBeNull();
    expect(document.activeElement).toBe(control.opener());
  });

  it("opens the most recent command and keeps an open older command associated with its output", async () => {
    const current = snapshot();
    current.commands.push({ ...current.commands[0], id: "command-2", command: "printf 'second'", output: "second output", status: "completed", exitCode: 0 });
    read.mockResolvedValue(current);
    const control = await mount();
    await control.open();
    expect(control.command().value).toBe("printf 'second'");
    expect(control.output().value).toBe("second output");
    expect(control.dialog()?.textContent).toContain("Completed · exit 0");
    await act(async () => control.container.querySelector<HTMLButtonElement>('[aria-label="Close command details"]')!.click());
    const selector = control.container.querySelector<HTMLSelectElement>('[aria-label="Recent Codex commands"]')!;
    await act(async () => { selector.value = selector.options[0].value; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    await control.open();
    expect(control.command().value).toBe(fullCommand);
    const next = snapshot({ commands: [...current.commands, { ...current.commands[0], id: "command-3", command: "third", output: "third output" }] });
    read.mockResolvedValue(next);
    await tick();
    expect(control.command().value).toBe(fullCommand);
    expect(control.output().value).toBe(current.commands[0].output);
  });

  it("closes an old execution instead of replacing its open command with the new execution", async () => {
    const control = await mount();
    await control.open();
    const next = snapshot({ executionId: "new-execution" });
    next.commands[0].command = "new execution command";
    read.mockResolvedValue(next);
    await tick();
    expect(control.dialog()).toBeNull();
    expect(showModal).toHaveBeenCalledTimes(1);
    await control.open();
    expect(control.command().value).toBe("new execution command");
    expect(control.dialog()?.textContent).toContain("new-execution");
  });

  it("invalidates an evicted command so reappearing IDs cannot reopen the popup", async () => {
    const control = await mount();
    await control.open();
    read.mockResolvedValue(snapshot({ commands: [] }));
    await tick();
    expect(control.dialog()).toBeNull();
    read.mockResolvedValue(snapshot());
    await tick();
    expect(control.dialog()).toBeNull();
  });

  it("does not overlap reads and aborts/ignores in-flight work when a tab becomes inactive", async () => {
    const pending = deferred<CodexCommandDetailsSnapshot>();
    read.mockReturnValue(pending.promise);
    const control = await mount();
    const signal = read.mock.calls[0][1] as AbortSignal;
    await tick();
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    await control.render({ tabId: "alpha", tabTitle: "Codex alpha", active: false });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot()));
    expect(control.container.textContent).toBe("");
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("closes inactive dialogs and starts fresh without restoring the old hidden trigger", async () => {
    const control = await mount();
    await control.open();
    const trigger = control.opener();
    const focus = vi.spyOn(trigger, "focus");
    await control.render({ tabId: "alpha", tabTitle: "Codex alpha", active: false });
    expect(control.dialog()).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    await control.render();
    expect(control.dialog()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ignores late responses from a previous tab even when they finish after the new tab", async () => {
    const pending = deferred<CodexCommandDetailsSnapshot>();
    read.mockReturnValueOnce(pending.promise);
    const control = await mount();
    read.mockResolvedValue(snapshot({ tabId: "beta", executionId: "beta-execution" }));
    await control.render({ tabId: "beta", tabTitle: "Codex beta", active: true });
    await act(async () => pending.resolve(snapshot()));
    await control.open();
    expect(control.dialog()?.textContent).toContain("Codex beta");
    expect(control.dialog()?.textContent).toContain("Tab: beta · Execution: beta-execution");
    expect(control.dialog()?.textContent).not.toContain("Tab: alpha");
  });

  it("aborts pending reads on unmount and does not leave timers after late completion", async () => {
    const pending = deferred<CodexCommandDetailsSnapshot>();
    read.mockReturnValue(pending.promise);
    const control = await mount();
    const signal = read.mock.calls[0][1] as AbortSignal;
    await act(async () => control.root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(snapshot()));
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the discarded StrictMode read and leaves a single active polling loop", async () => {
    const control = await mount(undefined, true);
    expect(read).toHaveBeenCalledTimes(2);
    expect((read.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
    await control.open();
    expect(control.command().value).toBe(fullCommand);
  });

  it("labels retained command/output limits explicitly without interpreting escaped or HTML text", async () => {
    const next = snapshot();
    next.commands[0] = { ...next.commands[0], command: "<script>not markup</script>\\n\n\tretained command", output: "<img src=x>\\n\n\tretained output", commandTruncated: true, outputTruncated: true };
    read.mockResolvedValue(next);
    const control = await mount();
    await control.open();
    expect(control.command().value).toBe(next.commands[0].command);
    expect(control.output().value).toBe(next.commands[0].output);
    expect(control.dialog()?.querySelectorAll("script, img")).toHaveLength(0);
    expect(control.dialog()?.textContent).toContain("Command exceeds the retained size limit");
    expect(control.dialog()?.textContent).toContain("Output exceeds the retained size limit");
  });

  it.each(["failed", "declined"] as const)("reports %s status without inventing output", async status => {
    const next = snapshot();
    next.commands[0] = { ...next.commands[0], status, output: "" };
    read.mockResolvedValue(next);
    const control = await mount();
    await control.open();
    expect(control.dialog()?.textContent).toContain(status === "failed" ? "Failed" : "Declined");
    expect(control.output().value).toBe("");
    expect(control.output().placeholder).toBe("No output recorded.");
  });

  it("keeps empty/unavailable captures compact and closes details if capture becomes unavailable", async () => {
    const control = await mount();
    await control.open();
    read.mockResolvedValue(snapshot({ status: "unavailable", executionId: "", commands: [], reason: "Native command capture is not available for this session." }));
    await tick();
    expect(control.dialog()).toBeNull();
    expect(control.container.textContent).toContain("Native command capture is not available");
    expect(control.opener()).toBeNull();
    read.mockResolvedValue(snapshot({ commands: [] }));
    await tick();
    expect(control.container.textContent).toContain("No commands recorded yet.");
  });

  it.each([async () => { throw new Error("private server failure"); }, async () => snapshot({ tabId: "other-tab" })])("invalidates details on failed or misbound reads with a safe error", async response => {
    const control = await mount();
    await control.open();
    read.mockImplementation(response);
    await tick();
    expect(control.dialog()).toBeNull();
    expect(control.container.querySelector('[role="alert"]')?.textContent).toBe("Command details could not be read.");
    expect(control.container.textContent).not.toContain("private server failure");
  });
});
