const API_BASE = "/api";

function getToken() {
  return localStorage.getItem("five9_token");
}

function setToken(token) {
  localStorage.setItem("five9_token", token);
}

function clearToken() {
  localStorage.removeItem("five9_token");
}

async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
      throw new Error("service_unreachable");
    }
    throw error;
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const message =
      typeof payload?.detail === "string" && payload.detail.trim()
        ? payload.detail.trim()
        : payload?.error || "request_failed";
    throw new Error(message);
  }

  return res.json();
}

export async function login(email, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  setToken(data.token);
  return data;
}

export async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // ignore for token-based auth
  }
  clearToken();
}

export function setManualToken(token) {
  setToken(token);
}

export async function fetchSummary(filters) {
  const params = new URLSearchParams(filters).toString();
  return apiFetch(`/reports/summary?${params}`);
}

export async function fetchMetrics(filters) {
  const params = new URLSearchParams(filters).toString();
  return apiFetch(`/reports/metrics?${params}`);
}

export async function fetchCalls(filters) {
  const params = new URLSearchParams(filters).toString();
  return apiFetch(`/reports/calls?${params}`);
}

export async function fetchAgentsDaily(filters) {
  const params = new URLSearchParams(filters).toString();
  return apiFetch(`/reports/agents-daily?${params}`);
}

export async function fetchCampaignsDaily(filters) {
  const params = new URLSearchParams(filters).toString();
  return apiFetch(`/reports/campaigns-daily?${params}`);
}

export async function fetchRealtime() {
  return apiFetch("/realtime/agents");
}

export async function fetchSystemInfo() {
  return apiFetch("/system/info");
}

export async function fetchAutomationStatus() {
  return apiFetch("/system/automation");
}

export async function fetchMonthStats(monthKey) {
  return apiFetch(`/system/automation/month/${monthKey}`);
}

export async function runAutomationNow() {
  return apiFetch("/system/automation/run-now", {
    method: "POST"
  });
}

export function isAuthenticated() {
  return Boolean(getToken());
}

export async function saveWfoSession(rawText) {
  return apiFetch("/wfo/session", {
    method: "POST",
    body: JSON.stringify({ rawText })
  });
}

export async function saveWfoSessionHar(payload) {
  return apiFetch("/wfo/session-har", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchWfoSession() {
  return apiFetch("/wfo/session");
}

export async function validateWfoSession() {
  return apiFetch("/wfo/validate");
}

export async function syncWfoRange(payload) {
  return apiFetch("/wfo/sync-range", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function syncWfoDaySplit(payload) {
  return apiFetch("/wfo/sync-day-split", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function prefetchWfoDay(payload) {
  return apiFetch("/wfo/prefetch-day", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function prefetchWfoRange(payload) {
  return apiFetch("/wfo/prefetch-range", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchWfoJob(jobId) {
  return apiFetch(`/wfo/jobs/${encodeURIComponent(jobId)}`);
}

export async function attachWfoReport(callId, reportUrl, force = false) {
  return apiFetch("/wfo/attach-report", {
    method: "POST",
    body: JSON.stringify({ callId, reportUrl, force })
  });
}

export async function transcribeCall(callId, force = false) {
  return apiFetch("/analysis/transcribe", {
    method: "POST",
    body: JSON.stringify({ callId, force })
  });
}

export async function transcribeDay(payload) {
  return apiFetch("/analysis/transcribe-day", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function transcribeRange(payload) {
  return apiFetch("/analysis/transcribe-range", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchAnalysisJob(jobId) {
  return apiFetch(`/analysis/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchCallAnalysis(callId) {
  return apiFetch(`/analysis/calls/${encodeURIComponent(callId)}`);
}

export async function pushBackupRangeToIngest(payload) {
  return apiFetch("/backup/push-range", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function pushBackupDayToIngest(payload) {
  return apiFetch("/backup/push-day", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function fetchBackupJob(jobId) {
  return apiFetch(`/backup/jobs/${encodeURIComponent(jobId)}`);
}
