import { describe, expect, it } from "vitest";

import { NotificationsPlugin } from "./NotificationsPlugin.js";

describe("NotificationsPlugin", () => {
  it("defaults omitted notification levels to info", () => {
    const plugin = new NotificationsPlugin();
    const hook = plugin.hooks.find((candidate) => candidate.id === "notifications.send");

    expect(hook).toBeDefined();
    expect(hook!.execute({ title: "Build finished" }, { caller: { kind: "automation" } })).toMatchObject({
      notification: { title: "Build finished", level: "info" }
    });
  });

  it("rejects unknown notification levels instead of hiding them as info", () => {
    const plugin = new NotificationsPlugin();
    const hook = plugin.hooks.find((candidate) => candidate.id === "notifications.send");

    expect(hook).toBeDefined();
    expect(() => hook!.execute({ title: "Build finished", level: "debug" }, { caller: { kind: "automation" } })).toThrow("level must be one of info, success, warning, or error.");
  });
});
