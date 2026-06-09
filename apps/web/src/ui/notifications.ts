import type { CloudxNotification } from "@cloudx/shared";

export type BrowserNotificationPermissionState = "unsupported" | "insecure" | NotificationPermission;

export const NOTIFICATION_HISTORY_LIMIT = 50;
export const NOTIFICATION_TOAST_MS = 8_000;

export function browserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  if (window.isSecureContext === false) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  if (browserNotificationPermissionState() === "unsupported" || browserNotificationPermissionState() === "insecure") {
    return browserNotificationPermissionState();
  }
  return Notification.requestPermission();
}

export function upsertNotification(notifications: CloudxNotification[], notification: CloudxNotification, limit = NOTIFICATION_HISTORY_LIMIT): CloudxNotification[] {
  return [notification, ...notifications.filter((candidate) => candidate.id !== notification.id)].slice(0, limit);
}

export function showBrowserNotification(notification: CloudxNotification): boolean {
  if (browserNotificationPermissionState() !== "granted") {
    return false;
  }
  new Notification(notification.title, {
    body: notification.body,
    tag: notification.id
  });
  return true;
}
