import axios from "axios";

function parseJson(value, name) {
  if (!value) return null;
  const trimmed = value.trim();
  const unwrapped =
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
      ? trimmed.slice(1, -1)
      : trimmed;
  try {
    return JSON.parse(unwrapped);
  } catch (error) {
    throw new Error(`Invalid ${name}`);
  }
}

function parsePayload(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const unwrapped =
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
      ? trimmed.slice(1, -1)
      : trimmed;
  try {
    return JSON.parse(unwrapped);
  } catch {
    return unwrapped;
  }
}

function sanitizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function resolveOptions(overrides = {}) {
  const baseUrl = overrides.baseUrl || process.env.WFO_BASE_URL || "https://cloud1656.wfo.five9.com/VOCoreWebAPI";

  const method = (overrides.method || process.env.WFO_METHOD || "POST").toUpperCase();
  const headers =
    overrides.headers ||
    parseJson(process.env.WFO_HEADERS_JSON, "WFO_HEADERS_JSON") ||
    {};
  const payload =
    overrides.payload !== undefined
      ? parsePayload(overrides.payload)
      : parsePayload(process.env.WFO_PAYLOAD_JSON);
  const pageSize = Number(overrides.pageSize || process.env.WFO_PAGE_SIZE || 100);

  return { baseUrl: sanitizeBaseUrl(baseUrl), method, headers, payload, pageSize };
}

function normalizeNextPageUrl(nextPageUrl, baseUrl) {
  if (!nextPageUrl) return null;
  try {
    const parsed = new URL(nextPageUrl);
    if (parsed.pathname.startsWith("/api/")) {
      const base = new URL(baseUrl);
      const basePath = base.pathname.replace(/\/$/, "");
      if (basePath.includes("VOCoreWebAPI")) {
        return `${base.origin}${basePath}${parsed.pathname}${parsed.search}`;
      }
    }
    return parsed.href;
  } catch {
    // ignore and normalize below
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  if (nextPageUrl.startsWith("/api/")) {
    const prefix = basePath.includes("VOCoreWebAPI") ? basePath : "/VOCoreWebAPI";
    return `${base.origin}${prefix}${nextPageUrl}`;
  }
  if (nextPageUrl.startsWith("/VOCoreWebAPI")) {
    return `${base.origin}${nextPageUrl}`;
  }
  return `${base.origin}${basePath}${nextPageUrl.startsWith("/") ? "" : "/"}${nextPageUrl}`;
}

export async function fetchInteractionRecordings({ pageNumber = 1, ...overrides } = {}) {
  const { baseUrl, method, headers, payload, pageSize } = resolveOptions(overrides);
  const url = `${baseUrl}/api/InteractionRecordings/GetAll/ONLINE_DB?pageNumber=${pageNumber}&pageSize=${pageSize}`;

  if (method === "GET") {
    const response = await axios.get(url, { headers });
    return response.data;
  }

  const response = await axios.post(url, payload, { headers });
  return response.data;
}

export async function fetchInteractionRecordingsByUrl(nextPageUrl, overrides = {}) {
  const { baseUrl, method, headers, payload } = resolveOptions(overrides);
  const url = normalizeNextPageUrl(nextPageUrl, baseUrl);

  if (method === "GET") {
    const response = await axios.get(url, { headers });
    return response.data;
  }
  const response = await axios.post(url, payload, { headers });
  return response.data;
}
