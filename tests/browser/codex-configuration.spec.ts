import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { CodexGlobalSettings } from "../../packages/shared/src/codexSettings.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let server: ViteDevServer;
let httpServer: Server;
let baseUrl: string;

test.beforeAll(async () => {
  httpServer = createHttpServer();
  server = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    server: { middlewareMode: { server: httpServer }, ws: false },
    optimizeDeps: {
      entries: ["tests/browser/fixtures/codex-configuration.html"],
    },
  });
  httpServer.on("request", server.middlewares);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  baseUrl = `http://127.0.0.1:${address.port}/tests/browser/fixtures/codex-configuration.html`;
});

test.afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => (error ? reject(error) : resolve())),
  );
});

const quickAliases = [
  {
    field: "model",
    family: "model",
    label: "Default model",
    initial: "gpt-6.1-sol",
    quick: "gpt-6-sol",
    native: "gpt-6-astra",
  },
  {
    field: "serviceTier",
    family: "service_tier",
    label: "Fast mode",
    initial: "priority",
    quick: "default",
    native: "flex",
  },
  {
    field: "reasoningEffort",
    family: "model_reasoning_effort",
    label: "Reasoning effort",
    initial: "low",
    quick: "high",
    native: "xhigh",
  },
  {
    field: "webSearch",
    family: "web_search",
    label: "Web search",
    initial: "cached",
    quick: "live",
    native: "disabled",
  },
  {
    field: "personality",
    family: "personality",
    label: "Personality",
    initial: "friendly",
    quick: "none",
    native: "none",
  },
] as const;

async function openFixture(
  page: Page,
  selectedProfile = "writing",
  initialQuickDefaults = false,
  selectedVersion = "0.162.1",
) {
  const settings: CodexGlobalSettings = {
    revision: "a".repeat(64),
    model: null,
    serviceTier: null,
    fastModeEnabled: null,
    yoloMode: true,
    autoTrustWorkspace: false,
    configProfile: selectedProfile || null,
    defaultSkills: [],
    reasoningEffort: null,
    webSearch: null,
    personality: null,
    configuration: {
      selectedVersion: "0.162.1",
      baselineVersion: "0.162.1",
      selectedCommand: "/isolated/bin/codex",
      sourcePath: "/isolated/codex/config.toml",
      blockedReason: null,
      targetProfile: null,
      profileFiles: ["writing"],
      values: {
        model_verbosity: "medium",
        tui: { resume_cwd: "current", notifications: false },
      },
      effectiveValues: {
        model_verbosity: selectedProfile ? "high" : "medium",
        tui: { resume_cwd: "current", notifications: false },
      },
      overrides: selectedProfile
        ? ["The selected writing profile overrides model_verbosity."]
        : [],
      layers: [
        "Shared user config",
        "Selected writing profile",
        "Project config",
        "CloudX launch arguments",
      ],
    },
  };
  if (initialQuickDefaults)
    for (const alias of quickAliases) {
      settings[alias.field] = alias.initial;
      settings.configuration!.values[alias.family] = alias.initial;
    }
  settings.configuration!.selectedVersion = selectedVersion;
  const profiles: Record<string, CodexGlobalSettings> = {};
  const profileSettings = (name: string) =>
    (profiles[name] ??= {
      ...structuredClone(settings),
      revision: "c".repeat(64),
      model: null,
      serviceTier: null,
      reasoningEffort: null,
      webSearch: null,
      personality: null,
      configuration: {
        ...structuredClone(settings.configuration!),
        targetProfile: name,
        sourcePath: `/isolated/codex/${name}.config.toml`,
        values: name === "writing" ? { model_verbosity: "high" } : {},
        effectiveValues: name === "writing" ? { model_verbosity: "high" } : {},
        overrides: [],
      },
    });
  const updates: Array<Record<string, unknown>> = [];
  let rejectNextSave = false;
  let revision = 1;
  await page.route("**/api/hooks/*", async (route) => {
    const hook = decodeURIComponent(route.request().url().split("/").at(-1)!);
    const input = route.request().postDataJSON().input;
    if (hook === "codex-settings.update") {
      const target = input.targetProfile
        ? profileSettings(input.targetProfile)
        : settings;
      updates.push(input);
      if (rejectNextSave) {
        rejectNextSave = false;
        await route.fulfill({
          status: 409,
          json: {
            error: "Shared Codex settings changed. Reload before saving again.",
          },
        });
        return;
      }
      expect(input.expectedRevision).toBe(target.revision);
      const values = target.configuration!.values;
      for (const [key, value] of Object.entries(input.nativeOptions ?? {})) {
        if (value === null) delete values[key];
        else values[key] = value as (typeof values)[string];
      }
      for (const alias of quickAliases) {
        const value =
          input[alias.field] === undefined
            ? input.nativeOptions?.[alias.family]
            : input[alias.field];
        if (value === undefined) continue;
        target[alias.field] = value;
        if (value === null) delete values[alias.family];
        else values[alias.family] = value;
      }
      target.revision = String(++revision).repeat(64);
      target.configuration!.effectiveValues = structuredClone(values);
      if (
        input.targetProfile &&
        !settings.configuration!.profileFiles!.includes(input.targetProfile)
      )
        settings.configuration!.profileFiles!.push(input.targetProfile);
      if (input.configProfile !== undefined)
        settings.configProfile = input.configProfile;
      await route.fulfill({ json: { result: { settings: target } } });
      return;
    }
    const result =
      hook === "codex-settings.read"
        ? {
            settings: input.targetProfile
              ? profileSettings(input.targetProfile)
              : settings,
          }
        : hook === "codex-config-repair.read"
          ? {
              repair: {
                revision: settings.revision,
                sourceConfigPath: "/isolated/codex/config.toml",
                selectedCommand: "/isolated/bin/codex",
                selectedVersion: "0.162.1",
                changes: [],
                canApply: false,
                blockedReason: null,
              },
            }
          : hook === "codex-update.releases"
            ? {
                releases: {
                  latestStable: "0.162.1",
                  versions: [{ version: "0.162.1", prerelease: false }],
                },
              }
            : {
                update: {
                  jobId: null,
                  phase: "idle",
                  installedVersion: "0.162.1",
                  requestedVersion: null,
                  activeVersion: "0.162.1",
                  previousVersion: null,
                  outcome: null,
                  message: "Ready",
                  startedAt: null,
                  finishedAt: null,
                },
              };
    await route.fulfill({ json: { result } });
  });
  await page.goto(baseUrl);
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeEnabled();
  return {
    settings,
    profiles,
    updates,
    rejectSave: () => {
      rejectNextSave = true;
    },
  };
}

test("searches grouped native settings, saves nested values, reloads and unsets a default", async ({
  page,
}, testInfo) => {
  const { settings, updates } = await openFixture(page);
  const panel = page.getByRole("region", { name: "Global Codex settings" });
  const search = page.getByRole("searchbox", { name: "Search Codex options" });
  const save = page.getByRole("button", { name: "Save Codex settings" });
  await expect(panel).toContainText("/isolated/codex/config.toml");
  await expect(panel).toContainText("Selected writing profile");
  await expect(panel).toContainText("overrides model_verbosity");
  await search.fill("model_verbosity");
  const verbosity = page.getByRole("textbox", {
    name: "Native model_verbosity",
    exact: true,
  });
  await expect(verbosity).toHaveValue('"medium"');
  await expect(
    page.getByRole("textbox", { name: "Native tui", exact: true }),
  ).toHaveCount(0);
  await verbosity.fill('"high"');
  await save.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Global Codex settings saved." }),
  ).toBeVisible();
  expect(updates[0]).toEqual({
    expectedRevision: "a".repeat(64),
    nativeOptions: { model_verbosity: "high" },
  });

  await search.fill("resume_cwd");
  const terminal = page.getByRole("textbox", {
    name: "Native tui",
    exact: true,
  });
  await expect(terminal).toBeVisible();
  const nested = {
    resume_cwd: "session",
    notifications: ["agent-turn-complete"],
    mouse_scroll_speed: 1.5,
  };
  await terminal.fill(JSON.stringify(nested, null, 2));
  await save.click();
  await expect(save).toBeDisabled();
  expect(updates[1]).toMatchObject({ nativeOptions: { tui: nested } });
  await terminal.fill('{"resume_cwd":"current"}');
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(terminal).toHaveValue(JSON.stringify(nested, null, 2));
  await terminal.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("saved-native-tui.png") });
  await page.getByRole("button", { name: "Unset tui", exact: true }).click();
  await save.click();
  await expect(save).toBeDisabled();
  expect(updates[2]).toMatchObject({ nativeOptions: { tui: null } });
  expect(settings.configuration!.values).not.toHaveProperty("tui");
  await page.screenshot({
    path: testInfo.outputPath("grouped-codex-options.png"),
  });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await testInfo.attach("browser-version", {
    body: page.context().browser()!.version(),
    contentType: "text/plain",
  });
});

test("keeps synchronized model edits in their selected profile and reloads the base draft when switching targets", async ({
  page,
}) => {
  const { settings, profiles, updates } = await openFixture(page, "", true);
  const target = page.getByRole("combobox", { name: "Configuration target" });
  const quick = page.getByRole("textbox", {
    name: "Default model",
    exact: true,
  });
  await quick.fill("unsaved-base-model");
  await target.selectOption("writing");
  await expect(quick).toHaveValue("");
  await page
    .getByRole("searchbox", { name: "Search Codex options" })
    .fill("model");
  const native = page.getByRole("textbox", {
    name: "Native model",
    exact: true,
  });
  await expect(native).toHaveValue("");
  await quick.fill("gpt-6-sol");
  await native.fill('"gpt-6-astra"');
  await expect(quick).toHaveValue("gpt-6-astra");
  await page.getByRole("button", { name: "Save Codex settings" }).click();
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeEnabled();
  expect(updates[0]).toEqual({
    expectedRevision: "c".repeat(64),
    targetProfile: "writing",
    model: "gpt-6-astra",
  });
  expect(profiles.writing.model).toBe("gpt-6-astra");
  expect(settings.model).toBe("gpt-6.1-sol");
  await quick.fill("discarded-profile-model");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(quick).toHaveValue("gpt-6-astra");
  await expect(native).toHaveValue('"gpt-6-astra"');
  await target.selectOption("");
  await expect(quick).toHaveValue("gpt-6.1-sol");
  await expect(native).toHaveValue('"gpt-6.1-sol"');
  await expect(
    page.getByRole("button", { name: "Save Codex settings" }),
  ).toBeDisabled();
});

test("creates a separate native profile and selects it for new launches without changing base defaults", async ({
  page,
}) => {
  const { settings, profiles, updates } = await openFixture(page, "");
  await page
    .getByRole("textbox", { name: "New profile name" })
    .fill("planning");
  await page.getByRole("button", { name: "Edit profile", exact: true }).click();
  const target = page.getByRole("combobox", { name: "Configuration target" });
  await expect(target).toHaveValue("planning");
  await expect(
    page.getByRole("checkbox", { name: "YOLO mode" }),
  ).toBeDisabled();
  await page
    .getByRole("searchbox", { name: "Search Codex options" })
    .fill("model_verbosity");
  const verbosity = page.getByRole("textbox", {
    name: "Native model_verbosity",
    exact: true,
  });
  await expect(verbosity).toHaveValue("");
  await verbosity.fill('"low"');
  const save = page.getByRole("button", { name: "Save Codex settings" });
  await save.click();
  await expect(save).toBeDisabled();
  expect(updates[0]).toEqual({
    expectedRevision: "c".repeat(64),
    targetProfile: "planning",
    nativeOptions: { model_verbosity: "low" },
  });
  expect(profiles.planning.configuration!.values.model_verbosity).toBe("low");
  expect(settings.configuration!.values.model_verbosity).toBe("medium");
  await target.selectOption("");
  await expect(verbosity).toHaveValue('"medium"');
  const launch = page.getByRole("combobox", {
    name: "Launch configuration profile",
  });
  await launch.selectOption("planning");
  await save.click();
  await expect(save).toBeDisabled();
  expect(updates[1]).toEqual({
    expectedRevision: "a".repeat(64),
    configProfile: "planning",
  });
  expect(settings.configProfile).toBe("planning");
  expect(settings.configuration!.values.model_verbosity).toBe("medium");
});

test("keeps invalid JSON local and requires reload after a conflicting save", async ({
  page,
}) => {
  const { settings, updates, rejectSave } = await openFixture(page);
  await page
    .getByRole("searchbox", { name: "Search Codex options" })
    .fill("model_verbosity");
  const verbosity = page.getByRole("textbox", {
    name: "Native model_verbosity",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save Codex settings" });
  await verbosity.fill("{");
  await expect(save).toBeDisabled();
  expect(updates).toHaveLength(0);
  await verbosity.fill('"low"');
  rejectSave();
  await save.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Reload before saving again" }),
  ).toBeVisible();
  await expect(verbosity).toHaveValue('"low"');
  settings.configuration!.values.model_verbosity = "high";
  settings.revision = "b".repeat(64);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(verbosity).toHaveValue('"high"');
  await expect(save).toBeDisabled();
  await verbosity.fill('"low"');
  await save.click();
  await expect(save).toBeDisabled();
  expect(updates[1]).toEqual({
    expectedRevision: "b".repeat(64),
    nativeOptions: { model_verbosity: "low" },
  });
});

for (const order of [
  "quick then native",
  "native then quick",
  "native unset",
  "quick unset",
] as const) {
  test(`quick and structured controls share the latest draft through ${order}`, async ({
    page,
  }) => {
    const { settings, updates } = await openFixture(page, "", true);
    const search = page.getByRole("searchbox", {
      name: "Search Codex options",
    });
    const save = page.getByRole("button", { name: "Save Codex settings" });
    for (const alias of quickAliases.filter(
      (alias) => alias.field !== "personality",
    )) {
      await search.fill(alias.family);
      const native = page.getByRole("textbox", {
        name: `Native ${alias.family}`,
        exact: true,
      });
      const quick = page.getByRole(
        alias.field === "model" ? "textbox" : "combobox",
        { name: alias.label, exact: true },
      );
      const quickEdit = async (value: string) =>
        alias.field === "model" ? quick.fill(value) : quick.selectOption(value);
      let latest: string | null;
      if (order === "quick then native" || order === "native unset") {
        await quickEdit(alias.quick);
        await expect(native).toHaveValue(JSON.stringify(alias.quick));
        latest = order === "native unset" ? null : alias.native;
        if (latest === null)
          await page
            .getByRole("button", { name: `Unset ${alias.family}`, exact: true })
            .click();
        else await native.fill(JSON.stringify(latest));
      } else {
        await native.fill(JSON.stringify(alias.native));
        await expect(quick).toHaveValue(alias.native);
        latest = order === "quick unset" ? null : alias.quick;
        await quickEdit(latest ?? "");
      }
      await expect(quick).toHaveValue(latest ?? "");
      await expect(native).toHaveValue(
        latest === null ? "" : JSON.stringify(latest),
      );
      await search.fill("notifications");
      await save.click();
      await expect(save).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Reload", exact: true }),
      ).toBeEnabled();
      expect(updates.at(-1)).toEqual({
        expectedRevision:
          updates.length === 1
            ? "a".repeat(64)
            : String(updates.length).repeat(64),
        [alias.field]: latest,
      });
      expect(settings[alias.field]).toBe(latest);
      await search.fill(alias.family);
      await page.getByRole("button", { name: "Reload", exact: true }).click();
      await expect(quick).toHaveValue(latest ?? "");
      await expect(native).toHaveValue(
        latest === null ? "" : JSON.stringify(latest),
      );
    }
  });
}

for (const version of ["0.160.0", "0.162.1"]) {
  test(`labels deprecated ignored fields and OS-specific nested options for Codex ${version}`, async ({
    page,
  }) => {
    await openFixture(page, "", true, version);
    const search = page.getByRole("searchbox", {
      name: "Search Codex options",
    });
    await search.fill("features.multi_agent_v2.usage_hint_enabled");
    await page
      .getByText("Nested options for features", { exact: true })
      .click();
    const ignored = page.getByRole("listitem").filter({
      has: page.locator("code", {
        hasText: /^features\.multi_agent_v2\.usage_hint_enabled$/,
      }),
    });
    await expect(ignored).toContainText("deprecated");
    await expect(ignored).toContainText("value is ignored");
    await search.fill("computer_use");
    await page
      .getByText("Nested options for computer_use", { exact: true })
      .click();
    for (const platform of ["macos", "windows"]) {
      const options = page.getByRole("listitem").filter({
        has: page.locator("code", {
          hasText: new RegExp(`^computer_use\\.${platform}(?:\\.|$)`),
        }),
      });
      expect(await options.count()).toBeGreaterThan(1);
      for (const option of await options.all())
        await expect(option).toContainText(`· ${platform}`);
    }
    await search.fill("personality");
    await expect(
      page.getByRole("textbox", { name: "Native personality", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("group", {
        name: "personality · deprecated · all",
        exact: true,
      }),
    ).toContainText("no longer select a communication style");
    const personality = page.getByRole("combobox", {
      name: "Personality",
      exact: true,
    });
    await personality.selectOption("none");
    await page.getByRole("button", { name: "Save Codex settings" }).click();
    await expect(personality).toHaveValue("none");
    await personality.selectOption("");
    await page.getByRole("button", { name: "Save Codex settings" }).click();
    await expect(
      page.getByRole("button", { name: "Save Codex settings" }),
    ).toBeDisabled();
    await expect(personality).toHaveValue("");
  });
}

test("saves provider-native model strings outside the quick API contract without conflicting aliases", async ({
  page,
}) => {
  const { settings, updates } = await openFixture(page, "", true);
  const quick = page.getByRole("textbox", {
    name: "Default model",
    exact: true,
  });
  await page
    .getByRole("searchbox", { name: "Search Codex options" })
    .fill("model");
  const native = page.getByRole("textbox", {
    name: "Native model",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save Codex settings" });
  for (const model of ["local/model@preview", "x".repeat(129)]) {
    await quick.fill("gpt-6-sol");
    await native.fill(JSON.stringify(model));
    await expect(quick).toHaveValue(model);
    await expect(quick).not.toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page.getByRole("button", { name: "Reload", exact: true }),
    ).toBeEnabled();
    expect(updates.at(-1)).toEqual({
      expectedRevision:
        updates.length === 1
          ? "a".repeat(64)
          : String(updates.length).repeat(64),
      nativeOptions: { model },
    });
    expect(settings.model).toBe(model);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(quick).toHaveValue(model);
    await expect(native).toHaveValue(JSON.stringify(model));
  }
  await native.fill('"local/model@preview"');
  await quick.fill("gpt-6-astra");
  await save.click();
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeEnabled();
  expect(updates.at(-1)).toEqual({
    expectedRevision: "3".repeat(64),
    model: "gpt-6-astra",
  });
});
