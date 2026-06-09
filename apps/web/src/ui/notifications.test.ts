import { afterEach, describe, expect, it, vi } from "vitest";

import { browserNotificationPermissionState, requestBrowserNotificationPermission, showBrowserNotification, upsertNotification } from "./notifications.js";

describe("notification helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("upserts notifications without exceeding the history limit", () => {
    const at = new Date(0).toISOString();
    expect(upsertNotification([
      { id: "old", title: "Old", level: "info", at },
      { id: "same", title: "Previous", level: "warning", at }
    ], { id: "same", title: "Next", level: "success", at }, 2).map((notification) => notification.title)).toEqual(["Next", "Old"]);
  });

  it("requests browser notification permission only when the API is available in a secure context", async () => {
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("Notification", { permission: "default", requestPermission });

    expect(browserNotificationPermissionState()).toBe("default");
    await expect(requestBrowserNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("creates a browser notification only after permission is granted", () => {
    const notificationConstructor = vi.fn();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("Notification", Object.assign(notificationConstructor, { permission: "granted" }));

    expect(showBrowserNotification({ id: "n1", title: "Build done", body: "Passed", level: "success", at: new Date(0).toISOString() })).toBe(true);
    expect(notificationConstructor).toHaveBeenCalledWith("Build done", { body: "Passed", tag: "n1" });
  });
});
