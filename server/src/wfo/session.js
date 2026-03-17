import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageDir = path.join(__dirname, "..", "..", "storage");
const sessionFilePath = path.join(storageDir, "wfo-session.json");

function stripQuotes(value) {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeCurlText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u222bcurl/gi, "curl");
}

function extractFlagValue(text, flag) {
  const pattern = new RegExp(`(?:${flag})\\s+('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\\S+)`, "i");
  const match = text.match(pattern);
  return match ? stripQuotes(match[1]) : null;
}

function extractHeaderValue(text, headerName) {
  const pattern = new RegExp(`-H\\s+('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`, "gi");
  const matches = text.match(pattern) || [];
  for (const raw of matches) {
    const header = stripQuotes(raw.replace(/^-H\s+/i, ""));
    const separatorIndex = header.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = header.slice(0, separatorIndex).trim().toLowerCase();
    const value = header.slice(separatorIndex + 1).trim();
    if (key === headerName.toLowerCase()) return value;
  }
  return null;
}

function buildHeadersFromCurl(text) {
  const headers = {};
  const headerPattern = /-H\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi;
  for (const match of text.matchAll(headerPattern)) {
    const header = stripQuotes(match[1]);
    const separatorIndex = header.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = header.slice(0, separatorIndex).trim();
    const value = header.slice(separatorIndex + 1).trim();
    headers[key.toLowerCase()] = value;
  }
  const cookie = extractFlagValue(text, "-b|--cookie");
  if (cookie) headers.cookie = cookie;
  return pruneHeaders(headers);
}

function extractUrl(text) {
  const quoted = text.match(/curl\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/i);
  if (quoted) return stripQuotes(quoted[1]);
  const unquoted = text.match(/curl\s+(https?:\/\/\S+)/i);
  if (unquoted?.[1]) {
    return stripQuotes(unquoted[1].replace(/\\$/, ""));
  }
  const requestUrl = text.match(/request url:\s*(https?:\/\/\S+)/i);
  if (requestUrl?.[1]) return stripQuotes(requestUrl[1]);
  const anyUrl = text.match(/https?:\/\/\S+VOCoreWebAPI\S*/i);
  if (anyUrl?.[0]) return stripQuotes(anyUrl[0]);
  return null;
}

function pruneHeaders(headers) {
  const keep = new Set([
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "cookie",
    "origin",
    "referer",
    "user-agent"
  ]);
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (!keep.has(lower)) continue;
    next[lower] = String(value);
  }
  return next;
}

function normalizeHeadersObject(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!key) continue;
    const lower = String(key).toLowerCase();
    if (value == null) continue;
    next[lower] = String(value);
  }
  return pruneHeaders(next);
}

function extractCurlCommands(rawText) {
  const text = normalizeCurlText(rawText);
  const commands = [];
  const pattern = /(?:^|;\s*|\n\s*)[^a-zA-Z0-9_-]*?(curl\s+[\s\S]*?)(?=(?:;\s*|\n\s*)[^a-zA-Z0-9_-]*?curl\s+|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const command = match[1]?.trim();
    if (command) commands.push(command);
  }
  return commands.length ? commands : [text.trim()].filter(Boolean);
}

function parseCurlCommand(rawText) {
  const url = extractUrl(rawText);
  const headers = buildHeadersFromCurl(rawText);
  const payload = extractFlagValue(rawText, "--data-raw|--data") || null;
  const authorization = headers.authorization || extractHeaderValue(rawText, "authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() || null;
  return { rawText, url, headers, payload, token };
}

function scoreCurlCommand(command) {
  let score = 0;
  if (!command.url) return -1;
  if (command.token) score += 10;
  if (command.url.includes("/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB")) score += 100;
  if (command.url.includes("/VOCoreWebAPI/api/InteractionRecordings/")) score += 30;
  if (command.payload && /\$filter\s*=/i.test(String(command.payload))) score += 20;
  if (command.payload && /START_TIME/i.test(String(command.payload))) score += 10;
  if (command.headers.cookie) score += 5;
  return score;
}

function selectBestCurlCommand(rawText) {
  const parsedCommands = extractCurlCommands(rawText).map(parseCurlCommand);
  const ranked = parsedCommands
    .filter((command) => command.url && command.token)
    .sort((left, right) => scoreCurlCommand(right) - scoreCurlCommand(left));

  return ranked[0] || parsedCommands.sort((left, right) => scoreCurlCommand(right) - scoreCurlCommand(left))[0] || null;
}

function toUtcBoundary(value, isEnd) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = isEnd ? "T23:59:59.999-05:00" : "T00:00:00.000-05:00";
    return new Date(`${value}${suffix}`).toISOString();
  }
  return new Date(value).toISOString();
}

function extractOrder(payload) {
  if (!payload) return "desc";
  const match = String(payload).match(/\$orderby\s*=\s*START_TIME\s+(asc|desc)/i);
  return match?.[1]?.toLowerCase() || "desc";
}

function buildPayload({ from, to, order = "desc" }) {
  const filters = [];
  const fromIso = toUtcBoundary(from, false);
  const toIso = toUtcBoundary(to, true);
  if (fromIso) filters.push(`START_TIME ge ${fromIso}`);
  if (toIso) filters.push(`START_TIME le ${toIso}`);
  const filterClause = filters.length ? `$filter=( ${filters.join(" and ")} )&` : "";
  return `"${filterClause}$orderby=START_TIME ${order}"`;
}

let currentSession = null;

function persistSession(session) {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2), "utf8");
  } catch (error) {
    console.error("wfo_session_persist_failed", error?.message || error);
  }
}

function loadPersistedSession() {
  if (currentSession) return currentSession;
  try {
    if (!fs.existsSync(sessionFilePath)) return null;
    const raw = fs.readFileSync(sessionFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.baseUrl || !parsed?.headers) return null;
    currentSession = parsed;
    return currentSession;
  } catch (error) {
    console.error("wfo_session_load_failed", error?.message || error);
    return null;
  }
}

export function parseCurlSession(rawText) {
  const selectedCommand = selectBestCurlCommand(rawText);
  const url = selectedCommand?.url || null;
  const headers = selectedCommand?.headers || {};
  const payload = selectedCommand?.payload || null;
  const token = selectedCommand?.token || null;

  if (!url || !token) {
    throw new Error("Invalid cURL: missing URL or Authorization Bearer token");
  }

  return {
    baseUrl: url.includes("/VOCoreWebAPI") ? url.split("/api/")[0] : "https://cloud1656.wfo.five9.com/VOCoreWebAPI",
    method: "POST",
    headers,
    payload,
    token,
    pageNumber: Number(new URL(url).searchParams.get("pageNumber") || 1),
    pageSize: Number(new URL(url).searchParams.get("pageSize") || process.env.WFO_PAGE_SIZE || 100),
    selectedUrl: url,
    rawText: selectedCommand.rawText
  };
}

export function setWfoSessionFromCurl(rawText) {
  currentSession = parseCurlSession(rawText);
  persistSession(currentSession);
  return currentSession;
}

export function setWfoSessionFromHar({ url, headers, payload } = {}) {
  const urlValue = String(url || "").trim();
  if (!urlValue) {
    throw new Error("Invalid HAR: missing request URL");
  }
  const normalizedHeaders = normalizeHeadersObject(headers || {});
  const authorization = normalizedHeaders.authorization || null;
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() || null;
  if (!token) {
    throw new Error("Invalid HAR: missing Authorization Bearer token (export HAR without sanitizing headers/cookies)");
  }

  const parsed = new URL(urlValue);
  const pageNumber = Number(parsed.searchParams.get("pageNumber") || 1);
  const pageSize = Number(parsed.searchParams.get("pageSize") || process.env.WFO_PAGE_SIZE || 100);

  currentSession = {
    baseUrl: urlValue.includes("/VOCoreWebAPI") ? urlValue.split("/api/")[0] : "https://cloud1656.wfo.five9.com/VOCoreWebAPI",
    method: "POST",
    headers: normalizedHeaders,
    payload: payload ?? null,
    token,
    pageNumber,
    pageSize,
    selectedUrl: urlValue,
    rawText: "imported_from_har"
  };
  persistSession(currentSession);
  return currentSession;
}

export function getWfoSession() {
  return currentSession || loadPersistedSession();
}

export function clearWfoSession() {
  currentSession = null;
  try {
    if (fs.existsSync(sessionFilePath)) fs.rmSync(sessionFilePath, { force: true });
  } catch (error) {
    console.error("wfo_session_clear_failed", error?.message || error);
  }
}

export function buildRangePayloadFromSession({ from, to, order }) {
  const session = getWfoSession();
  const resolvedOrder = order || extractOrder(session?.payload);
  return buildPayload({ from, to, order: resolvedOrder });
}
