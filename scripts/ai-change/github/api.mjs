const apiRoot = "https://api.github.com";
const defaultRequestTimeoutMs = 20_000;
const defaultMaximumRequestBytes = 1_000_000;
const defaultMaximumResponseBytes = 2_000_000;
const defaultMaximumPages = 20;

export function createGitHubApi({
  token,
  repository,
  fetchImpl = fetch,
  requestTimeoutMs = defaultRequestTimeoutMs,
  maximumRequestBytes = defaultMaximumRequestBytes,
  maximumResponseBytes = defaultMaximumResponseBytes,
  maximumPages = defaultMaximumPages,
}) {
  if (!token || /[\r\n]/u.test(token)) throw new Error("GH_TOKEN is required.");
  if (!/^[^/]+\/[^/]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  positiveBound(requestTimeoutMs, 120_000, "GitHub request timeout");
  positiveBound(maximumRequestBytes, 8_000_000, "GitHub request byte limit");
  positiveBound(maximumResponseBytes, 16_000_000, "GitHub response byte limit");
  positiveBound(maximumPages, 100, "GitHub pagination limit");

  const request = async (
    method,
    route,
    { body, accept = "application/vnd.github+json" } = {},
  ) => {
    if (!/^\/(?!\/)[^\r\n]*$/u.test(route)) {
      throw new Error("GitHub API route must be an absolute API path.");
    }
    if (typeof accept !== "string" || !accept || /[\r\n]/u.test(accept)) {
      throw new Error("GitHub API accept header is invalid.");
    }
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      requestBody !== undefined &&
      Buffer.byteLength(requestBody, "utf8") > maximumRequestBytes
    ) {
      throw new Error(`GitHub request exceeds ${maximumRequestBytes} bytes.`);
    }
    const response = await fetchImpl(`${apiRoot}${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
      body: requestBody,
    });
    const text = await boundedResponseText(response, maximumResponseBytes);
    if (!response.ok) {
      const error = new Error(
        `GitHub ${method} ${route} failed with ${response.status}: ${text}`,
      );
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!text || !contentType.includes("json")) return text || undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub ${method} ${route} returned invalid JSON.`);
    }
  };

  return {
    repository,
    request,
    get: (route, options) => request("GET", route, options),
    post: (route, body) => request("POST", route, { body }),
    put: (route, body) => request("PUT", route, { body }),
    patch: (route, body) => request("PATCH", route, { body }),
    delete: (route) => request("DELETE", route),
    async paginate(route, { arrayKey } = {}) {
      const separator = route.includes("?") ? "&" : "?";
      const items = [];
      for (let page = 1; page <= maximumPages; page += 1) {
        const result = await request(
          "GET",
          `${route}${separator}per_page=100&page=${page}`,
        );
        const pageItems = arrayKey ? result?.[arrayKey] : result;
        if (!Array.isArray(pageItems)) {
          const expectation = arrayKey
            ? `an object containing '${arrayKey}'`
            : "an array";
          throw new Error(
            `Expected ${expectation} from paginated route ${route}.`,
          );
        }
        items.push(...pageItems);
        if (pageItems.length < 100) return items;
      }
      throw new Error(
        `GitHub pagination exceeded ${maximumPages} pages for ${route}.`,
      );
    },
  };
}

async function boundedResponseText(response, maximumBytes) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new Error(`GitHub response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`GitHub response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  ).toString("utf8");
}

function positiveBound(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
}

export function repoRoute(repository, suffix) {
  return `/repos/${repository}${suffix}`;
}
