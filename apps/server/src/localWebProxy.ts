import type { FastifyReply } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import WebSocketClient, { type RawData, type WebSocket } from "ws";

import { LOCAL_WEB_PLUGIN_ID } from "./plugins/LocalWebPlugin.js";
import type { SessionStore } from "./sessionStore.js";
import { redactUrlSearchAndHash, redactUrlSearchAndHashInText } from "./urlRedaction.js";

const HOP_BY_HOP_HEADERS = new Set(["connection", "content-encoding", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "clear-site-data",
  "content-security-policy",
  "content-security-policy-report-only",
  "set-cookie",
  "set-cookie2",
  "x-frame-options"
]);
const ROOT_ABSOLUTE_HTML_URL_ATTRIBUTE_PATTERN = /\b((?:src|href|action)\s*=\s*["'])\/(?!\/|api\/local-web\/)/gi;
const ROOT_LITERAL_PREFIX_PATTERN = /(["'`])\/(?!\/|api\/local-web\/)(@vite\/|@react-refresh\b|@fs\/|@id\/|src\/|node_modules\/|assets\/|knowledge-graph\.json|domain-graph\.json|diff-overlay\.json|meta\.json|fingerprints\.json|file-content\.json|intermediate\/|favicon\.svg)/g;
const ROOT_ABSOLUTE_SRCSET_ATTRIBUTE_PATTERN = /\b((?:srcset|imagesrcset)\s*=\s*)(["'])([\s\S]*?)\2/gi;
const ROOT_ABSOLUTE_SRCSET_CANDIDATE_PATTERN = /(^|,)(\s*)\/(?!\/|api\/local-web\/)([^\s,]+)/g;
const ROOT_ABSOLUTE_CSS_URL_PATTERN = /url\(\s*(["']?)\/(?!\/|api\/local-web\/)([^)"'\s][^)"']*?)\1\s*\)/g;
const HTML_HEAD_OPEN_TAG_PATTERN = /<head\b[^>]*>/i;
const HTML_HTML_OPEN_TAG_PATTERN = /<html\b[^>]*>/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_PROXY_REDIRECTS = 5;
const LOCAL_WEB_PROXY_FETCH_TIMEOUT_MS = 15_000;
export const LOCAL_WEB_PROXY_MAX_BODY_BYTES = 25 * 1024 * 1024;
const LOCAL_WEB_WS_PENDING_MAX_MESSAGES = 16;
const LOCAL_WEB_WS_PENDING_MAX_BYTES = 1024 * 1024;
const LOCAL_WEB_WS_MAX_BUFFERED_BYTES = 1024 * 1024;
const BODYLESS_HTTP_METHODS = new Set(["GET", "HEAD"]);
const REQUEST_BODY_REDIRECT_TO_GET_STATUSES = new Set([301, 302, 303]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma"
]);

export interface LocalWebProxyRequest {
  method?: string;
  headers?: IncomingHttpHeaders;
  body?: unknown;
}

interface LocalWebFetchRequest {
  method: string;
  headers: Headers;
  body?: BodyInit;
}

export class LocalWebProxy {
  constructor(private readonly sessions: SessionStore) {}

  async handle(tabId: string, proxiedPath: string | undefined, requestUrl: string | undefined, reply: FastifyReply, request: LocalWebProxyRequest = {}): Promise<void> {
    const targetBaseUrl = this.readTargetUrl(tabId);
    let targetUrl = resolveTargetUrl(targetBaseUrl, proxiedPath ?? "", requestUrl ?? "");
    let response: Response;
    let body: Buffer;
    try {
      const result = await fetchLocalWebTarget(targetBaseUrl, targetUrl, request);
      response = result.response;
      targetUrl = result.targetUrl;
      body = await readResponseBody(response, LOCAL_WEB_PROXY_MAX_BODY_BYTES);
    } catch (error) {
      reply.code(502).type("text/html; charset=utf-8").send(renderProxyError(targetUrl, error));
      return;
    }

    copyResponseHeaders(response, reply);
    reply.code(response.status);

    const contentType = response.headers.get("content-type") ?? "";
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

  handleWebSocket(tabId: string, proxiedPath: string | undefined, requestUrl: string | undefined, protocols: string[] | undefined, client: WebSocket): void {
    let targetUrl: string;
    try {
      const targetBaseUrl = this.readTargetUrl(tabId);
      targetUrl = resolveTargetWebSocketUrl(targetBaseUrl, proxiedPath ?? "", requestUrl ?? "");
    } catch (error) {
      safeCloseWebSocket(client, 1011, proxyFailureReason(error));
      return;
    }
    const upstream = new WebSocketClient(targetUrl, protocols);
    const pending: Array<{ data: RawData; isBinary: boolean; bytes: number }> = [];
    let pendingBytes = 0;
    let proxyClosed = false;

    const clearPending = () => {
      pending.length = 0;
      pendingBytes = 0;
    };
    const failProxy = (error: unknown) => {
      if (proxyClosed) {
        return;
      }
      proxyClosed = true;
      clearPending();
      safeCloseWebSocket(upstream, 1011, proxyFailureReason(error));
      safeCloseWebSocket(client, 1011, proxyFailureReason(error));
    };
    const queuePending = (data: RawData, isBinary: boolean) => {
      const bytes = rawDataByteLength(data);
      if (pending.length >= LOCAL_WEB_WS_PENDING_MAX_MESSAGES) {
        failProxy(new Error(`Local web websocket pending queue exceeded the ${LOCAL_WEB_WS_PENDING_MAX_MESSAGES} message limit.`));
        return;
      }
      if (pendingBytes + bytes > LOCAL_WEB_WS_PENDING_MAX_BYTES) {
        failProxy(new Error(`Local web websocket pending queue exceeded the ${LOCAL_WEB_WS_PENDING_MAX_BYTES} byte limit.`));
        return;
      }
      pending.push({ data, isBinary, bytes });
      pendingBytes += bytes;
    };

    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        pendingBytes -= message.bytes;
        if (!safeSendWebSocket(upstream, message.data, message.isBinary, failProxy)) {
          break;
        }
      }
      pendingBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      safeSendWebSocket(client, data, isBinary, failProxy);
    });
    upstream.on("close", (code, reason) => {
      if (proxyClosed) {
        return;
      }
      proxyClosed = true;
      clearPending();
      safeCloseWebSocket(client, closeCodeForPeer(code), closeReasonForPeer(reason));
    });
    upstream.on("error", failProxy);

    client.on("message", (data, isBinary) => {
      if (proxyClosed) {
        return;
      }
      if (upstream.readyState === WebSocketClient.OPEN) {
        safeSendWebSocket(upstream, data, isBinary, failProxy);
        return;
      }
      if (upstream.readyState === WebSocketClient.CONNECTING) {
        queuePending(data, isBinary);
        return;
      }
      failProxy(new Error("Local web websocket upstream is not connected."));
    });
    client.on("close", () => {
      if (proxyClosed) {
        return;
      }
      proxyClosed = true;
      clearPending();
      safeCloseWebSocket(upstream);
    });
    client.on("error", () => {
      if (proxyClosed) {
        return;
      }
      proxyClosed = true;
      clearPending();
      safeCloseWebSocket(upstream);
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

async function fetchLocalWebTarget(targetBaseUrl: string, initialTargetUrl: string, proxyRequest: LocalWebProxyRequest): Promise<{ response: Response; targetUrl: string }> {
  const targetOrigin = new URL(targetBaseUrl).origin;
  let targetUrl = initialTargetUrl;
  let request = createLocalWebFetchRequest(proxyRequest);
  for (let redirectCount = 0; redirectCount <= MAX_PROXY_REDIRECTS; redirectCount += 1) {
    const response = await fetch(targetUrl, {
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(LOCAL_WEB_PROXY_FETCH_TIMEOUT_MS),
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {})
    });
    const nextUrl = redirectTarget(response, targetUrl);
    if (!nextUrl) {
      return { response, targetUrl };
    }
    await response.body?.cancel().catch(() => undefined);
    if (redirectCount === MAX_PROXY_REDIRECTS) {
      throw new Error(`Local web target redirected more than ${MAX_PROXY_REDIRECTS} times.`);
    }
    if (new URL(nextUrl).origin !== targetOrigin) {
      throw new Error(`Local web target redirected outside its configured origin: ${nextUrl}`);
    }
    request = redirectedLocalWebFetchRequest(request, response.status);
    targetUrl = nextUrl;
  }
  throw new Error("Local web target redirected too many times.");
}

function createLocalWebFetchRequest(proxyRequest: LocalWebProxyRequest): LocalWebFetchRequest {
  const method = (proxyRequest.method ?? "GET").toUpperCase();
  const body = BODYLESS_HTTP_METHODS.has(method) ? undefined : localWebRequestBody(proxyRequest.body);
  return {
    method,
    headers: forwardedLocalWebRequestHeaders(proxyRequest.headers ?? {}, body !== undefined),
    ...(body !== undefined ? { body } : {})
  };
}

function localWebRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (Buffer.isBuffer(body)) {
    return arrayBufferFromView(body);
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return arrayBufferFromView(body);
  }
  if (typeof body === "string") {
    return body;
  }
  throw new Error("Local web proxy request body must be raw bytes or text.");
}

function arrayBufferFromView(view: ArrayBufferView<ArrayBufferLike>): ArrayBuffer {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return bytes.buffer;
}

function forwardedLocalWebRequestHeaders(headers: IncomingHttpHeaders, hasBody: boolean): Headers {
  const forwarded = new Headers();
  forwarded.set("accept", headerValue(headers.accept) ?? "*/*");
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(lower)) {
      continue;
    }
    if (!hasBody && lower === "content-type") {
      continue;
    }
    const header = headerValue(value);
    if (header !== undefined) {
      forwarded.set(lower, header);
    }
  }
  return forwarded;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.filter((part) => part.trim()).join(", ");
    return joined || undefined;
  }
  return value && value.trim() ? value : undefined;
}

function redirectedLocalWebFetchRequest(request: LocalWebFetchRequest, status: number): LocalWebFetchRequest {
  if (request.body === undefined) {
    return request;
  }
  if (!REQUEST_BODY_REDIRECT_TO_GET_STATUSES.has(status)) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-type");
  return {
    method: "GET",
    headers
  };
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`Local web response exceeded the ${maxBytes} byte proxy response limit.`);
    }
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Local web response exceeded the ${maxBytes} byte proxy response limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function redirectTarget(response: Response, currentUrl: string): string | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }
  const location = response.headers.get("location");
  return location ? new URL(location, currentUrl).href : undefined;
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
  const path = proxiedPath.length > 0 ? `/${proxiedPath.replace(/^\/+/, "")}` : base.pathname || "/";
  const target = new URL(base.origin);
  target.pathname = path;
  target.search = request.search || (path === base.pathname ? base.search : "");
  return target.href;
}

function resolveTargetWebSocketUrl(targetBaseUrl: string, proxiedPath: string, requestUrl: string): string {
  const base = new URL(targetBaseUrl);
  const request = new URL(requestUrl || "/proxy-ws/", "https://cloudx.local");
  const path = proxiedPath.length > 0 ? `/${proxiedPath.replace(/^\/+/, "")}` : base.pathname || "/";
  const target = new URL(base.origin);
  target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = path;
  target.search = request.search || (path === base.pathname ? base.search : "");
  return target.href;
}

function copyResponseHeaders(response: Response, reply: FastifyReply): void {
  const hopByHopHeaders = hopByHopResponseHeaders(response);
  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase();
    if (hopByHopHeaders.has(lower) || STRIPPED_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    reply.header(name, value);
  }
  reply.header("cache-control", "no-store");
}

function hopByHopResponseHeaders(response: Response): Set<string> {
  const headers = new Set(HOP_BY_HOP_HEADERS);
  const connection = response.headers.get("connection");
  if (!connection) {
    return headers;
  }
  for (const token of connection.split(",")) {
    const name = token.trim().toLowerCase();
    if (name) {
      headers.add(name);
    }
  }
  return headers;
}

function rewriteHtml(html: string, tabId: string, targetUrl: string): string {
  const prefix = proxyBasePath(tabId, targetUrl);
  const withBase = insertHtmlBaseElement(html, prefix);
  return rewriteRootAbsoluteReferences(withBase, tabId, targetUrl);
}

function insertHtmlBaseElement(html: string, baseHref: string): string {
  const baseElement = `<base href="${escapeAttribute(baseHref)}">`;
  if (HTML_HEAD_OPEN_TAG_PATTERN.test(html)) {
    return html.replace(HTML_HEAD_OPEN_TAG_PATTERN, (headTag) => `${headTag}${baseElement}`);
  }
  if (HTML_HTML_OPEN_TAG_PATTERN.test(html)) {
    return html.replace(HTML_HTML_OPEN_TAG_PATTERN, (htmlTag) => `${htmlTag}<head>${baseElement}</head>`);
  }
  return `<head>${baseElement}</head>${html}`;
}

function rewriteCss(css: string, tabId: string, targetUrl: string): string {
  const prefix = proxyOriginPath(tabId);
  return css.replace(ROOT_ABSOLUTE_CSS_URL_PATTERN, (_match, quote: string, path: string) => `url(${quote}${prefix}/${path.trim()}${quote})`);
}

function rewriteRootAbsoluteReferences(input: string, tabId: string, targetUrl: string): string {
  const prefix = proxyOriginPath(tabId);
  return rewriteRootAbsoluteSrcsetAttributes(input, prefix)
    .replace(ROOT_ABSOLUTE_HTML_URL_ATTRIBUTE_PATTERN, `$1${prefix}/`)
    .replace(ROOT_LITERAL_PREFIX_PATTERN, `$1${prefix}/$2`);
}

function rewriteRootAbsoluteSrcsetAttributes(input: string, prefix: string): string {
  return input.replace(ROOT_ABSOLUTE_SRCSET_ATTRIBUTE_PATTERN, (_match, attributeStart: string, quote: string, value: string) => {
    const rewritten = value.replace(ROOT_ABSOLUTE_SRCSET_CANDIDATE_PATTERN, (_candidate, separator: string, whitespace: string, path: string) => `${separator}${whitespace}${prefix}/${path}`);
    return `${attributeStart}${quote}${rewritten}${quote}`;
  });
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

function safeSendWebSocket(socket: WebSocket, data: RawData, isBinary: boolean, onError: (error: Error) => void): boolean {
  if (socket.readyState !== WebSocketClient.OPEN) {
    return false;
  }
  if (socket.bufferedAmount + rawDataByteLength(data) > LOCAL_WEB_WS_MAX_BUFFERED_BYTES) {
    onError(new Error(`Local web websocket buffered output exceeded the ${LOCAL_WEB_WS_MAX_BUFFERED_BYTES} byte limit.`));
    return false;
  }
  try {
    socket.send(data, { binary: isBinary }, (error) => {
      if (error) {
        onError(error);
      }
    });
    return true;
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function rawDataByteLength(data: RawData): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + rawDataByteLength(chunk), 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return 0;
}

function safeCloseWebSocket(socket: WebSocket, code?: number, reason?: string | Buffer): void {
  if (socket.readyState !== WebSocketClient.OPEN && socket.readyState !== WebSocketClient.CONNECTING) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function closeCodeForPeer(code: number): number {
  if ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1011;
}

function closeReasonForPeer(reason: Buffer): Buffer | string | undefined {
  if (reason.length === 0) {
    return undefined;
  }
  if (reason.length <= 123) {
    return reason;
  }
  return "Local web websocket upstream closed.";
}

function proxyFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) {
    return "Local web websocket proxy failed.";
  }
  const reason = `Local web websocket proxy failed: ${message}`;
  return Buffer.byteLength(reason) <= 123 ? reason : "Local web websocket proxy failed.";
}

function renderProxyError(targetUrl: string, error: unknown): string {
  const displayUrl = redactUrlSearchAndHash(targetUrl);
  const displayError = redactUrlSearchAndHashInText(error instanceof Error ? error.message : String(error));
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
  <p>Cloudx could not connect to <code>${escapeHtml(displayUrl)}</code> from the server host.</p>
  <p>${escapeHtml(displayError)}</p>
</main>`;
}

function escapeHtml(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(input: string): string {
  return escapeHtml(input);
}
