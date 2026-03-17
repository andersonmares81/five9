import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

const DEFAULT_BASE_URL = "https://app.five9.com/appsvcs/rs/svc";

function buildLoginPayload() {
  if (process.env.FIVE9_LOGIN_PAYLOAD_JSON) {
    try {
      return JSON.parse(process.env.FIVE9_LOGIN_PAYLOAD_JSON);
    } catch (error) {
      throw new Error("Invalid FIVE9_LOGIN_PAYLOAD_JSON");
    }
  }
  const username = process.env.FIVE9_USERNAME;
  const password = process.env.FIVE9_PASSWORD;
  if (!username || !password) {
    throw new Error("Missing FIVE9_USERNAME or FIVE9_PASSWORD");
  }
  return { username, password };
}

export function createFive9Client() {
  const jar = new CookieJar();
  const http = wrapper(axios.create({ jar, withCredentials: true }));
  let metadata = null;
  let lastLoginAt = 0;

  async function login() {
    const baseUrl = process.env.FIVE9_BASE_URL || DEFAULT_BASE_URL;
    const payload = buildLoginPayload();
    const response = await http.post(`${baseUrl}/auth/login`, payload, {
      headers: { "Content-Type": "application/json" }
    });
    lastLoginAt = Date.now();
    metadata = { login: response.data };
    return response.data;
  }

  async function fetchMetadata() {
    const baseUrl = process.env.FIVE9_BASE_URL || DEFAULT_BASE_URL;
    const response = await http.get(`${baseUrl}/auth/metadata`, {
      headers: { "Content-Type": "application/json" }
    });
    metadata = { ...(metadata || {}), metadata: response.data };
    return response.data;
  }

  async function ensureSession() {
    const maxAgeMs = (process.env.FIVE9_SESSION_MAX_MINUTES || 50) * 60 * 1000;
    if (!metadata || Date.now() - lastLoginAt > maxAgeMs) {
      await login();
      await fetchMetadata();
    }
  }

  function resolveApiUrl() {
    const apiUrl = metadata?.metadata?.apiUrl || metadata?.login?.apiUrl;
    if (!apiUrl) {
      throw new Error("Missing apiUrl from Five9 metadata");
    }
    return apiUrl.replace(/\/$/, "");
  }

  function resolveBaseHost() {
    const apiUrl = metadata?.metadata?.apiUrl || metadata?.login?.apiUrl || process.env.FIVE9_BASE_URL;
    if (!apiUrl) {
      throw new Error("Missing Five9 base URL");
    }
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}`;
  }

  function resolveContextBase(context) {
    if (context === "app") return resolveApiUrl();
    const host = resolveBaseHost();
    if (context === "sup") {
      return (process.env.FIVE9_SUP_BASE_URL || `${host}/supsvcs/rs/svc`).replace(/\/$/, "");
    }
    if (context === "str") {
      return (process.env.FIVE9_STR_BASE_URL || `${host}/strsvcs/rs/svc`).replace(/\/$/, "");
    }
    throw new Error(`Unknown Five9 context: ${context}`);
  }

  async function request(path, options = {}) {
    await ensureSession();
    const baseApiUrl = resolveContextBase(options.context || "app");
    try {
      const response = await http.request({
        url: `${baseApiUrl}${path}`,
        method: options.method || "GET",
        params: options.params,
        data: options.data,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      return response.data;
    } catch (error) {
      if (error?.response?.status === 401) {
        await login();
        await fetchMetadata();
        const retryBase = resolveContextBase(options.context || "app");
        const retry = await http.request({
          url: `${retryBase}${path}`,
          method: options.method || "GET",
          params: options.params,
          data: options.data,
          headers: { "Content-Type": "application/json", ...(options.headers || {}) }
        });
        return retry.data;
      }
      throw error;
    }
  }

  async function stream(path, options = {}) {
    await ensureSession();
    const baseApiUrl = resolveContextBase(options.context || "str");
    return http.request({
      url: `${baseApiUrl}${path}`,
      method: options.method || "GET",
      responseType: "stream",
      headers: { ...(options.headers || {}) }
    });
  }

  return {
    login,
    fetchMetadata,
    request,
    stream
  };
}
