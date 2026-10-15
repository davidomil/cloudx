import { expect, it, vi } from "vitest";

const { CodexResumeTimings } = await import(new URL("../../helpers/codex-resume-timings.mjs", import.meta.url).href);

it("measures preparation, initialization, sparse backend pages and first usable rows without retaining protocol content", () => {
  const save = vi.fn();
  let now = 100;
  const timings = new CodexResumeTimings(save, 15.2, () => now);
  timings.record("native_spawned");
  timings.fromClient({ id: 1, method: "initialize", params: { secret: "private-credential" } });
  now = 120;
  timings.fromServer({ id: 1, result: { user: "private-user" } });
  timings.fromClient({ id: 2, method: "thread/list", params: { searchTerm: "private-query" } });
  for (let page = 0; page < 8; page++) {
    now++;
    timings.fromServer({ id: 2, result: { data: [{ preview: "private-transcript" }] } }, false);
  }
  now = 140;
  timings.fromServer({ id: 2, result: { data: [{ id: "private-identity", preview: "private-prompt" }] } });
  const events = save.mock.calls.map(([line]) => JSON.parse(line.slice("CloudX resume timing ".length)));
  expect(events).toEqual(expect.arrayContaining([
    { event: "launch_prepared", elapsedMs: 0, durationMs: 15 },
    { event: "native_initialized", elapsedMs: 20, durationMs: 20, failed: false },
    { event: "first_list_requested", elapsedMs: 20 },
    { event: "list_page", elapsedMs: 40, backendPages: 9, requestPages: 9, durationMs: 20, rows: 1, indexed: false, delivered: true, failed: false },
    { event: "first_usable_rows", elapsedMs: 40, backendPages: 9, rows: 1 }
  ]));
  expect(save.mock.calls.flat().join("")).not.toContain("private-");
  expect(timings.pending.size).toBe(0);
});

it("bounds events and pending requests, records failure and releases cancelled picker state", () => {
  const save = vi.fn();
  const timings = new CodexResumeTimings(save, NaN, () => 10);
  for (let id = 0; id < 50; id++) timings.fromClient({ id, method: "thread/list" });
  expect(timings.pending.size).toBe(32);
  timings.fromServer({ id: 0, error: { message: "private-native-error" } });
  expect(save.mock.calls.at(-1)![0]).toContain('"failed":true');
  timings.disconnected();
  expect(timings.pending.size).toBe(0);
  for (let index = 0; index < 300; index++) timings.record("native_spawned");
  expect(save).toHaveBeenCalledTimes(256);
});
