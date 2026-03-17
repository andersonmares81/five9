import axios from "axios";

function isAllowedUrl(parsed) {
  if (!parsed) return false;
  const host = String(parsed.hostname || "").toLowerCase();

  if (host === "wfo.five9.com" || host.endsWith(".wfo.five9.com") || host.endsWith(".five9.com")) {
    return true;
  }

  if (host.endsWith(".amazonaws.com") && host.includes(".s3.")) {
    const path = String(parsed.pathname || "").toLowerCase();
    if (/\.(mp3|mp4|m4a|wav|webm|m3u8)(?:$|\/)/i.test(path)) return true;
    if (/session\.(mp3|mp4|m4a|wav|webm)/i.test(path)) return true;
  }

  return false;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function coerceToHttps(urlLike) {
  if (!urlLike) return null;
  const trimmed = String(urlLike).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

function normalizeCandidateUrl(value, baseUrl) {
  if (!value) return null;
  const raw = coerceToHttps(value);
  const absolute = safeUrl(raw);
  if (absolute) return absolute;
  const base = safeUrl(baseUrl);
  if (!base) return null;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

export function extractUlFromUrl(urlValue) {
  const parsed = safeUrl(urlValue);
  if (!parsed) return null;
  return parsed.searchParams.get("ul");
}

function isFive9Host(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "wfo.five9.com" || host.endsWith(".wfo.five9.com") || host.endsWith(".five9.com");
}

function buildSafeHeaders({ sessionHeaders, targetUrl, accept }) {
  const headers = {};
  const parsed = safeUrl(targetUrl);
  if (!parsed) return headers;

  if (accept) headers.accept = accept;

  const userAgent = sessionHeaders?.["user-agent"] || sessionHeaders?.["User-Agent"];
  if (userAgent) headers["user-agent"] = userAgent;

  if (isFive9Host(parsed.hostname)) {
    for (const key of ["accept-language", "authorization", "content-type", "cookie", "origin", "referer"]) {
      if (sessionHeaders?.[key]) headers[key] = sessionHeaders[key];
    }
  }

  return headers;
}

export function buildWfoPlayerUrl({ recordingUrl, ul, sessionBaseUrl }) {
  const fromRecordingUrl = recordingUrl ? safeUrl(recordingUrl) : null;
  const originFromSession = sessionBaseUrl ? safeUrl(sessionBaseUrl)?.origin : null;
  const origin = originFromSession || fromRecordingUrl?.origin;
  if (!origin) return null;

  const ulValue = ul || extractUlFromUrl(recordingUrl);
  if (!ulValue) return null;

  const url = new URL("/five9wfo/wfoplayer/", origin);
  url.searchParams.set("ul", ulValue);
  if (!url.searchParams.has("widget")) {
    url.searchParams.set("widget", "");
  }
  return url.toString();
}

function collectMediaUrlsFromJson(node, found) {
  if (!node) return;
  if (typeof node === "string") {
    const text = node.trim();
    if (!text) return;
    if (/^https?:\/\//i.test(text) || text.startsWith("//")) {
      found.add(coerceToHttps(text));
      return;
    }
    if (text.includes("amazonaws.com") || text.includes(".mp3") || text.includes(".mp4") || text.includes(".m3u8")) {
      const match = text.match(/https?:\/\/[^\s"'<>]+|\/\/[^\s"'<>]+/gi);
      if (match) {
        for (const item of match) found.add(coerceToHttps(item));
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectMediaUrlsFromJson(item, found);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collectMediaUrlsFromJson(value, found);
  }
}

async function tryFetchModelMedia({ origin, ul, sessionHeaders }) {
  if (!origin || !ul) return [];
  const headers = {
    ...sessionHeaders,
    accept: "application/json, text/plain, */*",
    referer: `${origin}/five9wfo/wfoplayer/?ul=${encodeURIComponent(ul)}`,
    origin
  };

  const candidates = [
    `${origin}/five9wfo/wfoplayer/GetModel?ul=${encodeURIComponent(ul)}`,
    `${origin}/five9wfo/wfoplayer/getmodel?ul=${encodeURIComponent(ul)}`,
    `${origin}/five9wfo/wfoplayer/GetModel?ul=${encodeURIComponent(ul)}&widget=`
  ];

  for (const url of candidates) {
    try {
      const response = await axios.get(url, {
        headers,
        maxRedirects: 2,
        validateStatus: (status) => status >= 200 && status < 400
      });

      const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
      const isJson = contentType.includes("application/json") || typeof response.data === "object";
      if (!isJson) continue;

      const found = new Set();
      collectMediaUrlsFromJson(response.data, found);
      const urls = Array.from(found).filter(Boolean);
      if (urls.length) return urls;
    } catch {
      // ignore and try next
    }
  }

  return [];
}

function extractUrlsFromHtml(html, baseUrl) {
  const found = new Set();
  const text = String(html || "");

  const attrPattern = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  for (const match of text.matchAll(attrPattern)) {
    const value = match[1] || match[2] || match[3];
    const normalized = normalizeCandidateUrl(value, baseUrl);
    if (normalized) found.add(normalized.toString());
  }

  const absolutePattern = /(https?:\/\/[^\s"'<>]+|\/\/[^\s"'<>]+)/gi;
  for (const match of text.matchAll(absolutePattern)) {
    const normalized = normalizeCandidateUrl(match[1], baseUrl);
    if (normalized) found.add(normalized.toString());
  }

  const likelyRelativePattern =
    /(?:'|")((?:\/|\.\/|\.\.\/)[^"'\\]*(?:\.m3u8|\.mp3|\.wav|\.m4a|\.aac|\.mp4|\.webm)(?:\?[^"'\\]*)?)(?:'|")/gi;
  for (const match of text.matchAll(likelyRelativePattern)) {
    const normalized = normalizeCandidateUrl(match[1], baseUrl);
    if (normalized) found.add(normalized.toString());
  }

  return Array.from(found);
}

function classifyMedia(urlValue) {
  const lower = String(urlValue || "").toLowerCase();
  if (lower.includes(".m3u8")) return { kind: "hls", extension: "m3u8" };
  if (lower.includes(".mp3")) return { kind: "audio", extension: "mp3" };
  if (lower.includes(".wav")) return { kind: "audio", extension: "wav" };
  if (lower.includes(".m4a")) return { kind: "audio", extension: "m4a" };
  if (lower.includes(".aac")) return { kind: "audio", extension: "aac" };
  if (lower.includes(".mp4")) return { kind: "video", extension: "mp4" };
  if (lower.includes(".webm")) return { kind: "video", extension: "webm" };
  if (/(audio|recording|media|stream|download)/i.test(lower)) return { kind: "unknown", extension: null };
  return null;
}

function rankMedia(candidate) {
  if (!candidate) return -1;
  if (candidate.kind === "audio") return 100;
  if (candidate.kind === "video") return 60;
  if (candidate.kind === "hls") return 30;
  return 10;
}

export async function resolveWfoPlayerMedia({ recordingUrl, ul, session }) {
  if (!session?.headers?.cookie && !session?.headers?.authorization) {
    return {
      playerUrl: null,
      media: [],
      error: "wfo_session_not_configured"
    };
  }

  const playerUrl = buildWfoPlayerUrl({
    recordingUrl,
    ul,
    sessionBaseUrl: session.baseUrl
  });

  if (!playerUrl) {
    return { playerUrl: null, media: [], error: "invalid_wfo_player_url" };
  }

  const parsedPlayerUrl = safeUrl(playerUrl);
  if (!parsedPlayerUrl || parsedPlayerUrl.protocol !== "https:" || !isAllowedUrl(parsedPlayerUrl)) {
    return { playerUrl: null, media: [], error: "invalid_wfo_player_url" };
  }

  const headers = buildSafeHeaders({
    sessionHeaders: session.headers,
    targetUrl: playerUrl,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  });
  headers.referer = session.headers?.referer || parsedPlayerUrl.toString();
  headers.origin = parsedPlayerUrl.origin;

  const response = await axios.get(playerUrl, {
    headers,
    maxRedirects: 5,
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400
  });

  const html = typeof response.data === "string" ? response.data : String(response.data || "");
  const ulValue = ul || extractUlFromUrl(recordingUrl);
  const modelUrls = await tryFetchModelMedia({
    origin: parsedPlayerUrl.origin,
    ul: ulValue,
    sessionHeaders: session.headers
  });

  const candidates = extractUrlsFromHtml(html, playerUrl)
    .concat(modelUrls)
    .map((value) => {
      const parsed = safeUrl(value);
      if (!parsed || parsed.protocol !== "https:" || !isAllowedUrl(parsed)) return null;
      const meta = classifyMedia(value);
      return meta ? { url: value, ...meta } : null;
    })
    .filter(Boolean);

  candidates.sort((a, b) => rankMedia(b) - rankMedia(a));

  return {
    playerUrl,
    media: candidates
  };
}

export async function streamWfoMedia({ url, session, res }) {
  const parsed = safeUrl(url);
  if (!parsed || parsed.protocol !== "https:" || !isAllowedUrl(parsed)) {
    return { ok: false, status: 400, error: "invalid_media_url" };
  }

  const headers = buildSafeHeaders({ sessionHeaders: session.headers, targetUrl: parsed.toString(), accept: "*/*" });
  const range = res?.req?.headers?.range;
  if (range) headers.range = range;
  if (isFive9Host(parsed.hostname)) {
    headers.referer = session.headers?.referer || session.headers?.origin || parsed.origin;
    headers.origin = parsed.origin;
  }

  const response = await axios.get(parsed.toString(), {
    headers,
    maxRedirects: 5,
    responseType: "stream",
    validateStatus: (status) => status >= 200 && status < 400
  });

  res.status(response.status);
  const contentType = response.headers?.["content-type"] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  for (const headerName of [
    "accept-ranges",
    "content-range",
    "content-length",
    "content-disposition",
    "etag",
    "last-modified"
  ]) {
    if (response.headers?.[headerName]) {
      const existing = typeof res.getHeader === "function" ? res.getHeader(headerName) : undefined;
      if (existing == null) {
        res.setHeader(headerName, response.headers[headerName]);
      }
    }
  }

  response.data.pipe(res);
  return { ok: true };
}
