import { expect, test, type Page, type TestInfo } from "@playwright/test";
import react from "@vitejs/plugin-react";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import type { HardwareAgentReadiness } from "@cloudx/shared";
import { AgentHardwareContext } from "../../apps/server/src/hardware/AgentHardwareContext.js";
import { registerHardwareRoutes } from "../../apps/server/src/hardware/HardwareRoutes.js";
import type { HardwareService } from "../../apps/server/src/hardware/HardwareService.js";
import { HardwareSshPasswords } from "../../apps/server/src/hardware/HardwareSshPasswords.js";
import {
  HardwareBrowserService,
  operator,
  worker,
} from "./fixtures/hardwareService.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let api: FastifyInstance;
let web: ViteDevServer;
let lab: HardwareBrowserService;
let root: string;
let browserUrl: string;
let caseNumber = 0;
let agentReadiness: HardwareAgentReadiness[] = [];
let sshPasswords: HardwareSshPasswords;
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP hardware.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
});

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-hardware-browser-"));
  api = Fastify();
  sshPasswords = new HardwareSshPasswords(root);
  const hardware = {
    snapshot: (...args: Parameters<HardwareService["snapshot"]>) =>
      lab.service.snapshot(...args),
    execute: (...args: Parameters<HardwareService["execute"]>) =>
      lab.service.execute(...args),
  } as HardwareService;
  const contexts = new AgentHardwareContext({
    dataDir: root,
    endpoint: () => "http://127.0.0.1/api/hardware/agent",
    binding: () => (worker.kind === "agent" ? worker : undefined),
  });
  await registerHardwareRoutes(api, hardware, contexts, {
    agentReadiness: async () => agentReadiness,
    sshPasswords,
  });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address();
  if (!address || typeof address === "string")
    throw new Error("Hardware API fixture has no port.");
  web = await createServer({
    configFile: false,
    root: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        "@cloudx/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    },
    optimizeDeps: { entries: ["tests/browser/fixtures/hardware.html"] },
    server: {
      host: "127.0.0.1",
      allowedHosts: ["hardware.test"],
      port: 0,
      strictPort: false,
      proxy: { "/api": `http://127.0.0.1:${address.port}` },
      watch: { ignored: ["**/debug_tooling/**"] },
    },
  });
  await web.listen();
  const webAddress = web.httpServer!.address();
  if (!webAddress || typeof webAddress === "string")
    throw new Error("Hardware web fixture has no port.");
  browserUrl = `http://hardware.test:${webAddress.port}/tests/browser/fixtures/hardware.html`;
});
test.afterAll(async () => {
  await web?.close();
  await api?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  agentReadiness = [];
  lab = new HardwareBrowserService(
    path.join(root, `case-${++caseNumber}`),
    sshPasswords,
  );
  await lab.init();
  await page.goto(browserUrl);
  await expect(
    page.getByRole("button", { name: "Select Atlas SSH", exact: true }),
  ).toBeVisible();
});
test.afterEach(async () => {
  await lab?.service.dispose();
});

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const label = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true });

async function newSsh(page: Page, name: string) {
  await button(page, "Add hardware").click();
  await label(page, "Hardware name").fill(name);
  await label(page, "Physical resource group").selectOption(
    lab.ssh.physicalResourceId,
  );
  await label(page, "SSH host").fill("password.example");
  await label(page, "SSH username").fill("tester");
}

test("SSH authentication: default agent needs no socket or known-hosts path", async ({
  page,
}) => {
  await newSsh(page, "Default-agent SSH");
  await expect(label(page, "SSH authentication")).toHaveValue("agent");
  await expect(label(page, "SSH agent socket")).toHaveCount(0, {
    timeout: 2000,
  });
  await expect(label(page, "Known hosts file")).toHaveCount(0);
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Default-agent SSH")).toBeVisible();
  const item = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.name === "Default-agent SSH",
  )!.item;
  expect(item.config.auth).toEqual({ kind: "agent" });
  expect(item.config.knownHostsFile).toBeUndefined();
});

test("SSH authentication: password saves only an opaque reference and is never restored into a draft", async ({
  page,
}, info) => {
  const writes: string[] = [];
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/hardware/ssh-passwords/")
    )
      writes.push(request.url());
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/hardware/actions")
    )
      actions.push(request.postDataJSON());
  });
  await newSsh(page, "Password SSH");
  await expect(
    label(page, "SSH authentication").locator('option[value="password"]'),
  ).toHaveCount(1, { timeout: 2000 });
  await label(page, "SSH authentication").selectOption("password");
  await label(page, "SSH password").fill("fixture password only");
  await label(page, "SSH authentication").selectOption("agent");
  await label(page, "SSH authentication").selectOption("password");
  await expect(label(page, "SSH password")).toHaveValue("");
  await label(page, "SSH password").fill("fixture password only");
  await button(page, "Back to inventory").click();
  await button(page, "Add hardware").click();
  await expect(label(page, "SSH password")).toHaveValue("");
  await label(page, "SSH password").fill("fixture password only");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Password SSH")).toBeVisible();
  const snapshot = await lab.service.snapshot(operator);
  const config = snapshot.items.find(
    (value) => value.item.name === "Password SSH",
  )!.item.config;
  expect(config.auth).toMatchObject({
    kind: "password",
    credentialRefId: expect.stringMatching(/^ssh-password-/),
  });
  expect(JSON.stringify(snapshot)).not.toContain("fixture password only");
  await button(page, "Select Password SSH").click();
  await button(page, "Edit hardware").click();
  await expect(label(page, "SSH password")).toHaveValue("");
  await expect(
    page.getByText("Password saved on CloudX host", { exact: true }),
  ).toBeVisible();
  await label(page, "SSH password").fill("discarded replacement fixture");
  const savedItem = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.name === "Password SSH",
  )!.item;
  await lab.mutate("hardware.items.update", {
    hardwareId: savedItem.id,
    expectedItemRevision: savedItem.revision,
    patch: { description: "Updated externally" },
  });
  await button(page, "Discard draft and load current item").click();
  await expect(label(page, "SSH password")).toHaveValue("");
  await screenshot(page, info, "08-ssh-password-editor", "SSH password");
  await label(page, "Hardware description").fill("Password reference retained");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Password SSH")).toBeVisible();
  expect(writes).toHaveLength(1);
  await button(page, "Select Password SSH").click();
  await button(page, "Edit hardware").click();
  await label(page, "SSH password").fill("replacement fixture only");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Password SSH")).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(lab.registrations).toHaveLength(0);
  expect(new Set(writes).size).toBe(2);
  const replaced = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.name === "Password SSH",
  )!.item;
  expect(replaced.config.auth).not.toEqual(config.auth);
  await openAccess(page, "Password SSH");
  expect(lab.connections).toContainEqual({
    authKind: "password",
    credentialRefId: (replaced.config.auth as { credentialRefId: string })
      .credentialRefId,
  });
  await expect(button(page, "Register SSH key…")).toBeDisabled();
  await button(page, "Close access").click();
  await expect(button(page, "Register SSH key…")).toBeEnabled();
  await button(page, "Register SSH key…").click();
  await expect(label(page, "SSH registration password")).toHaveValue("");
  await button(page, "Register key").click();
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText("succeeded");
  expect(writes).toHaveLength(2);
  expect(JSON.stringify(actions)).not.toContain("fixture password only");
  expect(JSON.stringify(actions)).not.toContain("fixture only");
  expect(JSON.stringify(await lab.service.snapshot(operator))).not.toContain(
    "fixture only",
  );
});

test("SSH authentication: registration is explicit and available before opening access", async ({
  page,
}, info) => {
  await reserve(page, "Atlas SSH");
  await button(page, "Open access screen").click();
  await expect(button(page, "Register SSH key…")).toBeVisible({
    timeout: 2000,
  });
  await button(page, "Register SSH key…").click();
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toBeVisible();
  await label(page, "SSH registration password").fill(
    "registration fixture only",
  );
  await button(page, "Cancel registration").click();
  expect(lab.registrations).toHaveLength(0);
  expect(
    (await lab.service.snapshot(operator)).receipts.some(
      (value) => value.result?.registered === true,
    ),
  ).toBe(false);
  await button(page, "Register SSH key…").click();
  await expect(label(page, "SSH registration password")).toHaveValue("");
  await label(page, "SSH registration password").fill(
    "registration fixture only",
  );
  await screenshot(page, info, "09-ssh-key-registration");
  await button(page, "Register key").click();
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText("succeeded");
  const snapshot = await lab.service.snapshot(operator);
  expect(
    snapshot.items.find((value) => value.item.id === lab.ssh.id)!.item.config
      .auth,
  ).toMatchObject({ kind: "agent" });
  expect(snapshot.reservations[0]!.accessState).toBe("closed");
  expect(JSON.stringify(snapshot)).not.toContain("registration fixture only");
  expect(lab.registrations).toHaveLength(1);
  expect(lab.registrations[0]).toMatchObject({
    reservationId: snapshot.reservations[0]!.reservationId,
    generation: snapshot.reservations[0]!.generation,
  });
  const temporaryRef = String(lab.registrations[0]!.input.credentialRefId);
  expect(temporaryRef).toMatch(/^ssh-registration-/);
  await expect
    .poll(async () => {
      try {
        await sshPasswords.resolve(temporaryRef);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await label(page, "Fixture theme").selectOption("minimalist-dark");
  await button(page, "Register SSH key…").click();
  await screenshot(page, info, "10-ssh-key-registration-minimal");
  await page.keyboard.press("Escape");
  await expect(button(page, "Register SSH key…")).toBeFocused();
});

test("SSH authentication: a lost password response retries only the same immutable reference explicitly", async ({
  page,
}) => {
  const writes: string[] = [];
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/hardware/actions")
    )
      actions.push(request.postDataJSON());
  });
  await page.route("**/api/hardware/ssh-passwords/*", async (route) => {
    writes.push(route.request().url());
    const response = await route.fetch({
      url: route.request().url().replace("hardware.test", "127.0.0.1"),
    });
    if (writes.length === 1) await route.abort("connectionfailed");
    else await route.fulfill({ response });
  });
  await newSsh(page, "Lost-password SSH");
  await label(page, "SSH authentication").selectOption("password");
  await label(page, "SSH password").fill("lost-response fixture");
  await button(page, "Save hardware").click();
  await expect(page.getByRole("alert")).toContainText(
    "password save response was lost",
  );
  await expect(label(page, "SSH password")).toHaveValue(
    "lost-response fixture",
  );
  expect(actions).toHaveLength(0);
  expect(writes).toHaveLength(1);
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Lost-password SSH")).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(new Set(writes).size).toBe(1);
  expect(actions).toHaveLength(1);
  expect(JSON.stringify(actions)).not.toContain("lost-response fixture");
});

test("SSH authentication: a confirmed password reference survives an item validation failure", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/hardware/ssh-passwords/")
    )
      writes.push(request.url());
  });
  await newSsh(page, "Staged-password SSH");
  await label(page, "SSH host").fill("bad host");
  await label(page, "SSH authentication").selectOption("password");
  await label(page, "SSH password").fill("staged fixture only");
  await button(page, "Save hardware").click();
  await expect(page.getByRole("alert")).toContainText(
    "SSH configuration /host",
  );
  await expect(label(page, "SSH password")).toHaveValue("");
  await expect(
    page.getByText("Password saved on CloudX host", { exact: true }),
  ).toBeVisible();
  await label(page, "SSH host").fill("valid.example");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Staged-password SSH")).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("SSH authentication: lost registration responses inspect the original operation without replay", async ({
  page,
}) => {
  await reserve(page, "Atlas SSH");
  await button(page, "Open access screen").click();
  let requestId = "";
  let dispatched = 0;
  await page.route("**/api/hardware/actions", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== "hardware.ssh.registerKey") return route.continue();
    requestId = body.input.requestId;
    dispatched++;
    expect(JSON.stringify(body)).not.toContain("lost registration fixture");
    const response = await route.fetch({
      url: route.request().url().replace("hardware.test", "127.0.0.1"),
    });
    const result = await response.json();
    await lab.settled(result.result.receipt);
    await route.abort("connectionfailed");
  });
  await button(page, "Register SSH key…").click();
  await label(page, "SSH registration password").fill(
    "lost registration fixture",
  );
  await button(page, "Register key").click();
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("OUTCOME_UNKNOWN");
  await button(page, "Inspect original receipt").click();
  const receipt = page.getByRole("article", { name: "Operation receipt" });
  await expect(receipt.locator("header code")).toHaveText(requestId);
  await expect(receipt).toContainText("succeeded");
  await button(page, "Reconnect").click();
  await expect(button(page, "Register SSH key…")).toBeEnabled();
  expect(dispatched).toBe(1);
  expect(lab.registrations).toHaveLength(1);
});

test("SSH authentication: registration never retargets a replacement reservation during password storage", async ({
  page,
}) => {
  await reserve(page, "Atlas SSH");
  await button(page, "Open access screen").click();
  const original = (await lab.service.snapshot(operator)).reservations[0]!;
  let releaseWrite!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let entered = false;
  const registrations: Record<string, unknown>[] = [];
  await page.route("**/api/hardware/ssh-passwords/*", async (route) => {
    entered = true;
    await gate;
    await route.continue();
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/hardware/actions")
    ) {
      const body = request.postDataJSON();
      if (body.action === "hardware.ssh.registerKey")
        registrations.push(body.input);
    }
  });
  await button(page, "Register SSH key…").click();
  await label(page, "SSH registration password").fill(
    "original reservation fixture",
  );
  await button(page, "Register key").click();
  await expect.poll(() => entered).toBe(true);
  await lab.settled(
    (
      await lab.mutate("hardware.release", {
        reservationId: original.reservationId,
        generation: original.generation,
      })
    ).receipt,
  );
  const replacement = await lab.mutate("hardware.reserve", {
    hardwareId: lab.ssh.id,
    expectedItemRevision: lab.ssh.revision,
    purpose: "Replacement reservation",
  });
  await lab.settled(replacement.receipt);
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toHaveCount(0);
  await button(page, "Register SSH key…").click();
  await expect(label(page, "SSH registration password")).toHaveValue("");
  await button(page, "Cancel registration").click();
  releaseWrite();
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0]).toMatchObject({
    reservationId: original.reservationId,
    generation: original.generation,
  });
  expect(lab.registrations).toHaveLength(0);
  const current = (await lab.service.snapshot(operator)).reservations[0]!;
  expect(current.reservationId).not.toBe(original.reservationId);
  expect(current.accessState).toBe("closed");
});

test("SSH authentication: pending registration blocks duplicate clicks and a known failure keeps access closed", async ({
  page,
}) => {
  let finishRegistration!: () => void;
  lab.registrationGate = new Promise<void>((resolve) => {
    finishRegistration = resolve;
  });
  lab.registrationOutcome = {
    state: "failed",
    effects: "none",
    error: {
      code: "AUTHENTICATION_FAILED",
      message: "The registration password was rejected.",
    },
  };
  await reserve(page, "Atlas SSH");
  await button(page, "Open access screen").click();
  await button(page, "Register SSH key…").click();
  await label(page, "SSH registration password").fill("rejected fixture only");
  await button(page, "Register key").click();
  await expect(button(page, "Registering SSH key…")).toBeDisabled();
  expect(lab.registrations).toHaveLength(1);
  finishRegistration();
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText("AUTHENTICATION_FAILED");
  await expect(button(page, "Register SSH key…")).toBeEnabled();
  const state = await lab.service.snapshot(operator);
  expect(state.reservations[0]!.accessState).toBe("closed");
  expect(state.reservations[0]!.state).toBe("active");
  expect(JSON.stringify(state)).not.toContain("rejected fixture only");
});

test("SSH authentication: existing key login can register without any password write", async ({
  page,
}) => {
  let passwordWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/api/hardware/ssh-passwords/")
    )
      passwordWrites++;
  });
  await reserve(page, "Atlas SSH");
  await button(page, "Open access screen").click();
  await button(page, "Register SSH key…").click();
  await expect(label(page, "SSH registration password")).not.toHaveAttribute(
    "required",
    "",
  );
  await button(page, "Register key").click();
  await expect(
    page.getByRole("dialog", { name: "Register SSH key" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText("succeeded");
  expect(passwordWrites).toBe(0);
  expect(lab.registrations).toHaveLength(1);
  expect(lab.registrations[0]!.input.credentialRefId).toBeUndefined();
});
async function idle(page: Page) {
  await expect(page.locator(".hardware-content")).toBeEnabled();
}
async function refresh(page: Page) {
  await button(page, "Refresh inventory").click();
  await idle(page);
}
async function reserve(page: Page, name: string) {
  await button(page, `Select ${name}`).click();
  await label(page, "Reservation purpose").fill("Browser validation");
  await button(page, "Reserve hardware").click();
  await expect(button(page, "Open access screen")).toBeEnabled();
}
async function openAccess(page: Page, name: string) {
  await reserve(page, name);
  await button(page, "Open access screen").click();
  await expect(
    button(page, name.includes("SSH") ? "Run script" : "Read bytes"),
  ).toBeDisabled();
  await button(page, "Open access").click();
  await expect(
    page.getByText("Managed connection confirmed open", { exact: true }),
  ).toBeVisible();
}
async function screenshot(
  page: Page,
  info: TestInfo,
  name: string,
  focusLabel?: string,
) {
  if (focusLabel) await label(page, focusLabel).scrollIntoViewIfNeeded();
  else
    await page.locator(".hardware-panel").evaluate((element) => {
      element.scrollTop = 0;
    });
  const target = info.outputPath(`${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  await info.attach(name, { path: target, contentType: "image/png" });
}

test("inventory filters, sorting, inspector views and theme tokens work", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(
    await page.evaluate(() => ({
      secure: isSecureContext,
      uuid: typeof crypto.randomUUID,
    })),
  ).toEqual({ secure: false, uuid: "undefined" });
  await label(page, "Find hardware").fill("reboot");
  await expect(button(page, "Select Orion UART")).toHaveCount(0);
  await button(page, "Clear filters").click();
  await label(page, "Filter type").selectOption("hardware.uart");
  await expect(button(page, "Select Atlas SSH")).toHaveCount(0);
  await button(page, "Clear filters").click();
  await label(page, "Filter enabled").selectOption("false");
  await expect(
    page.getByText("No hardware matches these filters", { exact: true }),
  ).toBeVisible();
  await button(page, "Clear filters").click();
  await label(page, "Filter owner").selectOption("me");
  await expect(button(page, "Select Atlas SSH")).toHaveCount(0);
  await button(page, "Clear filters").click();
  await label(page, "Filter availability").selectOption("available");
  await page
    .getByText("Capability and status filters", { exact: true })
    .click();
  const state = await lab.service.snapshot(operator);
  await label(page, "Filter capability tags").selectOption([state.tags[0]!.id]);
  await expect(button(page, "Select Orion UART")).toHaveCount(0);
  await label(page, "Tag matching").selectOption("none");
  await expect(button(page, "Select Atlas SSH")).toHaveCount(0);
  await label(page, "Tag matching").selectOption("any");
  await label(page, "Filter status").selectOption(
    state.statusDefinitions[1]!.id,
  );
  await label(page, "Filter status value").selectOption("false");
  await expect(button(page, "Select Atlas SSH")).toBeVisible();
  await button(page, "Clear filters").click();
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await expect(page.locator(".hardware-row-button").first()).toHaveText(
    "Orion UART",
  );
  await button(page, "Select Atlas SSH").click();
  await button(page, "Notes").click();
  await expect(page.locator(".hardware-notes")).toContainText("Do not reboot");
  await button(page, "Activity").click();
  await expect(
    page.getByText("No activity recorded.", { exact: true }),
  ).toBeVisible();
  await button(page, "Overview").click();
  await button(page, "Refresh statuses").click();
  await idle(page);
  await screenshot(page, info, "01-inventory");
  await label(page, "Fixture theme").selectOption("minimalist-dark");
  await expect(page.locator(".hardware-panel")).toHaveCSS(
    "color",
    "rgb(250, 250, 250)",
  );
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await button(page, "Close item details").click();
  await expect(button(page, "Select Atlas SSH")).toBeFocused();
});

test("catalog create, rename, cancel, delete, schemas and keyboard focus work", async ({
  page,
}, info) => {
  await button(page, "Tags & types").click();
  await button(page, "New tag").click();
  const dialog = page.getByRole("dialog");
  await expect(label(page, "Catalog name")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button(page, "Close dialog")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button(page, "Save tag")).toBeFocused();
  await label(page, "Catalog name").fill("GPU");
  await label(page, "Tag description").fill("Graphics capability");
  await button(page, "Save tag").click();
  await expect(dialog).toHaveCount(0);
  const id = (await lab.service.snapshot(operator)).tags.find(
    (tag) => tag.label === "GPU",
  )!.id;
  await button(page, "Edit tag GPU").click();
  await label(page, "Catalog name").fill("Graphics");
  await button(page, "Save tag").click();
  await expect(button(page, "Edit tag Graphics")).toBeVisible();
  expect(
    (await lab.service.snapshot(operator)).tags.find((tag) => tag.id === id)!
      .label,
  ).toBe("Graphics");
  await button(page, "Edit tag Graphics").click();
  await button(page, "Delete tag").click();
  await button(page, "Keep record").click();
  await button(page, "Delete tag").click();
  await button(page, "Confirm deletion").click();
  await expect(dialog).toHaveCount(0);
  await button(page, "Add group").click();
  await label(page, "Catalog name").fill("Spare rack");
  await button(page, "Save group").click();
  await button(page, "Edit group Spare rack").click();
  await label(page, "Catalog name").fill("Spare lab");
  await button(page, "Save group").click();
  await button(page, "Edit group Spare lab").click();
  await button(page, "Delete group").click();
  await button(page, "Confirm deletion").click();
  await expect(dialog).toHaveCount(0);
  await button(page, "New status definition").click();
  await label(page, "Catalog name").fill("Power");
  await label(page, "Status value type").selectOption("text");
  await label(page, "Status value type").selectOption("enum");
  await label(page, "Enum values").fill("on\noff");
  await button(page, "Save status definition").click();
  await button(page, "Edit status Power").click();
  await label(page, "Catalog name").fill("Power mode");
  await button(page, "Save status definition").click();
  await button(page, "Edit status Power mode").click();
  await button(page, "Delete status definition").click();
  await button(page, "Confirm deletion").click();
  await expect(dialog).toHaveCount(0);
  await button(page, "UART").click();
  await page.getByText("Configuration schema", { exact: true }).click();
  await page
    .getByText("uart.read · input and output schemas", { exact: true })
    .click();
  await expect(
    page.getByText('"durationMs": {', { exact: false }).last(),
  ).toBeVisible();
  await screenshot(page, info, "06-tags-types");
  await button(page, "New tag").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button(page, "New tag")).toBeFocused();
});

test("SSH editor creates, retains, saves and deletes a revision-guarded item", async ({
  page,
}, info) => {
  await button(page, "Add hardware").click();
  await label(page, "Hardware name").fill("New SSH");
  await label(page, "Hardware description").fill("New validation node");
  await label(page, "New group name").fill("New physical target");
  await label(page, "SSH host").fill("new.example");
  await label(page, "SSH port").fill("2222");
  await label(page, "SSH username").fill("tester");
  await label(page, "SSH authentication").selectOption("identity_file");
  await label(page, "Identity file reference").fill(`${lab.root}/identity`);
  await label(page, "SSH connection timeout").fill("4000");
  await label(page, "Capability ARM64").check();
  await label(page, "Notes for agents").fill(
    "Do not reboot. Validate I2C first.",
  );
  await screenshot(page, info, "02-ssh-editor");
  await button(page, "Back to inventory").click();
  await button(page, "Add hardware").click();
  await expect(label(page, "Hardware name")).toHaveValue("New SSH");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select New SSH")).toBeVisible();
  const created = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.name === "New SSH",
  )!.item;
  expect(created.config).toMatchObject({
    host: "new.example",
    port: 2222,
    auth: { kind: "identity_file" },
  });
  await button(page, "Select New SSH").click();
  await button(page, "Edit hardware").click();
  await label(page, "SSH authentication").selectOption("agent");
  await label(page, "Hardware name").fill("Renamed SSH");
  await button(page, "Save hardware").click();
  await expect(button(page, "Select Renamed SSH")).toBeVisible();
  await button(page, "Select Renamed SSH").click();
  await button(page, "Edit hardware").click();
  await button(page, "Delete hardware").click();
  await button(page, "Keep hardware").click();
  await button(page, "Delete hardware").click();
  await button(page, "Confirm hardware deletion").click();
  await expect(button(page, "Select Renamed SSH")).toHaveCount(0);
});

test("UART editor exposes explicit serial settings and cancel discards the draft", async ({
  page,
}) => {
  await button(page, "Add hardware").click();
  await label(page, "Hardware type").selectOption("hardware.uart");
  await label(page, "Hardware name").fill("New UART");
  await label(page, "New group name").fill("UART rack");
  await label(page, "UART device path").fill(`${lab.root}/new-uart`);
  await label(page, "UART baud rate").fill("9600");
  for (const [name, value] of [
    ["UART data bits", "7"],
    ["UART stop bits", "2"],
    ["UART parity", "even"],
    ["UART flow control", "rtscts"],
  ])
    await label(page, name!).selectOption(value!);
  await label(page, "Enabled for new reservations").uncheck();
  await label(page, "Capability Serial").check();
  await button(page, "Save hardware").click();
  await expect(button(page, "Select New UART")).toBeVisible();
  const item = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.name === "New UART",
  )!.item;
  expect(item.config).toMatchObject({
    baudRate: 9600,
    dataBits: 7,
    stopBits: 2,
    parity: "even",
    flowControl: "rtscts",
  });
  expect(item.enabled).toBe(false);
  await button(page, "Select New UART").click();
  await button(page, "Edit hardware").click();
  await label(page, "Hardware name").fill("Discard me");
  await button(page, "Cancel").click();
  await button(page, "Edit hardware").click();
  await expect(label(page, "Hardware name")).toHaveValue("New UART");
});

test("SSH access executes exact scripts, transfers both directions, reloads open access and releases", async ({
  page,
}, info) => {
  await openAccess(page, "Atlas SSH");
  await label(page, "Remote Bash script").fill("exit 7");
  await label(page, "Script deadline").fill("1500");
  await label(page, "Script output limit").fill("2048");
  await button(page, "Run script").click();
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText('"exitCode": 7');
  expect(lab.invocations[0]).toEqual({
    operationId: "ssh.exec",
    input: { script: "exit 7", timeoutMs: 1500, maxOutputBytes: 2048 },
  });
  await label(page, "Local file").fill(`${lab.root}/image.bin`);
  await label(page, "Remote path").fill("/srv/image.bin");
  await label(page, "Transfer deadline").fill("2000");
  await label(page, "Overwrite if file exists").check();
  await button(page, "Upload file").click();
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText('"completed": true');
  await button(page, "Download").click();
  await button(page, "Download file").click();
  await expect
    .poll(
      () =>
        lab.invocations.filter((value) => value.operationId === "ssh.download")
          .length,
    )
    .toBe(1);
  await screenshot(page, info, "07-ssh-access");
  await page.reload();
  await button(page, "Select Atlas SSH").click();
  await button(page, "Open access screen").click();
  await expect(button(page, "Run script")).toBeEnabled();
  await button(page, "Close access").click();
  await expect(button(page, "Run script")).toBeDisabled();
  expect((await lab.service.snapshot(operator)).reservations).toHaveLength(1);
  await button(page, "Open access").click();
  await expect(button(page, "Run script")).toBeEnabled();
  await button(page, "Release hardware").click();
  await expect(
    page.getByText("No active reservation", { exact: true }),
  ).toBeVisible();
  expect((await lab.service.snapshot(operator)).reservations).toEqual([]);
});

test("UART reads bounded windows, writes exact bytes, controls lines, and clears its transcript", async ({
  page,
}, info) => {
  await openAccess(page, "Orion UART");
  await label(page, "Read window").fill("100");
  await label(page, "Read max bytes").fill("64");
  await button(page, "Read bytes").click();
  await expect(label(page, "UART transcript")).toContainText("Boot ready");
  await label(page, "Transmit data").fill("µ help");
  await label(page, "Line ending").selectOption("CRLF");
  await button(page, "Send bytes").click();
  await expect
    .poll(
      () =>
        lab.invocations.filter((value) => value.operationId === "uart.write")
          .length,
    )
    .toBe(1);
  expect(
    Buffer.from(
      String(
        lab.invocations.find((value) => value.operationId === "uart.write")!
          .input.dataBase64,
      ),
      "base64",
    ).toString(),
  ).toBe("µ help\r\n");
  await button(page, "Base64").click();
  await expect(button(page, "Base64")).toHaveClass(/is-selected/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(0, 0);
  for (const theme of ["cloudx-neon", "minimalist-dark"]) {
    await label(page, "Fixture theme").selectOption(theme);
    const colors = await button(page, "Base64").evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      return {
        text: rgba(style.color),
        background: rgba(style.backgroundColor),
      };
    });
    expect(
      colors.text,
      `The selected UART format label is visible in ${theme}`,
    ).not.toEqual(colors.background);
  }
  await label(page, "Fixture theme").selectOption("cloudx-neon");
  await expect(label(page, "Line ending")).toBeDisabled();
  await label(page, "Transmit data").fill("AAE=");
  await button(page, "Send bytes").click();
  await expect
    .poll(
      () =>
        lab.invocations.filter((value) => value.operationId === "uart.write")
          .length,
    )
    .toBe(2);
  expect(
    lab.invocations.filter((value) => value.operationId === "uart.write")[1]!
      .input.dataBase64,
  ).toBe("AAE=");
  await page.getByText("Serial control lines", { exact: true }).click();
  await expect(button(page, "Set lines")).toBeDisabled();
  await label(page, "RTS").selectOption("true");
  await label(page, "DTR").selectOption("false");
  await button(page, "Set lines").click();
  await expect
    .poll(
      () =>
        lab.invocations.filter(
          (value) => value.operationId === "uart.set-lines",
        ).length,
    )
    .toBe(1);
  expect(lab.invocations.at(-1)!.input).toEqual({
    rts: true,
    dtr: false,
    timeoutMs: 5000,
  });
  await screenshot(page, info, "03-uart-access");
  await button(page, "Clear transcript").click();
  await expect(label(page, "UART transcript")).toContainText(
    "No received bytes",
  );
  await label(page, "Transmit data").fill("invalid!");
  await button(page, "Send bytes").click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    lab.invocations.filter((value) => value.operationId === "uart.write"),
  ).toHaveLength(2);
  await button(page, "Text").click();
  await button(page, "Close access").click();
  await expect(button(page, "Read bytes")).toBeDisabled();
});

test("status bindings, exact manual values and real Bash reservation hooks work", async ({
  page,
}, info) => {
  await button(page, "Statuses & hooks").click();
  await label(page, "Configure hardware statuses").selectOption(lab.ssh.id);
  await label(page, "Up value").selectOption("false");
  await page
    .locator(".hardware-observation-row")
    .filter({ has: label(page, "Up value") })
    .getByRole("button", { name: "Set manual value", exact: true })
    .click();
  await idle(page);
  await expect
    .poll(
      async () =>
        (await lab.service.snapshot(operator)).items
          .find((value) => value.item.id === lab.ssh.id)!
          .observations.find(
            (value) => value.definitionId === lab.ssh.statuses[0]!.definitionId,
          )!.value,
    )
    .toBe(false);
  await button(page, "Discard draft and load current configuration").click();
  await label(page, "Up source").selectOption("command");
  await label(page, "Up status command").fill("printf true");
  await label(page, "Up status command working directory").fill(lab.root);
  await label(page, "Up status command deadline").fill("1000");
  await page
    .getByText("Up status command execution limits", { exact: true })
    .click();
  await label(page, "Up status command output limit").fill("4096");
  await label(page, "Up status command credential references").fill("");
  await label(page, "Up maximum age").fill("60000");
  await label(page, "Up check interval").fill("0");
  await label(page, "Require Up for reservation").check();
  await label(page, "Up required value").selectOption("true");
  await page
    .locator(".hardware-status-editor")
    .filter({ hasText: "Busy · manual · boolean" })
    .locator("summary")
    .first()
    .click();
  await button(page, "Remove Busy binding").click();
  const definitions = (await lab.service.snapshot(operator)).statusDefinitions;
  await label(page, "Status definition to add").selectOption(
    definitions.find((value) => value.label === "OS")!.id,
  );
  await button(page, "Add status").click();
  await label(page, "OS manual value").fill("Linux");
  await label(page, "Status definition to add").selectOption(
    definitions.find((value) => value.label === "Health")!.id,
  );
  await button(page, "Add status").click();
  await label(page, "Health manual value").selectOption("ready");
  await label(page, "Enable Before reserve").check();
  await label(page, "Before reserve Bash script").fill(
    "printf prepared > prepared",
  );
  await label(page, "Before reserve Bash script working directory").fill(
    lab.root,
  );
  await label(page, "Before reserve Bash script deadline").fill("1000");
  await page
    .getByText("Before reserve Bash script execution limits", { exact: true })
    .click();
  await label(page, "Before reserve Bash script output limit").fill("2048");
  await label(page, "Enable On release").check();
  await label(page, "On release Bash script").fill(
    "printf released > released",
  );
  await label(page, "On release Bash script working directory").fill(lab.root);
  await button(page, "Inventory").click();
  await button(page, "Statuses & hooks").click();
  await expect(label(page, "Up status command")).toHaveValue("printf true");
  await screenshot(page, info, "04-statuses-hooks");
  await button(page, "Save configuration").click();
  await idle(page);
  await expect(button(page, "Refresh Up")).toBeEnabled();
  await button(page, "Refresh Up").click();
  await expect(
    page
      .locator(".hardware-observation-row")
      .filter({ hasText: "Up" })
      .locator(".hardware-observation"),
  ).toHaveText("true · fresh");
  await button(page, "Inventory").click();
  await reserve(page, "Atlas SSH");
  await expect
    .poll(() => fs.readFile(path.join(lab.root, "prepared"), "utf8"))
    .toBe("prepared");
  await button(page, "Reservations").click();
  await button(page, "Details").click();
  await button(page, "Release own reservation").click();
  await expect
    .poll(
      async () => (await lab.service.snapshot(operator)).reservations.length,
    )
    .toBe(0);
  expect(await fs.readFile(path.join(lab.root, "released"), "utf8")).toBe(
    "released",
  );
});

test("monitor navigates to a Forge worker and requires explicit recovery override", async ({
  page,
}, info) => {
  await lab.mutate(
    "hardware.reserve",
    {
      hardwareId: lab.ssh.id,
      expectedItemRevision: lab.ssh.revision,
      purpose: "Worker validation",
    },
    worker,
  );
  const claim = (await lab.service.snapshot(operator)).reservations[0]!;
  await lab.settled(
    (
      await lab.mutate(
        "hardware.access.open",
        { reservationId: claim.reservationId, generation: claim.generation },
        worker,
      )
    ).receipt,
    worker,
  );
  await lab.settled(
    (
      await lab.mutate(
        "hardware.access.invoke",
        {
          reservationId: claim.reservationId,
          generation: claim.generation,
          operationId: "ssh.exec",
          input: { script: "uncertain", timeoutMs: 1000, maxOutputBytes: 1024 },
        },
        worker,
      )
    ).receipt,
    worker,
  );
  await refresh(page);
  await button(page, "Reservations").click();
  await label(page, "Reservation state filter").selectOption(
    "recovery_required",
  );
  await label(page, "Owned by me").check();
  await expect(
    page.getByText("No matching live reservations", { exact: true }),
  ).toBeVisible();
  await label(page, "Owned by me").uncheck();
  await button(page, "Open owner").click();
  await expect(page.locator("output")).toHaveText(
    "Opened owner: fixture-claude",
  );
  await button(page, "Details").click();
  await expect(button(page, "Release own reservation")).toBeDisabled();
  await expect(label(page, "Hardware retention")).toContainText("30 days");
  await expect(label(page, "Hardware retention")).toContainText(
    "16 MiB result budget",
  );
  await screenshot(page, info, "05-reservations");
  await button(page, "Force release…").click();
  await expect(button(page, "Confirm force release")).toBeDisabled();
  await label(page, "Force release reason").fill(
    "Target inspected; terminate uncertain worker access.",
  );
  await expect(button(page, "Confirm force release")).toBeDisabled();
  await label(page, "I accept unresolved external activity.").check();
  await button(page, "Cancel override").click();
  await button(page, "Force release…").click();
  await label(page, "Force release reason").fill(
    "Target inspected; access revoked.",
  );
  await label(page, "I accept unresolved external activity.").check();
  await button(page, "Confirm force release").click();
  await expect
    .poll(
      async () => (await lab.service.snapshot(operator)).reservations.length,
    )
    .toBe(0);
  await refresh(page);
  await expect(
    page.getByText("No matching live reservations", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".hardware-content details")
    .first()
    .locator("summary")
    .click();
  await expect(
    page.locator(".hardware-content [aria-label='Operation receipt']").first(),
  ).toBeVisible();
});

test("stale item drafts stay on their original revision and held identity fields remain locked", async ({
  page,
}) => {
  await button(page, "Select Atlas SSH").click();
  await button(page, "Edit hardware").click();
  await label(page, "Hardware name").fill("Draft name");
  await lab.mutate("hardware.items.update", {
    hardwareId: lab.ssh.id,
    expectedItemRevision: lab.ssh.revision,
    patch: { notes: "Changed elsewhere" },
  });
  await refresh(page);
  await expect(label(page, "Hardware name")).toHaveValue("Draft name");
  await expect(button(page, "Save hardware")).toBeDisabled();
  await button(page, "Discard draft and load current item").click();
  await expect(label(page, "Notes for agents")).toHaveValue(
    "Changed elsewhere",
  );
  const item = (await lab.service.snapshot(operator)).items.find(
    (value) => value.item.id === lab.ssh.id,
  )!.item;
  await lab.mutate("hardware.reserve", {
    hardwareId: item.id,
    expectedItemRevision: item.revision,
    purpose: "Lock identity",
  });
  await refresh(page);
  await expect(label(page, "SSH host")).toBeDisabled();
  await expect(label(page, "Physical resource group")).toBeDisabled();
  await expect(button(page, "Delete hardware")).toBeDisabled();
  await label(page, "Notes for agents").fill("Changed while reserved");
  await button(page, "Save hardware").click();
  await expect(page.locator(".hardware-notes")).toContainText(
    "Changed while reserved",
  );
  expect((await lab.service.snapshot(operator)).reservations).toHaveLength(1);
});

test("lost mutation responses require reconnect and receipt inspection without replay", async ({
  page,
}) => {
  let releaseObservation!: () => void;
  const observationGate = new Promise<void>((resolve) => {
    releaseObservation = resolve;
  });
  let observing = false;
  await page.route("**/api/hardware/state", async (route) => {
    observing = true;
    await observationGate;
    await route.continue();
  });
  await expect.poll(() => observing).toBe(true);
  await button(page, "Select Atlas SSH").click();
  await label(page, "Reservation purpose").fill("Lost response validation");
  let dispatched = 0;
  await page.route("**/api/hardware/actions", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== "hardware.reserve") {
      await route.continue();
      return;
    }
    dispatched++;
    await route.fetch({
      url: route.request().url().replace("hardware.test", "127.0.0.1"),
    });
    await route.abort("connectionfailed");
  });
  await button(page, "Reserve hardware").click();
  await expect(page.getByRole("alert")).toContainText("OUTCOME_UNKNOWN");
  await expect(button(page, "Reconnect")).toBeEnabled();
  await expect(button(page, "Add hardware")).toBeDisabled();
  expect((await lab.service.snapshot(operator)).reservations).toHaveLength(1);
  const lateObservation = page.waitForResponse((response) =>
    response.url().endsWith("/api/hardware/state"),
  );
  releaseObservation();
  await lateObservation;
  await button(page, "Inspect original receipt").click();
  await expect(
    page.getByRole("article", { name: "Operation receipt" }),
  ).toContainText("succeeded");
  await expect(button(page, "Reconnect")).toBeEnabled();
  await button(page, "Reconnect").click();
  await expect(button(page, "Open access screen")).toBeEnabled();
  expect(dispatched).toBe(1);
  await expect(button(page, "Dismiss hardware error")).toHaveCount(0);
  await button(page, "Open access screen").click();
  await expect(button(page, "Run script")).toBeDisabled();
});

test("failed reads preserve inventory and never fabricate an empty writable state", async ({
  page,
}) => {
  await page.route("**/api/hardware/state", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_UNAVAILABLE",
        message: "Fixture maintenance",
      }),
    }),
  );
  await button(page, "Refresh inventory").click();
  await expect(page.getByRole("alert")).toContainText("Fixture maintenance");
  await expect(button(page, "Select Atlas SSH")).toBeVisible();
  await expect(button(page, "Select Atlas SSH")).toBeDisabled();
  await expect(button(page, "Add hardware")).toBeDisabled();
  await page.unroute("**/api/hardware/state");
  await button(page, "Reconnect").click();
  await expect(button(page, "Select Atlas SSH")).toBeEnabled();
  await page.route("**/api/hardware/state", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ revision: 99 }),
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Hardware state is invalid",
  );
  await expect(button(page, "Add hardware")).toBeDisabled();
  await expect(
    page.getByText("Hardware inventory unavailable", { exact: true }),
  ).toBeVisible();
});

test("an external catalog reference cannot be deleted through the UI", async ({
  page,
}) => {
  await button(page, "Tags & types").click();
  await button(page, "Edit tag ARM64").click();
  await button(page, "Delete tag").click();
  await button(page, "Confirm deletion").click();
  await expect(page.getByRole("alert")).toContainText("IN_USE");
  await button(page, "Cancel").click();
  await button(page, "Inspect original receipt").click();
  await expect(page.getByRole("alert")).toContainText(
    "No receipt is recorded for this request.",
  );
  expect(
    (await lab.service.snapshot(operator)).tags.some(
      (tag) => tag.label === "ARM64",
    ),
  ).toBe(true);
  await button(page, "Dismiss hardware error").click();
});

test("AI helper readiness explains relaunch needs and only opens available owners", async ({
  page,
}) => {
  agentReadiness = [
    {
      tabId: "fixture-claude",
      providerId: "claude",
      executionId: "execution-1",
      state: "relaunch_required",
      reason: "Existing process has no Hardware helper environment.",
    },
    {
      tabId: "removed-tab",
      providerId: "codex",
      state: "unavailable",
      reason: "Execution identity is unavailable.",
    },
    {
      tabId: "ready-tab",
      providerId: "codex",
      executionId: "ready-1",
      state: "ready",
    },
  ];
  await refresh(page);
  await page
    .getByText("2 AI executions need Hardware attention", { exact: true })
    .click();
  const readiness = page.locator(".hardware-agent-readiness");
  await expect(readiness).toContainText(
    "Existing process has no Hardware helper environment.",
  );
  await expect(readiness).toContainText("Relaunch required");
  await expect(
    readiness.getByRole("button", { name: "Open owner", exact: true }).nth(1),
  ).toBeDisabled();
  await readiness
    .getByRole("button", { name: "Open owner", exact: true })
    .first()
    .click();
  await expect(page.locator("output")).toHaveText(
    "Opened owner: fixture-claude",
  );
  await expect(button(page, "Add hardware")).toBeEnabled();
  agentReadiness = [];
  await refresh(page);
  await expect(readiness).toHaveCount(0);
});

test("checking holds show exact targets and stale force-release dialogs cannot clear replacement claims", async ({
  page,
}) => {
  const definitionId = lab.ssh.statuses[0]!.definitionId;
  await lab.mutate("hardware.items.update", {
    hardwareId: lab.ssh.id,
    expectedItemRevision: lab.ssh.revision,
    patch: {
      statuses: [
        {
          revision: 2,
          definitionId,
          source: "command",
          script: {
            source:
              "while [ ! -f check-finish ]; do sleep 0.02; done; printf true",
            cwd: lab.root,
            timeoutMs: 10000,
            maxOutputBytes: 4096,
            credentialRefIds: [],
          },
          maxAgeMs: 60000,
          intervalMs: null,
        },
      ],
    },
  });
  await refresh(page);
  await button(page, "Select Atlas SSH").click();
  await button(page, "Refresh statuses").click();
  await expect
    .poll(async () => (await lab.service.snapshot(operator)).checkHolds.length)
    .toBe(1);
  await expect(button(page, "Reserve hardware")).toBeDisabled();
  await button(page, "Reservations").click();
  await label(page, "Reservation state filter").selectOption("checking");
  await button(page, "Details").click();
  await expect(
    page.getByRole("cell", { name: "System check", exact: true }),
  ).toBeVisible();
  await button(page, "Force release…").click();
  await label(page, "Force release reason").fill(
    "Inspect completed check before override",
  );
  const oldHold = (await lab.service.snapshot(operator)).checkHolds[0]!;
  await expect(page.getByRole("dialog")).toContainText(oldHold.runId);
  await fs.writeFile(path.join(lab.root, "check-finish"), "done");
  await expect(page.getByRole("dialog")).toContainText("This hold changed.");
  await expect(button(page, "Confirm force release")).toBeDisabled();
  await button(page, "Cancel override").click();
  await button(page, "Inventory").click();
  await reserve(page, "Atlas SSH");
  await button(page, "Reservations").click();
  await label(page, "Reservation state filter").selectOption("active");
  await button(page, "Details").click();
  await button(page, "Force release…").click();
  await label(page, "Force release reason").fill(
    "Operator completed local validation",
  );
  await expect(
    label(page, "I accept unresolved external activity."),
  ).toHaveCount(0);
  await button(page, "Confirm force release").click();
  await expect
    .poll(
      async () => (await lab.service.snapshot(operator)).reservations.length,
    )
    .toBe(0);
});

test("preparation remains visibly held until its Bash hook completes", async ({
  page,
}) => {
  await lab.mutate("hardware.items.update", {
    hardwareId: lab.ssh.id,
    expectedItemRevision: lab.ssh.revision,
    patch: {
      hooks: {
        beforeReserve: {
          source: "while [ ! -f prepare-finish ]; do sleep 0.02; done",
          cwd: lab.root,
          timeoutMs: 10000,
          maxOutputBytes: 4096,
          credentialRefIds: [],
        },
      },
    },
  });
  await refresh(page);
  await button(page, "Select Atlas SSH").click();
  await label(page, "Reservation purpose").fill(
    "Wait for controlled preparation",
  );
  await button(page, "Reserve hardware").click();
  await expect(
    page.locator(".hardware-badge.state-preparing").first(),
  ).toBeVisible();
  await expect(button(page, "Open access screen")).toBeDisabled();
  await button(page, "Reservations").click();
  await label(page, "Reservation state filter").selectOption("preparing");
  await button(page, "Details").click();
  await expect(button(page, "Release own reservation")).toBeDisabled();
  await fs.writeFile(path.join(lab.root, "prepare-finish"), "done");
  await label(page, "Reservation state filter").selectOption("active");
  await expect(button(page, "Release own reservation")).toBeEnabled();
  await button(page, "Release own reservation").click();
  await expect
    .poll(
      async () => (await lab.service.snapshot(operator)).reservations.length,
    )
    .toBe(0);
});

test("shared group aliases open the originally reserved type and never issue mismatched access operations", async ({
  page,
}) => {
  await lab.mutate("hardware.items.update", {
    hardwareId: lab.uart.id,
    expectedItemRevision: lab.uart.revision,
    patch: { physicalResourceId: lab.ssh.physicalResourceId },
  });
  await refresh(page);
  await reserve(page, "Atlas SSH");
  await button(page, "Close item details").click();
  await button(page, "Select Orion UART").click();
  await expect(page.locator(".hardware-inspector")).toContainText(
    "This group is held through Atlas SSH.",
  );
  await button(page, "Open access screen").click();
  await expect(
    page.getByRole("heading", { name: "Atlas SSH / SSH", exact: true }),
  ).toBeVisible();
  await expect(button(page, "Read bytes")).toHaveCount(0);
  await button(page, "Open access").click();
  await expect(button(page, "Run script")).toBeEnabled();
  await label(page, "Remote Bash script").fill("uname -m");
  await button(page, "Run script").click();
  await expect
    .poll(() => lab.invocations.map((value) => value.operationId))
    .toEqual(["ssh.exec"]);
});

test("review: deleting the selected status definition reconciles Inventory without a crash or stale filter", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const definition = (
    await lab.service.snapshot(operator)
  ).statusDefinitions.find((value) => value.label === "Health")!;
  await page
    .getByText("Capability and status filters", { exact: true })
    .click();
  await label(page, "Filter status").selectOption(definition.id);
  await expect(label(page, "Filter status value")).toHaveValue("ready");
  await lab.mutate("hardware.statuses.delete", {
    id: definition.id,
    expectedRevision: definition.revision,
  });
  await button(page, "Refresh inventory").click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".hardware-panel") ||
      (
        document.querySelector(
          '[aria-label="Filter status"]',
        ) as HTMLSelectElement | null
      )?.value === "",
  );
  expect(errors).toEqual([]);
  await expect(label(page, "Filter status")).toHaveValue("");
  await expect(label(page, "Filter status value")).toHaveCount(0);
  await expect(button(page, "Select Atlas SSH")).toBeVisible();
  await expect(button(page, "Select Orion UART")).toBeVisible();
  await label(page, "Find hardware").fill("Orion");
  await expect(button(page, "Select Orion UART")).toBeVisible();
});

test("review: editing existing hardware creates and assigns a new group in one revision-guarded update", async ({
  page,
}) => {
  const before = await lab.service.snapshot(operator);
  const writes: Array<{ action: string; input: Record<string, unknown> }> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/hardware/actions")
    )
      writes.push(request.postDataJSON());
  });
  await button(page, "Select Atlas SSH").click();
  await button(page, "Edit hardware").click();
  await label(page, "Physical resource group").selectOption("");
  await label(page, "New group name").fill("Dedicated Atlas");
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/hardware/actions") &&
      response.request().postDataJSON().action === "hardware.items.update",
  );
  await button(page, "Save hardware").click();
  expect(await (await response).json()).toMatchObject({
    result: { receipt: { state: "succeeded" } },
  });
  await expect(button(page, "Select Atlas SSH")).toBeVisible();
  const after = await lab.service.snapshot(operator);
  const group = after.groups.find((value) => value.name === "Dedicated Atlas")!;
  const item = after.items.find((value) => value.item.id === lab.ssh.id)!.item;
  expect(after.groups).toHaveLength(before.groups.length + 1);
  expect(group.id).not.toBe(lab.ssh.physicalResourceId);
  expect(item).toMatchObject({
    physicalResourceId: group.id,
    revision: lab.ssh.revision + 1,
  });
  expect(
    after.groups.some((value) => value.id === lab.ssh.physicalResourceId),
  ).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    action: "hardware.items.update",
    input: {
      hardwareId: lab.ssh.id,
      expectedItemRevision: lab.ssh.revision,
      newGroupName: "Dedicated Atlas",
    },
  });
  expect(writes[0]!.input.patch).not.toHaveProperty("physicalResourceId");
});

test("review: inspected lost SSH invoke receipts replace the older result in Access without replay", async ({
  page,
}) => {
  await openAccess(page, "Atlas SSH");
  await label(page, "Remote Bash script").fill("exit 7");
  await button(page, "Run script").click();
  const receipt = page.getByRole("article", { name: "Operation receipt" });
  await expect(receipt).toContainText('"exitCode": 7');
  const previousId = await receipt.locator("header code").textContent();
  let finishInvoke!: () => void;
  lab.invokeGate = new Promise<void>((resolve) => {
    finishInvoke = resolve;
  });
  let lostRequestId = "";
  let dispatched = 0;
  await page.route("**/api/hardware/actions", async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.action !== "hardware.access.invoke" ||
      body.input.input.script !== "uname -m"
    ) {
      await route.continue();
      return;
    }
    lostRequestId = body.input.requestId;
    dispatched++;
    const response = await route.fetch({
      url: route.request().url().replace("hardware.test", "127.0.0.1"),
    });
    const result = await response.json();
    const pending = await lab.service.snapshot(operator);
    await expect(page.locator(".hardware-footer")).toContainText(
      `revision ${pending.revision}`,
    );
    finishInvoke();
    await lab.settled(result.result.receipt);
    await route.abort("connectionfailed");
  });
  await label(page, "Remote Bash script").fill("uname -m");
  await button(page, "Run script").click();
  await expect(page.getByRole("alert")).toContainText("OUTCOME_UNKNOWN");
  await expect(receipt).toHaveCount(0);
  await button(page, "Inspect original receipt").click();
  await expect(receipt.locator("header code")).toHaveText(lostRequestId);
  await expect(receipt).toContainText('"exitCode": 0');
  await expect(receipt).toContainText("aarch64");
  await expect(receipt).not.toContainText(previousId!);
  expect(dispatched).toBe(1);
  expect(lab.invocations).toHaveLength(2);
  await button(page, "Reconnect").click();
  await expect(button(page, "Run script")).toBeEnabled();
  await label(page, "Remote Bash script").fill("exit 7");
  await button(page, "Run script").click();
  await expect(receipt).toContainText('"exitCode": 7');
  await expect(receipt.locator("header code")).not.toHaveText(lostRequestId);
  expect(dispatched).toBe(1);
  expect(lab.invocations).toHaveLength(3);
});
