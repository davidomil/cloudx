import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEFAULT_BACKEND_ORIGIN = "https://127.0.0.1:3001";
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 5173;

export function devBackendOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const origin = env.CLOUDX_DEV_BACKEND_ORIGIN?.trim() || DEFAULT_BACKEND_ORIGIN;
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CLOUDX_DEV_BACKEND_ORIGIN must use http or https.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

export function devBackendWebSocketTarget(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/u, "");
}

export function devWebHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLOUDX_WEB_HOST?.trim() || DEFAULT_WEB_HOST;
}

export function devWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.CLOUDX_WEB_PORT?.trim();
  if (!value) {
    return DEFAULT_WEB_PORT;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("CLOUDX_WEB_PORT must be a positive integer.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("CLOUDX_WEB_PORT must be a valid TCP port.");
  }
  return port;
}

const backendOrigin = devBackendOrigin();
const backendWebSocketTarget = devBackendWebSocketTarget(backendOrigin);

export default defineConfig({
  plugins: [react()],
  server: {
    host: devWebHost(),
    port: devWebPort(),
    strictPort: true,
    proxy: {
      "/api": {
        target: backendOrigin,
        changeOrigin: true,
        secure: false
      },
      "/ws": {
        target: backendWebSocketTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", backendOrigin);
          });
        }
      }
    }
  }
});
