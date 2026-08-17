import { describe, expect, it, vi } from "vitest";

import { labelDelta, reconcileIssueLabels } from "./label-reconciliation.mjs";

describe("managed label reconciliation", () => {
  it("changes only labels present in the controller's stale managed snapshot", async () => {
    const api = {
      repository: "cloudx/project",
      delete: vi.fn(async () => undefined),
      post: vi.fn(async () => undefined),
    };

    await reconcileIssueLabels({
      api,
      number: 42,
      current: ["type:bug", "area:web", "maintainer-label"],
      desired: ["type:bug", "area:server"],
      manages: (label) =>
        label.startsWith("type:") || label.startsWith("area:"),
    });

    expect(api.delete).toHaveBeenCalledWith(
      "/repos/cloudx/project/issues/42/labels/area%3Aweb",
    );
    expect(api.post).toHaveBeenCalledWith(
      "/repos/cloudx/project/issues/42/labels",
      { labels: ["area:server"] },
    );
    expect(api.delete.mock.calls.flat().join(" ")).not.toContain(
      "ai%3Agenerated",
    );
    expect(api.delete.mock.calls.flat().join(" ")).not.toContain(
      "maintainer-label",
    );
  });

  it("does not infer removal of a concurrently added managed label", () => {
    expect(
      labelDelta({
        current: ["type:bug"],
        desired: ["type:bug"],
        manages: () => true,
      }),
    ).toEqual({ add: [], remove: [] });
  });
});
