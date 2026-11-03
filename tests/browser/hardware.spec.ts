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
  lab = new HardwareBrowserService(path.join(root, `case-${++caseNumber}`));
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
async function screenshot(page: Page, info: TestInfo, name: string) {
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
  await label(page, "Known hosts file").fill(`${lab.root}/known_hosts`);
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
  await label(page, "SSH agent socket").fill(`${lab.root}/new-agent.sock`);
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
