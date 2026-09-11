import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { CreateTabResponse, WorkspaceStateResponse } from "@cloudx/shared";
import { loadConfig } from "./config.js";
import { buildServer, buildServices } from "./server.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import { TerminalBroker } from "./terminal/TerminalBroker.js";
import { terminalSocketPath } from "./terminal/TerminalBrokerProtocol.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";

describe("workspace recovery across server updates", () => {
  it.skipIf(process.platform !== "linux")("reattaches the same shell through the terminal websocket after the web server restarts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-server-recovery-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const shell = path.join(root, "test-shell");
    await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    await fs.mkdir(path.join(root, "project"));
    vi.stubEnv("SHELL", shell);
    const socketPath = terminalSocketPath(config.dataDir);
    const broker = new TerminalBroker(socketPath, new NodePtyTerminalProcessFactory());
    await broker.start();
    let original: FastifyInstance | undefined;
    let restored: FastifyInstance | undefined;
    const sockets: WebSocket[] = [];
    try {
      const originalServices = buildServices(config);
      original = await buildServer(config, originalServices);
      const window = originalServices.workspace!.getActiveWindow();
      const created = await original.inject({
        method: "POST", url: "/api/tabs", headers: { host: "localhost" },
        payload: { pluginId: "standard-terminal", title: "Long running work", cwd: root, windowId: window.id, paneId: window.layout.activePaneId }
      });
      expect(created.statusCode).toBe(201);
      const { tab } = created.json<CreateTabResponse>();
      const before = (await original.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      const terminal = await connectTerminal(original, tab.id, sockets);
      terminal.write("stty -echo; cd project; printf '\\nSHELL_PID=%s;CWD=%s\\n' \"$$\" \"$PWD\"\n");
      await vi.waitFor(() => expect(terminal.output).toMatch(/SHELL_PID=\d+;CWD=/u));
      const pid = Number(/SHELL_PID=(\d+)/u.exec(terminal.output)![1]);
      expect(terminal.output).toContain(`SHELL_PID=${pid};CWD=${root}/project`);
      terminal.write("while [ ! -e ../server-stopped ]; do sleep 0.02; done; printf 'OUTPUT_DURING_UPDATE\\n'\n");

      await original.close();
      expect(() => process.kill(pid, 0)).not.toThrow();
      await fs.writeFile(path.join(root, "server-stopped"), "stopped");
      restored = await buildServer(config);
      const after = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(after).toMatchObject({ activeTabId: tab.id, activeWindowId: before.activeWindowId, windows: before.windows });
      expect(after.tabs).toHaveLength(1);
      expect(after.tabs[0]).toMatchObject({ id: tab.id, title: tab.title, status: "running" });

      const reconnected = await connectTerminal(restored, tab.id, sockets);
      await vi.waitFor(() => expect(reconnected.output).toContain("OUTPUT_DURING_UPDATE"));
      expect(reconnected.output).toContain(`SHELL_PID=${pid};CWD=${root}/project`);
      reconnected.write("printf '\\nRESTORED_PID=%s;CWD=%s\\n' \"$$\" \"$PWD\"\n");
      await vi.waitFor(() => expect(reconnected.output).toContain(`RESTORED_PID=${pid};CWD=${root}/project`));

      const closed = await restored.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
      expect(closed.statusCode).toBe(200);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      const empty = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(empty.tabs).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
      await restored?.close();
      await original?.close();
      await broker.stop();
      vi.unstubAllEnvs();
      await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("restores every tab before serving the original split workspace and retains it through shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-recovery-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const originalServices = buildServices(config);
    const original = await buildServer(config, originalServices);
    let markRestorationStarted!: () => void;
    const restorationStarted = new Promise<void>((resolve) => { markRestorationStarted = resolve; });
    let releaseRestoration!: () => void;
    const continueRestoration = new Promise<void>((resolve) => { releaseRestoration = resolve; });
    let restart: Promise<FastifyInstance> | undefined;
    let restored: FastifyInstance | undefined;
    let client: WebSocket | undefined;
    try {
      const window = originalServices.workspace!.getActiveWindow();
      const first = await originalServices.workspaceCommands!.createTab({
        pluginId: "local-web", cwd: root, title: "Preview",
        initialInput: { url: "http://localhost:4000" },
        windowId: window.id, paneId: window.layout.activePaneId
      });
      const second = await originalServices.workspaceCommands!.createTab({
        pluginId: "local-web", cwd: root, title: "Metrics",
        initialInput: { url: "http://localhost:4001" },
        windowId: window.id, paneId: window.layout.activePaneId,
        newPane: true, splitDirection: "row"
      });
      const before = (await original.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      await original.close();
      expect((await new SessionStateStore(config.dataDir).read())!.sessions.map(({ tab }) => tab.id)).toEqual([first.tab.id, second.tab.id]);

      const restoredServices = buildServices(config);
      const plugin = restoredServices.plugins.get("local-web");
      const createSession = plugin.createSession.bind(plugin);
      vi.spyOn(plugin, "createSession").mockImplementationOnce(async (input) => {
        markRestorationStarted();
        await continueRestoration;
        return createSession(input);
      });
      let acceptingConnections = false;
      restart = buildServer(config, restoredServices).then((app) => {
        acceptingConnections = true;
        return app;
      });
      await restorationStarted;
      expect(acceptingConnections).toBe(false);
      releaseRestoration();
      restored = await restart;
      const after = await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({
        tabs: before.tabs.map(({ id, title, cwd }) => ({ id, title, cwd })),
        activeTabId: before.activeTabId,
        activeWindowId: before.activeWindowId,
        windows: before.windows
      });
      expect(restoredServices.sessions.getSession(first.tab.id).snapshot().state).toMatchObject({ url: "http://localhost:4000/" });

      await restored.listen({ host: "127.0.0.1", port: 0 });
      const address = restored.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      const firstSnapshot = await new Promise<WorkspaceStateResponse & { type: string }>((resolve, reject) => {
        client!.once("message", (data) => resolve(JSON.parse(data.toString())));
        client!.once("error", reject);
      });
      expect(firstSnapshot).toMatchObject({ type: "workspace", activeTabId: before.activeTabId, windows: before.windows });
      expect(firstSnapshot.tabs.map(({ id }) => id)).toEqual([first.tab.id, second.tab.id]);
      const shutdownSnapshots: WorkspaceStateResponse[] = [];
      client.on("message", (data) => shutdownSnapshots.push(JSON.parse(data.toString())));
      await restored.close();
      expect(shutdownSnapshots.every(({ tabs }) => tabs.length === 2)).toBe(true);
      expect((await new SessionStateStore(config.dataDir).read())!.sessions.map(({ tab }) => tab.id)).toEqual([first.tab.id, second.tab.id]);
      expect(JSON.parse(await fs.readFile(path.join(config.dataDir, "workspace.json"), "utf8")).windows).toEqual(before.windows);
    } finally {
      releaseRestoration();
      client?.close();
      await (restored ?? await restart)?.close();
      await original.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function connectTerminal(app: FastifyInstance, tabId: string, sockets: WebSocket[]) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/${tabId}`, { headers: { host: "localhost" } });
  sockets.push(socket);
  let output = "";
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string; data: string };
    if (message.type === "data") output += message.data;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    get output() { return output; },
    write(data: string) { socket.send(JSON.stringify({ type: "input", data })); }
  };
}
