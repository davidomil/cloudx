// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HardwareItem,
  HardwareItemDraft,
  HardwareStateView,
  OperationReceipt,
} from "@cloudx/shared";
import { editableHardware, HardwareEditor } from "./HardwareEditor.js";
import { emptyScript } from "./HardwareControls.js";

const roots: Root[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
const item: HardwareItem = {
  id: "camera",
  revision: 3,
  notesRevision: 1,
  name: "Camera",
  description: "",
  enabled: true,
  physicalResourceId: "rack",
  typeId: "hardware.ssh",
  configVersion: 1,
  config: {
    host: "old.example",
    port: 22,
    username: "root",
    auth: { kind: "password", credentialRefId: "saved-password" },
    connectTimeoutMs: 5000,
  },
  tagIds: [],
  notes: "",
  statuses: [],
  hooks: {},
};
const state: HardwareStateView = {
  revision: 1,
  currentOwner: { kind: "user", userId: "local" },
  readiness: { state: "ready" },
  items: [
    {
      item,
      observations: [],
      reservation: null,
      availability: "available",
      blockers: [],
    },
  ],
  tags: [],
  groups: [{ id: "rack", revision: 1, name: "Rack" }],
  statusDefinitions: [],
  reservations: [],
  checkHolds: [],
  receipts: [],
  history: [],
  types: [
    {
      id: "hardware.ssh",
      ownerPluginId: "hardware",
      apiVersion: 1,
      configVersion: 1,
      displayName: "SSH",
      description: "",
      configSchema: {},
      operations: [],
    },
  ],
};
const checked = {
  online: true,
  itemRevision: item.revision,
  checkedAt: "2026-11-15T00:00:00Z",
  expiresAt: "2200-11-15T00:01:00Z",
};
const success: OperationReceipt = {
  requestId: "check-request",
  runId: "check-run",
  state: "succeeded",
  startedAt: checked.checkedAt,
  result: { hardwareId: item.id, connectionCheck: checked, draft: true },
};
const keyConfig = {
  ...item.config,
  auth: { kind: "identity_file", path: "/home/test/.ssh/cloudx-hardware" },
};
const setupSuccess: OperationReceipt = {
  ...success,
  requestId: "setup-request",
  runId: "setup-run",
  result: { ...success.result, sshKeyConfig: keyConfig },
};

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(
  overrides: Partial<ComponentProps<typeof HardwareEditor>> = {},
) {
  const run = vi.fn().mockResolvedValue(success);
  let props: ComponentProps<typeof HardwareEditor> = {
    item: structuredClone(item),
    state: structuredClone(state),
    held: false,
    busy: false,
    drafts: new Map(),
    run,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const update = async (next: Partial<typeof props>) => {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(HardwareEditor, props)));
  };
  await update({});
  const button = (name: string) => {
    const found = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.trim() === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const input = (label: string) => {
    const found = container.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    );
    expect(found, label).not.toBeNull();
    return found!;
  };
  const fill = async (label: string, value: string) => {
    const field = container.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(`[aria-label="${label}"]`)!;
    expect(field, label).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (name: string) => {
    await act(async () => button(name).click());
  };
  const submit = async () => {
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  };
  return {
    container,
    run,
    input,
    button,
    fill,
    click,
    submit,
    update,
    props: () => props,
  };
}

describe("SSH draft connection checks", () => {
  it.each([
    ["Hardware name", "name", "Offline camera"],
    ["Hardware description", "description", "Waiting for a repair"],
    ["Notes for agents", "notes", "Do not reboot this machine."],
  ])(
    "saves %s without contacting a legacy password machine",
    async (label, field, value) => {
      const ui = await render();
      await ui.fill(label, value);
      expect(ui.button("Save hardware").disabled).toBe(false);
      await ui.click("Save hardware");
      expect(ui.run).toHaveBeenCalledExactlyOnceWith("hardware.items.update", {
        hardwareId: item.id,
        expectedItemRevision: item.revision,
        patch: {
          name: item.name,
          description: item.description,
          notes: item.notes,
          tagIds: item.tagIds,
          enabled: item.enabled,
          [field]: value,
        },
      });
      expect(ui.props().onSaved).toHaveBeenCalledOnce();
    },
  );

  it("can disable and tag a legacy password machine without changing its settings", async () => {
    const ui = await render({
      state: {
        ...state,
        tags: [
          { id: "repair", revision: 1, label: "Needs repair", description: "" },
        ],
      },
    });
    const checkboxes = ui.container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    await act(async () => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    expect(ui.button("Save hardware").disabled).toBe(false);
    await ui.submit();
    expect(ui.run).toHaveBeenCalledExactlyOnceWith("hardware.items.update", {
      hardwareId: item.id,
      expectedItemRevision: item.revision,
      patch: {
        name: item.name,
        description: item.description,
        notes: item.notes,
        tagIds: ["repair"],
        enabled: false,
      },
    });
  });

  it.each<Partial<HardwareItemDraft>>([
    { config: { ...item.config, host: "other.example" } },
    {
      config: {
        ...item.config,
        auth: { kind: "password", credentialRefId: "ssh-registration-new" },
      },
    },
    { physicalResourceId: "another-rack" },
    { configVersion: 2 },
    {
      statuses: [
        {
          revision: 1,
          definitionId: "changed-status",
          source: "manual",
          value: false,
        },
      ],
    },
    { hooks: { beforeReserve: emptyScript() } },
  ])(
    "requires key setup before saving changed password settings (%j)",
    async (changes) => {
      const value = { ...editableHardware(item), ...changes };
      const ui = await render({
        drafts: new Map([
          [item.id, { value, baseRevision: item.revision, newGroupName: "" }],
        ]),
      });
      expect(ui.button("Save hardware").disabled).toBe(true);
      await ui.submit();
      expect(ui.run).not.toHaveBeenCalled();
    },
  );

  it("requires key setup for a typed replacement password even when the saved config is unchanged", async () => {
    const ui = await render();
    await ui.fill("SSH password", "replacement fixture only");
    expect(ui.button("Save hardware").disabled).toBe(true);
    await ui.submit();
    expect(ui.run).not.toHaveBeenCalled();
  });

  it("tests an edited host with an ephemeral password and requires key setup before saving", async () => {
    const fetch = vi.fn(
      async (_url, options) =>
        new Response(
          JSON.stringify({ credentialRefId: String(_url).split("/").at(-1) }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const ui = await render();
    expect(ui.container.textContent).toContain(
      "Leave blank to use the existing password",
    );
    await ui.fill("SSH host", "192.0.2.10");
    await ui.fill("SSH password", "replacement fixture only");
    await ui.click("Test connection");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ui.run).toHaveBeenCalledTimes(1);
    expect(ui.run).toHaveBeenCalledWith("hardware.connection.check", {
      hardwareId: item.id,
      expectedItemRevision: item.revision,
      config: {
        ...item.config,
        host: "192.0.2.10",
        auth: {
          kind: "password",
          credentialRefId: expect.stringMatching(/^ssh-registration-/),
        },
      },
    });
    expect(JSON.stringify(ui.run.mock.calls)).not.toContain(
      "replacement fixture only",
    );
    expect(ui.input("SSH password").value).toBe("");
    const result = ui.container.querySelector(
      '[aria-label="SSH connection test"]',
    );
    expect(result?.textContent).toContain("root@192.0.2.10:22");
    expect(result?.textContent).toContain("Connection succeeded");
    expect(ui.props().onSaved).not.toHaveBeenCalled();
    await ui.submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ui.run).toHaveBeenCalledTimes(1);
    expect(ui.button("Save hardware").disabled).toBe(true);
    expect(ui.container.textContent).toContain(
      "Set up an SSH key before saving",
    );
  });

  it("installs a key for the unsaved endpoint and saves only the verified identity after an explicit save", async () => {
    const editedConfig = { ...keyConfig, host: "192.0.2.10" };
    const run = vi.fn().mockResolvedValue({
      ...setupSuccess,
      result: { ...setupSuccess.result, sshKeyConfig: editedConfig },
    });
    const ui = await render({ run });
    await ui.fill("SSH host", "192.0.2.10");
    await ui.click("Set up SSH key");
    expect(run).toHaveBeenCalledExactlyOnceWith("hardware.ssh.setupKey", {
      hardwareId: item.id,
      expectedItemRevision: item.revision,
      config: { ...item.config, host: "192.0.2.10" },
      credentialRefId: "saved-password",
      timeoutMs: 60000,
    });
    expect(ui.container.textContent).toContain(
      "SSH key installed and login verified",
    );
    expect(ui.input("Identity file reference").value).toBe(
      editedConfig.auth.path,
    );
    expect(ui.props().onSaved).not.toHaveBeenCalled();
    await ui.submit();
    expect(run.mock.calls[1]?.[0]).toBe("hardware.items.update");
    expect(run.mock.calls[1]?.[1].patch.config).toEqual(editedConfig);
  });

  it("waits for setup completion and never accepts another endpoint or an unverified key result", async () => {
    const pending = {
      ...setupSuccess,
      state: "running" as const,
      result: undefined,
    };
    const run = vi.fn().mockResolvedValue(pending);
    const ui = await render({ run });
    await ui.click("Set up SSH key");
    expect(ui.button("Setting up SSH key…").disabled).toBe(true);
    await ui.update({
      state: {
        ...state,
        receipts: [
          {
            ...setupSuccess,
            result: {
              ...setupSuccess.result,
              sshKeyConfig: { ...keyConfig, host: "other.example" },
            },
          },
        ],
      },
    });
    expect(ui.container.textContent).not.toContain(
      "SSH key installed and login verified",
    );
    expect(ui.button("Save hardware").disabled).toBe(false);
    expect(
      ui.container.querySelector<HTMLSelectElement>(
        '[aria-label="SSH authentication"]',
      )!.value,
    ).toBe("password");
    await ui.update({ state: { ...state, receipts: [setupSuccess] } });
    expect(ui.container.textContent).toContain(
      "SSH key installed and login verified",
    );
    expect(ui.button("Save hardware").disabled).toBe(false);
  });

  it.each(["failed", "unknown"] as const)(
    "excludes unchanged password settings from metadata saves after %s setup",
    async (state) => {
      const run = vi.fn().mockResolvedValue({
        ...setupSuccess,
        state,
        error: {
          code: "SETUP_FAILED",
          message: "Inspect the installed key before another attempt.",
        },
      });
      const ui = await render({ run });
      await ui.click("Set up SSH key");
      expect(ui.container.textContent).not.toContain(
        "SSH key installed and login verified",
      );
      expect(ui.button("Save hardware").disabled).toBe(false);
      expect(ui.container.textContent).toContain("Inspect the installed key");
      await ui.submit();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[1].patch).not.toHaveProperty("config");
    },
  );

  it.each([
    { hardwareId: "other-camera" },
    { draft: false },
    { connectionCheck: { ...checked, itemRevision: item.revision + 1 } },
    { connectionCheck: { ...checked, online: false } },
    {
      sshKeyConfig: {
        ...keyConfig,
        auth: { kind: "password", credentialRefId: "wrong" },
      },
    },
    {
      sshKeyConfig: {
        ...keyConfig,
        auth: { kind: "identity_file", path: "relative-key" },
      },
    },
    { sshKeyConfig: { ...keyConfig, username: "another-user" } },
  ])(
    "keeps an unverified setup result out of the draft (%j)",
    async (result) => {
      const run = vi.fn().mockResolvedValue({
        ...setupSuccess,
        result: { ...setupSuccess.result, ...result },
      });
      const ui = await render({ run });
      await ui.click("Set up SSH key");
      expect(ui.button("Save hardware").disabled).toBe(false);
      expect(ui.container.textContent).not.toContain(
        "SSH key installed and login verified",
      );
      await ui.submit();
      expect(run.mock.calls[1]?.[1].patch).not.toHaveProperty("config");
    },
  );

  it("does not apply a setup result after a different item revision arrives", async () => {
    const run = vi.fn().mockResolvedValue({
      ...setupSuccess,
      state: "running",
      result: undefined,
    });
    const ui = await render({ run });
    await ui.click("Set up SSH key");
    await ui.update({
      item: { ...item, revision: item.revision + 1 },
      state: { ...state, receipts: [setupSuccess] },
    });
    expect(ui.container.textContent).not.toContain(
      "SSH key installed and login verified",
    );
    expect(ui.button("Save hardware").disabled).toBe(true);
  });

  it.each(["retained", "failed"] as const)(
    "shows %s password cleanup after saving the verified key",
    async (state) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce(setupSuccess)
        .mockResolvedValueOnce({
          ...success,
          result: {
            passwordRetirement: {
              state,
              reason: "Another saved machine still uses this credential.",
            },
          },
        });
      const ui = await render({ run });
      await ui.click("Set up SSH key");
      await ui.submit();
      expect(ui.props().onSaved).not.toHaveBeenCalled();
      expect(
        ui.container.querySelector('[role="dialog"]')?.textContent,
      ).toContain("The hardware now uses the SSH key.");
      expect(
        ui.container.querySelector('[role="dialog"]')?.textContent,
      ).toContain("Another saved machine still uses this credential.");
      expect(
        ui.container.querySelector('[role="dialog"]')?.textContent,
      ).toContain(
        state === "retained" ? "was retained" : "could not be removed",
      );
      await ui.click("Done");
      expect(ui.props().onSaved).toHaveBeenCalledOnce();
    },
  );

  it("closes after a key save confirms removal of the previous password", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(setupSuccess)
      .mockResolvedValueOnce({
        ...success,
        result: { passwordRetirement: { state: "removed" } },
      });
    const ui = await render({ run });
    await ui.click("Set up SSH key");
    await ui.submit();
    expect(ui.props().onSaved).toHaveBeenCalledOnce();
    expect(ui.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps an accepted receipt pending until a terminal observation arrives and invalidates a result after edits", async () => {
    const pending = {
      ...success,
      state: "running" as const,
      result: undefined,
    };
    const run = vi.fn().mockResolvedValue(pending);
    const ui = await render({ run });
    await ui.click("Test connection");
    expect(ui.button("Testing connection…").disabled).toBe(true);
    expect(ui.container.textContent).not.toContain("Connection succeeded");
    await ui.update({ state: { ...state, receipts: [success] } });
    expect(ui.container.textContent).toContain("Connection succeeded");
    await ui.fill("SSH host", "different.example");
    expect(ui.container.textContent).not.toContain("Connection succeeded");
    expect(ui.container.textContent).toContain("Connection settings changed");
  });

  it("shows a completed failed login and its reason without describing the machine as offline", async () => {
    const run = vi.fn().mockResolvedValue({
      ...success,
      result: {
        connectionCheck: {
          ...checked,
          online: false,
          error: {
            code: "SSH_AUTH_FAILED",
            message: "Password authentication was rejected.",
          },
        },
        draft: true,
        hardwareId: item.id,
      },
    });
    const ui = await render({ run });
    await ui.click("Test connection");
    const result = ui.container.querySelector(
      '[aria-label="SSH connection test"]',
    );
    expect(result?.textContent).toContain("SSH login failed");
    expect(result?.textContent).toContain(
      "Password authentication was rejected.",
    );
    expect(result?.textContent).not.toContain("Connection succeeded");
  });

  it("does not project success from a malformed terminal observation", async () => {
    const run = vi.fn().mockResolvedValue({
      ...success,
      result: { connectionCheck: { ...checked, expiresAt: "not a date" } },
    });
    const ui = await render({ run });
    await ui.click("Test connection");
    expect(ui.container.textContent).not.toContain("Connection succeeded");
    expect(
      ui.container.querySelector('[aria-label="SSH connection test"]')
        ?.textContent,
    ).toContain("No confirmed connection result");
  });

  it("does not project another hardware item's valid result onto the captured target", async () => {
    const run = vi.fn().mockResolvedValue({
      ...success,
      result: { ...success.result, hardwareId: "different-camera" },
    });
    const ui = await render({ run });
    await ui.click("Test connection");
    expect(
      ui.container.querySelector('[aria-label="SSH connection test"]')
        ?.textContent,
    ).toContain("No confirmed connection result");
    expect(ui.container.textContent).not.toContain("Connection succeeded");
  });

  it("keeps an uncertain password write on its original reference until an explicit repeat", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify({ credentialRefId: url.split("/").at(-1) }),
            { status: 200 },
          ),
      );
    vi.stubGlobal("fetch", fetch);
    const ui = await render();
    await ui.fill("SSH password", "uncertain fixture only");
    await ui.click("Test connection");
    expect(ui.run).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).toContain(
      "Explicitly retry this same password",
    );
    await ui.click("Test connection");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe(fetch.mock.calls[0]![0]);
    expect(ui.run).toHaveBeenCalledTimes(1);
  });

  it("opens the exact hold for inspection while still allowing metadata-only save", async () => {
    const checkHold = {
      kind: "system_check" as const,
      runId: "original-check",
      revision: 1,
      generation: 2,
      hardwareId: item.id,
      resourceKeys: [],
      state: "recovery_required" as const,
      bindingRevisions: [],
      connectionCheck: { itemRevision: 3 },
      startedAt: checked.checkedAt,
      recoveryReason: "Inspect cleanup.",
    };
    const onInspectHold = vi.fn();
    const ui = await render({
      held: true,
      onInspectHold,
      state: { ...state, items: [{ ...state.items[0]!, checkHold }] },
    });
    await ui.click("Inspect hold");
    expect(onInspectHold).toHaveBeenCalledExactlyOnceWith(checkHold.runId);
    await ui.fill("Notes for agents", "Keep the connection unchanged.");
    await ui.submit();
    expect(ui.run).toHaveBeenCalledWith("hardware.items.update", {
      hardwareId: item.id,
      expectedItemRevision: item.revision,
      patch: {
        name: item.name,
        description: item.description,
        notes: "Keep the connection unchanged.",
        tagIds: item.tagIds,
        enabled: item.enabled,
      },
    });
  });

  it.each(["failed", "unknown"] as const)(
    "does not show success for a %s receipt",
    async (state) => {
      const run = vi.fn().mockResolvedValue({
        ...success,
        state,
        result: undefined,
        error: {
          code: "CHECK_UNCERTAIN",
          message: "Inspect cleanup before checking again.",
        },
      });
      const ui = await render({ run });
      await ui.click("Test connection");
      expect(ui.container.textContent).not.toContain("Connection succeeded");
      expect(
        ui.container.querySelector('[aria-label="SSH connection test"]')
          ?.textContent,
      ).toContain("Inspect cleanup");
    },
  );

  it("requires saving a new item before testing, while automatic login checks default to 60 seconds", async () => {
    const ui = await render({ item: undefined });
    expect(ui.button("Test connection").disabled).toBe(true);
    expect(ui.container.textContent).toContain(
      "Save this hardware item before testing its connection.",
    );
    expect(ui.input("Enable automatic SSH login checks").checked).toBe(true);
    expect(ui.input("SSH login check interval").value).toBe("60");
    expect(
      ui.container.querySelector<HTMLOptionElement>('option[value="password"]')!
        .disabled,
    ).toBe(true);
    expect(ui.container.textContent).toContain(
      "Save this hardware item before setting up a key with a one-time password.",
    );
    expect(ui.run).not.toHaveBeenCalled();
  });

  it("saves explicit automatic interval changes and null disable without changing the default on an untouched save", async () => {
    const agentItem = {
      ...item,
      config: { ...item.config, auth: { kind: "agent" } },
    };
    const ui = await render({ item: agentItem });
    await ui.submit();
    expect(ui.run.mock.calls[0]?.[1].patch.config).toEqual(agentItem.config);
    await ui.fill("SSH login check interval", "120");
    await ui.submit();
    expect(ui.run.mock.calls[1]?.[1].patch.config.onlineCheckIntervalMs).toBe(
      120000,
    );
    await act(async () =>
      ui.input("Enable automatic SSH login checks").click(),
    );
    await ui.submit();
    expect(
      ui.run.mock.calls[2]?.[1].patch.config.onlineCheckIntervalMs,
    ).toBeNull();
  });

  it.each([
    { held: true },
    { item: { ...item, revision: item.revision + 1 } },
    { busy: true },
  ])(
    "keeps connection testing disabled when held, stale, or busy (%j)",
    async (overrides) => {
      const ui = await render();
      await ui.update(overrides);
      expect(ui.button("Test connection").matches(":disabled")).toBe(true);
      await ui.click("Test connection");
      expect(ui.run).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch the captured check if a hold arrives while its password is being stored", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const ui = await render();
    await ui.fill("SSH password", "pending fixture only");
    await ui.click("Test connection");
    expect(ui.run).not.toHaveBeenCalled();
    await ui.update({ held: true });
    const reference = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0].split("/").at(-1);
    await act(async () =>
      finish(
        new Response(JSON.stringify({ credentialRefId: reference }), {
          status: 200,
        }),
      ),
    );
    expect(ui.run).not.toHaveBeenCalled();
    expect(ui.container.textContent).toContain("held");
  });

  it.each([
    { operation: "testing", action: "hardware.connection.check" },
    { operation: "setup", action: "hardware.ssh.setupKey" },
  ])(
    "uses the latest parent admission after password storage before $operation",
    async ({ operation, action }) => {
      let finish!: (response: Response) => void;
      let credentialRefId = "";
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          credentialRefId = url.split("/").at(-1)!;
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }),
      );
      const ui = await render();
      await ui.fill("SSH password", "deferred fixture only");
      if (operation === "testing") await ui.click("Test connection");
      else await ui.click("Set up SSH key");
      expect(ui.run).not.toHaveBeenCalled();

      const disconnectedRun = vi.fn().mockResolvedValue(undefined);
      await ui.update({ run: disconnectedRun });
      await act(async () =>
        finish(
          new Response(JSON.stringify({ credentialRefId }), { status: 200 }),
        ),
      );

      expect(ui.run).not.toHaveBeenCalled();
      expect(disconnectedRun).toHaveBeenCalledExactlyOnceWith(
        action,
        expect.objectContaining({
          hardwareId: item.id,
          expectedItemRevision: item.revision,
        }),
      );
      expect(ui.props().onSaved).not.toHaveBeenCalled();
      expect(ui.container.textContent).not.toContain("Connection succeeded");
    },
  );
});
