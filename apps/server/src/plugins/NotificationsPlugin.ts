import { randomUUID } from "node:crypto";

import type { CloudxNotification, CloudxNotificationLevel } from "@cloudx/shared";
import type { CreatePluginSessionInput, HookDefinition, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";

export const NOTIFICATIONS_PLUGIN_ID = "notifications";

export class NotificationsPlugin implements WorkspacePlugin {
  readonly id = NOTIFICATIONS_PLUGIN_ID;
  readonly acronym = "NTF";
  readonly displayName = "Notifications";
  readonly description = "Provides automation-visible local notification hooks.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly sent: CloudxNotification[] = [];
  private readonly listeners = new Set<(notification: CloudxNotification) => void>();
  readonly hooks: HookDefinition[] = [
    {
      id: "notifications.send",
      owner: { kind: "plugin", pluginId: NOTIFICATIONS_PLUGIN_ID },
      title: "Send Notification",
      description: "Record a local Cloudx notification for an automation run.",
      exposures: ["plugin", "ui", "http", "automation"],
      automationSafety: "write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short notification title shown in the app." },
          body: { type: "string", description: "Optional notification detail text." },
          level: { type: "string", enum: ["info", "success", "warning", "error"], description: "Notification visual severity.", default: "info" }
        },
        required: ["title"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          notification: {
            type: "object",
            properties: {
              id: { type: "string", description: "Notification id." },
              title: { type: "string", description: "Notification title." },
              body: { type: "string", description: "Notification body text." },
              level: { type: "string", enum: ["info", "success", "warning", "error"], description: "Notification visual severity." },
              at: { type: "string", description: "ISO timestamp when the notification was created." }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      execute: (input) => {
        const notification = {
          id: randomUUID(),
          title: requireString(input.title, "title"),
          body: optionalString(input.body, "body"),
          level: notificationLevel(input.level),
          at: new Date().toISOString()
        } satisfies CloudxNotification;
        this.sent.unshift(notification);
        this.sent.splice(50);
        this.emit(notification);
        return { notification };
      }
    }
  ];

  list(): CloudxNotification[] {
    return [...this.sent];
  }

  onNotification(listener: (notification: CloudxNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: [],
      hooks: this.hooks,
      actions: this.actions
    };
  }

  createSession(_input: CreatePluginSessionInput): PluginSession {
    throw new Error("Notifications cannot be opened as a tab.");
  }

  private emit(notification: CloudxNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, name);
}

function notificationLevel(value: unknown): CloudxNotificationLevel {
  if (value === "success" || value === "warning" || value === "error") {
    return value;
  }
  return "info";
}
