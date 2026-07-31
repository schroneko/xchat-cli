import { randomUUID } from "node:crypto";

export const OPERATION_CATALOG = Object.freeze({
  GenerateXChatTokenMutation: { queryId: "Qh3fZRjPPtPoHYR_2sCZsA", method: "POST" },
  SendMessageMutation: { queryId: "LkAIEchf8AGj-WgeLoTVcw", method: "POST" },
  DeleteMessageMutation: { queryId: "4gsDQKEmYkOtvsSIpHXdQA", method: "POST" },
  MuteConversation: { queryId: "Dy7geJg7CL5dqhsl6QBteg", method: "POST" },
  UnmuteConversation: { queryId: "LnNSeGu4vnbwqXAvh7OlGQ", method: "POST" },
  ConversationDeletion: { queryId: "9nsAnKrQvpifR3UmdtIdOg", method: "POST" },
  GetInitialXChatPageQuery: { queryId: "Gl7r1aY59L7jLBjVC98lqg", method: "GET" },
  GetInboxPageRequestQuery: { queryId: "wmieJEOHm6twV06EXwRdiA", method: "GET" },
  GetInboxPageConversationDataRequestQuery: { queryId: "uQEDp5FgdqNiG2jT5q07Jw", method: "GET" },
  GetUsersByIdsForXChat: { queryId: "MnzVKPEXUx3X1VRCyjKlMA", method: "GET" },
  GetConversationPageQuery: { queryId: "IVlXls9JTnbgQ1gxsGAfJA", method: "GET" },
  GetPublicKeys: { queryId: "RQAjOoIX9dIsHoVjuVV0Iw", method: "GET" },
  AddXChatPublicKey: { queryId: "vjZCP0G28pIJ6CUC99rdAQ", method: "POST" },
  InitializeXChatMediaUpload: { queryId: "g2n9PB_uaRYv_SFvQokEFw", method: "POST" },
  FinalizeXChatMediaUpload: { queryId: "UK24H5vBa5MJspBmjZyFVQ", method: "POST" },
});

const DEFAULT_WEB_BEARER = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_CHARACTERS = 64 * 1024 * 1024;
const MAX_SCRIPT_COUNT = 64;
const MAX_RETRY_AFTER_MS = 30_000;

export class XApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "XApiError";
    this.status = options.status;
    this.kind = options.kind;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
  }
}

export class XWebClient {
  constructor(options) {
    this.session = options.session;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.delay = options.delay ?? defaultDelay;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.clientUuid = options.clientUuid ?? randomUUID();
    this.catalog = options.catalog ?? OPERATION_CATALOG;
    this.metadata = options.metadata ?? null;
  }

  async discover(operationNames = Object.keys(this.catalog)) {
    this.metadata = await discoverXWebMetadata({
      session: this.session,
      operationNames,
      fetchImpl: this.fetchImpl,
      delay: this.delay,
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
      userAgent: this.userAgent,
      catalog: this.catalog,
    });
    return safeMetadata(this.metadata);
  }

  async operation(name) {
    if (!this.catalog[name] && !this.metadata?.operations?.[name]) {
      throw new XApiError(`Unknown X web operation: ${name}`, { kind: "usage" });
    }
    if (!this.metadata) {
      await this.discover([name]);
    } else if (!this.metadata.operations[name]) {
      const discovered = await discoverXWebMetadata({
        session: this.session,
        operationNames: [name],
        fetchImpl: this.fetchImpl,
        delay: this.delay,
        timeoutMs: this.timeoutMs,
        maxAttempts: this.maxAttempts,
        userAgent: this.userAgent,
        catalog: this.catalog,
      });
      this.metadata.bearer = discovered.bearer || this.metadata.bearer;
      this.metadata.operations[name] = discovered.operations[name];
    }
    return this.metadata.operations[name];
  }

  async get(name, variables = {}, options = {}) {
    const operation = await this.operation(name);
    const url = buildGraphqlGetUrl(operation, variables, options);
    return requestJson(url, {
      method: "GET",
      headers: buildXHeaders({
        session: this.session,
        bearer: this.metadata.bearer,
        userAgent: this.userAgent,
        clientUuid: this.clientUuid,
      }),
      fetchImpl: this.fetchImpl,
      delay: this.delay,
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });
  }

  async post(name, variables = {}, options = {}) {
    const operation = await this.operation(name);
    const url = buildGraphqlUrl(operation);
    const body = buildGraphqlPostBody(operation, variables, options);
    return requestJson(url, {
      method: "POST",
      headers: buildXHeaders({
        session: this.session,
        bearer: this.metadata.bearer,
        userAgent: this.userAgent,
        clientUuid: this.clientUuid,
        contentType: "application/json",
      }),
      body: JSON.stringify(body),
      fetchImpl: this.fetchImpl,
      delay: this.delay,
      timeoutMs: this.timeoutMs,
      maxAttempts: 1,
    });
  }
}

export function buildCookieHeader(session) {
  if (!session?.authToken || !session?.ct0 || !session?.twid) {
    throw new XApiError("X web session is incomplete", { kind: "authentication" });
  }
  return [
    `auth_token=${session.authToken}`,
    `ct0=${session.ct0}`,
    `twid=${session.twid}`,
  ].join("; ");
}

export function buildXHeaders(options) {
  const headers = {
    accept: "*/*",
    authorization: normalizeBearer(options.bearer),
    cookie: buildCookieHeader(options.session),
    origin: "https://x.com",
    referer: "https://x.com/messages",
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    "x-client-uuid": options.clientUuid ?? randomUUID(),
    "x-csrf-token": options.session.ct0,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "en",
  };
  if (options.contentType) {
    headers["content-type"] = options.contentType;
  }
  return headers;
}

export function parseOperationMetadata(source, operationNames) {
  const operations = {};

  for (const name of operationNames) {
    const escaped = escapeRegex(name);
    const anchors = [
      new RegExp(`operationName\\s*:\\s*["']${escaped}["']`, "g"),
      new RegExp(`["']operationName["']\\s*:\\s*["']${escaped}["']`, "g"),
    ];

    for (const anchor of anchors) {
      const match = anchor.exec(source);
      if (!match) {
        continue;
      }
      const start = Math.max(0, match.index - 1400);
      const end = Math.min(source.length, match.index + match[0].length + 2200);
      const window = source.slice(start, end);
      const anchorIndex = match.index - start;
      const queryId = nearestMatch(window, [
        /queryId\s*:\s*["']([^"']+)["']/,
        /["']queryId["']\s*:\s*["']([^"']+)["']/,
        /sha256Hash\s*:\s*["']([^"']+)["']/,
      ], anchorIndex, 800);
      if (!queryId) {
        continue;
      }
      operations[name] = {
        queryId,
        operationName: name,
        operationType: nearestMatch(window, [
          /operationType\s*:\s*["']([^"']+)["']/,
          /["']operationType["']\s*:\s*["']([^"']+)["']/,
        ], anchorIndex, 800),
        features: parseStringList(window, "featureSwitches", anchorIndex),
        fieldToggles: parseStringList(window, "fieldToggles", anchorIndex),
        source: "bundle",
      };
      break;
    }
  }

  return operations;
}

export async function discoverXWebMetadata(options) {
  const operationNames = options.operationNames ?? Object.keys(options.catalog ?? OPERATION_CATALOG);
  const catalog = options.catalog ?? OPERATION_CATALOG;
  const baseHeaders = {
    accept: "text/html,application/xhtml+xml",
    cookie: buildCookieHeader(options.session),
    "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
  };
  const html = await requestText("https://x.com/messages", {
    headers: baseHeaders,
    fetchImpl: options.fetchImpl ?? fetch,
    delay: options.delay ?? defaultDelay,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxAttempts: options.maxAttempts ?? 3,
    maxResponseBytes: 8 * 1024 * 1024,
  });
  const scriptUrls = extractScriptUrls(html);
  if (scriptUrls.length > MAX_SCRIPT_COUNT) {
    throw new XApiError("X web page returned too many script resources", { kind: "protocol" });
  }
  const operations = {};
  let bearer;
  let bundleCharacters = 0;

  for (const scriptUrl of scriptUrls) {
    const source = await requestText(scriptUrl, {
      headers: { "user-agent": options.userAgent ?? DEFAULT_USER_AGENT },
      fetchImpl: options.fetchImpl ?? fetch,
      delay: options.delay ?? defaultDelay,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxAttempts: options.maxAttempts ?? 3,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    });
    bundleCharacters += source.length;
    if (bundleCharacters > MAX_BUNDLE_CHARACTERS) {
      throw new XApiError("X web bundles exceeded the response limit", { kind: "protocol" });
    }
    bearer ||= source.match(/Bearer [A-Za-z0-9%._~-]+/)?.[0];
    Object.assign(
      operations,
      parseOperationMetadata(
        source,
        operationNames.filter((name) => !operations[name]),
      ),
    );
    if (bearer && operationNames.every((name) => operations[name])) {
      break;
    }
  }

  for (const name of operationNames) {
    if (!operations[name] && catalog[name]) {
      operations[name] = {
        ...catalog[name],
        operationName: name,
        source: "catalog",
      };
    }
  }

  return {
    bearer: bearer ?? DEFAULT_WEB_BEARER,
    bearerSource: bearer ? "bundle" : "fallback",
    operations,
    scriptCount: scriptUrls.length,
  };
}

export function buildGraphqlUrl(operation) {
  return new URL(
    `https://api.x.com/graphql/${encodeURIComponent(operation.queryId)}/${encodeURIComponent(operation.operationName)}`,
  );
}

export function buildGraphqlGetUrl(operation, variables, options = {}) {
  const url = buildGraphqlUrl(operation);
  url.searchParams.set("variables", JSON.stringify(variables));
  const features = options.features ?? operation.features;
  const fieldToggles = options.fieldToggles ?? operation.fieldToggles;
  if (features && Object.keys(features).length > 0) {
    url.searchParams.set("features", JSON.stringify(features));
  }
  if (fieldToggles && Object.keys(fieldToggles).length > 0) {
    url.searchParams.set("fieldToggles", JSON.stringify(fieldToggles));
  }
  return url;
}

export function buildGraphqlPostBody(operation, variables, options = {}) {
  const body = {};
  if (!options.omitOperationName) {
    body.operationName = operation.operationName;
  }
  body.variables = options.variablesAsString ? JSON.stringify(variables) : variables;
  body.extensions = {
    persistedQuery: {
      version: 1,
      sha256Hash: operation.queryId,
    },
  };
  if (options.clientLibrary !== false) {
    body.extensions.clientLibrary = {
      name: "apollo-kotlin",
      version: "4.3.3",
    };
  }
  return body;
}

export async function requestJson(url, options = {}) {
  const response = await requestResponse(url, options);
  const text = await readResponseText(response, options);
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new XApiError("X internal API returned invalid JSON", {
      status: response.status,
      kind: "protocol",
      details: { endpoint: safeEndpoint(url) },
    });
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new XApiError("X GraphQL request failed", {
      status: response.status,
      kind: "graphql",
      details: {
        endpoint: safeEndpoint(url),
        errorCount: payload.errors.length,
      },
    });
  }
  return payload;
}

async function requestText(url, options = {}) {
  const response = await requestResponse(url, options);
  return readResponseText(response, options);
}

export async function readResponseText(response, options = {}) {
  const maximumBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw responseLimitError(response.status);
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await withBodyTimeout(response.text(), timeoutMs, response.status);
    if (Buffer.byteLength(text) > maximumBytes) {
      throw responseLimitError(response.status);
    }
    return text;
  }

  const chunks = [];
  let totalBytes = 0;
  let complete = false;
  const reading = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw responseLimitError(response.status);
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  })();

  try {
    return await withBodyTimeout(reading, timeoutMs, response.status);
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => {});
    }
  }
}

async function requestResponse(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? defaultDelay;
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    let response;

    try {
      response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      lastError = new XApiError(
        error?.name === "AbortError" ? "X internal API request timed out" : "X internal API network request failed",
        {
          kind: error?.name === "AbortError" ? "timeout" : "network",
          details: { endpoint: safeEndpoint(url) },
        },
      );
      if (attempt < maxAttempts) {
        await delay(backoffMilliseconds(attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      return response;
    }

    const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
    const kind = classifyStatus(response.status);
    lastError = new XApiError(`X internal API request failed with HTTP ${response.status}`, {
      status: response.status,
      kind,
      retryAfter,
      details: { endpoint: safeEndpoint(url) },
    });

    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      await drainResponse(response);
      await delay(retryAfter ?? backoffMilliseconds(attempt));
      continue;
    }
    throw lastError;
  }

  throw lastError;
}

function extractScriptUrls(html) {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], "https://x.com").toString())
    .filter((url) => url.startsWith("https://abs.twimg.com/responsive-web/client-web/"))
    .filter((url, index, values) => values.indexOf(url) === index);
}

function safeMetadata(metadata) {
  return {
    bearerDetected: Boolean(metadata.bearer),
    bearerSource: metadata.bearerSource,
    scriptCount: metadata.scriptCount,
    operations: Object.fromEntries(Object.entries(metadata.operations).map(([name, operation]) => [
      name,
      {
        queryId: operation.queryId,
        method: operation.method,
        source: operation.source,
      },
    ])),
  };
}

function normalizeBearer(value) {
  if (!value) {
    return DEFAULT_WEB_BEARER;
  }
  return value.startsWith("Bearer ") ? value : `Bearer ${value}`;
}

function parseStringList(source, property, anchorIndex = 0) {
  const escaped = escapeRegex(property);
  const pattern = new RegExp(`${escaped}\\s*:\\s*\\[([^\\]]*)\\]`, "g");
  const match = closestMatch(source, pattern, anchorIndex);
  if (!match) {
    return {};
  }
  return Object.fromEntries(
    [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => [item[1], true]),
  );
}

function nearestMatch(source, patterns, anchorIndex, maximumDistance) {
  let closest;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of source.matchAll(new RegExp(pattern.source, flags))) {
      const distance = Math.abs(match.index - anchorIndex);
      if (distance <= maximumDistance && (!closest || distance < closest.distance)) {
        closest = {
          distance,
          value: match[1],
        };
      }
    }
  }
  return closest?.value;
}

function closestMatch(source, pattern, anchorIndex) {
  let closest;
  for (const match of source.matchAll(pattern)) {
    const distance = Math.abs(match.index - anchorIndex);
    if (!closest || distance < closest.distance) {
      closest = { distance, match };
    }
  }
  return closest?.match;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 404) {
    return "stale-operation";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status >= 500) {
    return "server";
  }
  return "request";
}

function parseRetryAfter(value) {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

function backoffMilliseconds(attempt) {
  return Math.min(4000, 250 * (2 ** (attempt - 1)));
}

async function drainResponse(response) {
  try {
    await readResponseText(response, {
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024,
    });
  } catch {
    return;
  }
}

function safeEndpoint(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withBodyTimeout(promise, timeoutMs, status) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new XApiError("X internal API response body timed out", {
        status,
        kind: "timeout",
      }));
    }, Math.max(1, timeoutMs));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function responseLimitError(status) {
  return new XApiError("X internal API response exceeded the size limit", {
    status,
    kind: "protocol",
  });
}
