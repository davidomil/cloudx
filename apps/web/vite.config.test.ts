import { describe, expect, it } from "vitest";
import type { ProxyOptions, UserConfig } from "vite";

import config, { devBackendOrigin, devBackendWebSocketTarget, devWebHost, devWebPort } from "./vite.config.js";

describe("Vite dev proxy config", () => {
  it("uses a backend HTTP origin for proxied WebSocket handshakes", () => {
    const wsProxy = ((config as UserConfig).server?.proxy as Record<string, ProxyOptions>)["/ws"]!;
    let proxyReqWs: ((proxyReq: { setHeader(name: string, value: string): void }) => void) | undefined;
    const proxy = {
      on(event: string, handler: typeof proxyReqWs) {
        if (event === "proxyReqWs") {
          proxyReqWs = handler;
        }
      }
    };
    const headers = new Map<string, string>();

    wsProxy.configure?.(proxy as never, wsProxy);
    proxyReqWs?.({ setHeader: (name, value) => headers.set(name, value) });

    expect(wsProxy.target).toBe("wss://127.0.0.1:3001");
    expect(headers.get("origin")).toBe("https://127.0.0.1:3001");
  });

  it("can target an alternate backend and web port for isolated QA", () => {
    const env = {
      CLOUDX_DEV_BACKEND_ORIGIN: "https://127.0.0.1:4301/",
      CLOUDX_WEB_HOST: "127.0.0.1",
      CLOUDX_WEB_PORT: "5178"
    } satisfies Partial<NodeJS.ProcessEnv>;

    const origin = devBackendOrigin(env as NodeJS.ProcessEnv);
    expect(origin).toBe("https://127.0.0.1:4301");
    expect(devBackendWebSocketTarget(origin)).toBe("wss://127.0.0.1:4301");
    expect(devWebHost(env as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    expect(devWebPort(env as NodeJS.ProcessEnv)).toBe(5178);
  });
});
