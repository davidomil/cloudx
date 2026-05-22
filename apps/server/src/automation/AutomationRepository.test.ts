import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AutomationRunSummary, TriggerEvent } from "@cloudx/shared";

import { AutomationRepository } from "./AutomationRepository.js";

describe("AutomationRepository", () => {
  it("round-trips groups, trigger events, and run history", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-"));
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();

    expect(group).toMatchObject({ id: "worktree-bootstrap", enabled: false });

    await repository.setEnabled(group!.id, true);
    await repository.appendTriggerEvent(triggerEvent());
    await repository.saveRun(runSummary(group!.id));

    const nextRepository = new AutomationRepository(dataDir);
    expect((await nextRepository.listGroups())[0]).toMatchObject({ id: group!.id, enabled: true });
    expect((await nextRepository.listRuns())[0]).toMatchObject({ groupId: group!.id, status: "succeeded" });
    await expect(fs.readFile(path.join(dataDir, "automation.json"), "utf8")).resolves.toContain("triggerEvents");
  });
});

function triggerEvent(): TriggerEvent {
  return {
    id: "event-1",
    triggerId: "worktree.created",
    source: { kind: "test" },
    payload: {},
    emittedAt: new Date(0).toISOString()
  };
}

function runSummary(groupId: string): AutomationRunSummary {
  return {
    id: "run-1",
    groupId,
    triggerEventId: "event-1",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    trace: []
  };
}
