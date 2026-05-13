import type { FastifyReply } from "fastify";
import WebSocketClient, { type RawData, type WebSocket } from "ws";

import { LOCAL_WEB_PLUGIN_ID } from "./plugins/LocalWebPlugin.js";
import type { SessionStore } from "./sessionStore.js";

const HOP_BY_HOP_HEADERS = new Set(["connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const STRIPPED_SECURITY_HEADERS = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options"]);
const ROOT_LITERAL_PREFIX_PATTERN = /(["'`])\/(?!\/|api\/local-web\/)(@vite\/|@react-refresh\b|@fs\/|@id\/|src\/|node_modules\/|assets\/|knowledge-graph\.json|domain-graph\.json|diff-overlay\.json|meta\.json|fingerprints\.json|file-content\.json|intermediate\/|favicon\.svg)/g;

export class LocalWebProxy {
  constructor(private readonly sessions: SessionStore) {}

  async handle(tabId: string, proxiedPath: string | undefined, requestUrl: string | undefined, reply: FastifyReply): Promise<void> {
    const targetBaseUrl = this.readTargetUrl(tabId);
    const targetUrl = resolveTargetUrl(targetBaseUrl, proxiedPath ?? "", requestUrl ?? "");
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        redirect: "follow",
        headers: {
          accept: "*/*"
        }
      });
    } catch (error) {
      reply.code(502).type("text/html; charset=utf-8").send(renderProxyError(targetUrl, error));
      return;
    }

    copyResponseHeaders(response, reply);
    reply.code(response.status);

    const contentType = response.headers.get("content-type") ?? "";
    const body = Buffer.from(await response.arrayBuffer());
    if (contentType.includes("text/html")) {
      reply.type(contentType).send(rewriteHtml(body.toString("utf8"), tabId, targetUrl));
      return;
    }
    if (isJavascriptContent(contentType, targetUrl)) {
      reply.type(contentType || "text/javascript; charset=utf-8").send(rewriteJavascript(body.toString("utf8"), tabId, targetUrl));
      return;
    }
    if (contentType.includes("text/css")) {
      reply.type(contentType).send(rewriteCss(body.toString("utf8"), tabId, targetUrl));
      return;
    }

    reply.send(body);
  }

  handleWebSocket(tabId: string, requestUrl: string | undefined, protocols: string[] | undefined, client: WebSocket): void {
    const targetBaseUrl = this.readTargetUrl(tabId);
    const targetUrl = resolveTargetWebSocketUrl(targetBaseUrl, requestUrl ?? "");
    const upstream = new WebSocketClient(targetUrl, protocols);
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];

    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocketClient.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => {
      if (client.readyState === WebSocketClient.OPEN || client.readyState === WebSocketClient.CONNECTING) {
        client.close(code, reason);
      }
    });
    upstream.on("error", () => {
      if (client.readyState === WebSocketClient.OPEN || client.readyState === WebSocketClient.CONNECTING) {
        client.close(1011, "Local web websocket proxy failed.");
      }
    });

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocketClient.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (upstream.readyState === WebSocketClient.CONNECTING) {
        pending.push({ data, isBinary });
      }
    });
    client.on("close", () => {
      if (upstream.readyState === WebSocketClient.OPEN || upstream.readyState === WebSocketClient.CONNECTING) {
        upstream.close();
      }
    });
    client.on("error", () => {
      if (upstream.readyState === WebSocketClient.OPEN || upstream.readyState === WebSocketClient.CONNECTING) {
        upstream.close();
      }
    });
  }

  private readTargetUrl(tabId: string): string {
    const session = this.sessions.getSession(tabId);
    if (session.tab.pluginId !== LOCAL_WEB_PLUGIN_ID) {
      throw new Error(`Tab ${tabId} is not a local web tab.`);
    }
    const url = session.snapshot().state?.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error(`Local web tab ${tabId} has no URL configured.`);
    }
    return url;
  }
}

export function localWebProxyPath(tabId: string, targetUrl: string): string {
  const target = new URL(targetUrl);
  const path = target.pathname.replace(/^\/+/, "");
  const normalizedPath = path ? `/${path}` : "/";
  return `/api/local-web/${encodeURIComponent(tabId)}/proxy${normalizedPath}${target.search}${target.hash}`;
}

function resolveTargetUrl(targetBaseUrl: string, proxiedPath: string, requestUrl: string): string {
  const base = new URL(targetBaseUrl);
  const request = new URL(requestUrl || "/proxy/", "https://cloudx.local");
  const path = proxiedPath.trim() ? `/${proxiedPath.replace(/^\/+/, "")}` : base.pathname || "/";
  const target = new URL(base.origin);
  target.pathname = path;
  target.search = request.search || (path === base.pathname ? base.search : "");
  return target.href;
}

function resolveTargetWebSocketUrl(targetBaseUrl: string, requestUrl: string): string {
  const base = new URL(targetBaseUrl);
  const request = new URL(requestUrl || "/proxy-ws/", "https://cloudx.local");
  const target = new URL(base.origin);
  target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = base.pathname || "/";
  target.search = request.search;
  return target.href;
}

function copyResponseHeaders(response: Response, reply: FastifyReply): void {
  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_SECURITY_HEADERS.has(lower)) {
      continue;
    }
    reply.header(name, value);
  }
  reply.header("cache-control", "no-store");
}

function rewriteHtml(html: string, tabId: string, targetUrl: string): string {
  const prefix = proxyBasePath(tabId, targetUrl);
  const withBase = html.includes("<head")
    ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${escapeAttribute(prefix)}">`)
    : `<base href="${escapeAttribute(prefix)}">${html}`;
  return rewriteRootAbsoluteReferences(withBase, tabId, targetUrl);
}

function rewriteCss(css: string, tabId: string, targetUrl: string): string {
  const prefix = proxyOriginPath(tabId);
  return css.replace(/url\((["']?)\/(?!\/|api\/local-web\/)([^)"']+)\1\)/g, (_match, quote: string, path: string) => `url(${quote}${prefix}/${path}${quote})`);
}

function rewriteRootAbsoluteReferences(input: string, tabId: string, targetUrl: string): string {
  const prefix = proxyOriginPath(tabId);
  return input
    .replace(/((?:src|href|action)=["'])\/(?!\/|api\/local-web\/)/gi, `$1${prefix}/`)
    .replace(ROOT_LITERAL_PREFIX_PATTERN, `$1${prefix}/$2`);
}

function rewriteJavascript(input: string, tabId: string, targetUrl: string): string {
  const rewritten = rewriteDynamicRootReferences(rewriteRootAbsoluteReferences(input, tabId, targetUrl), tabId);
  if (new URL(targetUrl).pathname !== "/@vite/client") {
    return rewritten;
  }
  return rewriteViteClientHmr(rewritten, tabId);
}

function rewriteDynamicRootReferences(input: string, tabId: string): string {
  return input.replaceAll("const path = `/${fileName}`;", `const path = \`${proxyOriginPath(tabId)}/\${fileName}\`;`);
}

function rewriteViteClientHmr(input: string, tabId: string): string {
  const websocketPath = `${proxyWebSocketPath(tabId)}/`;
  const proxySocketHost = `const socketHost = \`\${null || importMetaUrl.hostname}:\${hmrPort || importMetaUrl.port}\${${JSON.stringify(websocketPath)}}\`;`;
  return input
    .replace('const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`;', proxySocketHost)
    .replaceAll('const base = "/" || "/";', `const base = ${JSON.stringify(proxyOriginPath(tabId) + "/")} || "/";`)
    .replaceAll('const base$1 = "/" || "/";', `const base$1 = ${JSON.stringify(proxyOriginPath(tabId) + "/")} || "/";`);
}

function proxyBasePath(tabId: string, targetUrl: string): string {
  const target = new URL(targetUrl);
  const pathname = target.pathname.endsWith("/") ? target.pathname : target.pathname.slice(0, target.pathname.lastIndexOf("/") + 1);
  const path = pathname.replace(/^\/+/, "");
  return `${proxyOriginPath(tabId)}${path ? `/${path}` : "/"}`;
}

function proxyOriginPath(tabId: string): string {
  return `/api/local-web/${encodeURIComponent(tabId)}/proxy`;
}

function proxyWebSocketPath(tabId: string): string {
  return `/api/local-web/${encodeURIComponent(tabId)}/proxy-ws`;
}

function isJavascriptContent(contentType: string, targetUrl: string): boolean {
  if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
    return true;
  }
  return new URL(targetUrl).pathname.endsWith(".js") || new URL(targetUrl).pathname.endsWith(".mjs") || new URL(targetUrl).pathname.endsWith(".ts") || new URL(targetUrl).pathname.endsWith(".tsx");
}

function renderProxyError(targetUrl: string, error: unknown): string {
  return `<!doctype html>
<meta name="color-scheme" content="dark">
<style>
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #101318; color: #e6edf3; font: 14px system-ui, sans-serif; }
  main { max-width: 720px; padding: 24px; }
  code { color: #8bd3ff; overflow-wrap: anywhere; }
  p { color: #aab6c7; line-height: 1.5; }
</style>
<main>
  <h1>Local web target is unreachable</h1>
  <p>Cloudx could not connect to <code>${escapeHtml(targetUrl)}</code> from the server host.</p>
  <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
</main>`;
}

function escapeHtml(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(input: string): string {
  return escapeHtml(input);
}
