import { useEffect, useRef, useState } from "react";
import {
  fetchCalls,
  fetchAgentsDaily,
  fetchCampaignsDaily,
  fetchMetrics,
  fetchRealtime,
  fetchSummary,
  fetchAutomationStatus,
  fetchMonthStats,
  fetchSystemInfo,
  fetchCallAnalysis,
  attachWfoReport,
  fetchAnalysisJob,
  fetchBackupJob,
  fetchWfoJob,
  prefetchWfoDay,
  prefetchWfoRange,
  pushBackupDayToIngest,
  pushBackupRangeToIngest,
  transcribeCall,
  transcribeDay,
  transcribeRange,
  validateWfoSession,
  fetchWfoSession,
  isAuthenticated,
  logout,
  saveWfoSession,
  saveWfoSessionHar,
  setManualToken,
  runAutomationNow,
  syncWfoDaySplit,
  syncWfoRange
} from "./api";
import "./styles.css";

const DEFAULT_RANGE_DAYS = 7;
const WFO_CURL_STORAGE_KEY = "five9_wfo_curl_v1";
const WFO_CURL_STORAGE_TTL_MS = 12 * 60 * 60 * 1000;
const PREFETCH_RESUME_STORAGE_KEY = "five9_prefetch_resume_v1";
const TRANSCRIBE_RESUME_STORAGE_KEY = "five9_transcribe_resume_v1";

function loadStoredWfoCurl() {
  try {
    const raw = localStorage.getItem(WFO_CURL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.text) return null;
    const savedAt = Number(parsed.savedAt || 0);
    if (savedAt && Date.now() - savedAt > WFO_CURL_STORAGE_TTL_MS) {
      localStorage.removeItem(WFO_CURL_STORAGE_KEY);
      return null;
    }
    return String(parsed.text);
  } catch {
    return null;
  }
}

function saveStoredWfoCurl(text) {
  try {
    const value = String(text || "");
    if (!value.trim()) return;
    localStorage.setItem(WFO_CURL_STORAGE_KEY, JSON.stringify({ text: value, savedAt: Date.now() }));
  } catch {
    // ignore
  }
}

function clearStoredWfoCurl() {
  try {
    localStorage.removeItem(WFO_CURL_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function loadStoredCheckpoint(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.date) return null;
    const offset = Math.max(0, Number(parsed.offset || 0));
    if (!offset) return null;
    return {
      date: String(parsed.date),
      offset,
      savedAt: Number(parsed.savedAt || 0)
    };
  } catch {
    return null;
  }
}

function saveStoredCheckpoint(storageKey, checkpoint) {
  try {
    if (!checkpoint?.date || !checkpoint?.offset) return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        date: String(checkpoint.date),
        offset: Math.max(0, Number(checkpoint.offset || 0)),
        savedAt: Date.now()
      })
    );
  } catch {
    // ignore
  }
}

function clearStoredCheckpoint(storageKey) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "-";
  const total = Math.max(0, Math.round(Number(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function getAgentInitials(call) {
  const first = (call.agent_first_name || "").trim();
  const last = (call.agent_last_name || "").trim();
  const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  if (initials.trim()) return initials;
  const agentId = (call.agent_id || "").trim();
  if (!agentId) return "--";
  const parts = agentId.split(/[.\s@_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return agentId.charAt(0).toUpperCase() || "--";
}

function formatAge(startTime) {
  if (!startTime) return "-";
  const diffMs = Date.now() - new Date(startTime).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return "-";
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function buildDayList(from, to) {
  if (!from || !to) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (start.getTime() > end.getTime()) return [];
  const days = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function toWfoReportUrl(recordingUrl) {
  if (!recordingUrl) return null;
  try {
    const url = new URL(recordingUrl);
    if (url.pathname.includes("/five9wfo/index.html")) return url.toString();
    if (url.pathname.includes("/five9wfo/wfoplayer")) {
      url.pathname = "/five9wfo/index.html";
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function userErrorMessage(message) {
  if (!message) return "";
  if (message === "wfo_session_expired") {
    return "WFO session expired (401). Paste a fresh WFO cURL and click “Configure WFO session from cURL”.";
  }
  if (message === "wfo_audio_not_found") {
    return "WFO audio not found for this call. Try opening the WFO player link directly to confirm it still works.";
  }
  if (message === "prepare_event_no_media") {
    return "WFO did not return any media for this call (PrepareEvent). Open the interaction in WFO and click Play/Evaluate once, then try again.";
  }
  if (message === "analysis_not_found") {
    return "No transcript saved yet for this call.";
  }
  if (message === "invalid_report_url") {
    return "Invalid WFO report URL. It must be https://<tenant>.wfo.five9.com/five9wfo/index.html?ul=... (or wfoplayer) and include ul=...";
  }
  if (message === "call_not_found") {
    return "Call not found in the local database.";
  }
  if (message === "openai_not_configured") {
    return "OpenAI is not configured. Either set OPENAI_API_KEY on the server, or use local STT (faster-whisper) for transcription.";
  }
  if (message === "python_not_found") {
    return "Python was not found in the server runtime. Install Python in WSL/Linux or set PYTHON_BIN explicitly, then restart the service.";
  }
  if (message === "faster_whisper_not_installed") {
    return "Local transcription is not installed. Run `python3 -m pip install -U faster-whisper` in the server environment (WSL/Linux) and ensure ffmpeg is installed, then restart the service.";
  }
  if (message === "transcribe_failed") {
    return "Transcription failed. Check server logs for the underlying error.";
  }
  if (message === "ollama_unavailable") {
    return "Ollama is not reachable. Start Ollama locally (default: http://127.0.0.1:11434) or change OLLAMA_HOST on the server.";
  }
  if (message === "ollama_model_not_found") {
    return "Ollama model not found. Pull the model (e.g. `ollama pull llama3.1:8b`) or set OLLAMA_SENTIMENT_MODEL.";
  }
  if (message === "sentiment_provider_not_configured") {
    return "Sentiment provider not configured. Set SENTIMENT_PROVIDER=openai or SENTIMENT_PROVIDER=ollama on the server.";
  }
  if (message === "audio_not_found") {
    return "No audio source found for this call.";
  }
  if (message === "local_audio_purged") {
    return "Local audio was already processed and removed after transcription. Use force mode or prefetch again if you need to rebuild it.";
  }
  if (message === "backup_endpoint_not_configured") {
    return "Backup ingest endpoint is not configured on the server.";
  }
  if (message === "backup_endpoint_unreachable") {
    return "The ingest/backup endpoint is unreachable. WFO sync can continue, but ingest is offline.";
  }
  if (message.includes("ECONNREFUSED 127.0.0.1:8088")) {
    return "Local ingest is offline on 127.0.0.1:8088. Start the local MySQL/PHP stack in Docker or XAMPP, or change BACKUP_ENDPOINT.";
  }
  if (message === "wfo_sync_range_failed") {
    return "WFO range sync failed. Check the detailed server error or refresh the WFO session.";
  }
  if (message === "no_calls_available") {
    return "There are no calls available to send to ingest for that range.";
  }
  if (message === "missing_token") {
    return "Missing token. Paste a valid token and try again.";
  }
  return message;
}

function topErrorLabel(errorCounts) {
  const entries = Object.entries(errorCounts || {});
  if (!entries.length) return null;
  entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
  const [code, count] = entries[0];
  if (!code) return null;
  return `${code}: ${count}`;
}

function extractTokenFromText(text) {
  if (!text) return null;
  const direct = text.match(/authorization:\s*Bearer\s+([^\s'"]+)/i);
  if (direct?.[1]) return direct[1].trim();
  const bearer = text.match(/Bearer\s+([^\s'"]+)/i);
  if (bearer?.[1]) return bearer[1].trim();
  return null;
}

function extractHarBestSession(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return null;

  const candidates = [];
  for (const entry of entries) {
    const request = entry?.request;
    const url = request?.url;
    if (!url || typeof url !== "string") continue;
    if (!url.includes("/VOCoreWebAPI/api/InteractionRecordings/GetAll/ONLINE_DB")) continue;

    const headersArr = Array.isArray(request?.headers) ? request.headers : [];
    const headers = {};
    for (const header of headersArr) {
      if (!header?.name) continue;
      const name = String(header.name).toLowerCase();
      const value = header.value == null ? "" : String(header.value);
      headers[name] = value;
    }

    const auth = headers["authorization"] || headers["Authorization"];
    const hasToken = typeof auth === "string" && auth.toLowerCase().includes("bearer ");
    if (!hasToken) continue;

    const payloadText = request?.postData?.text ?? null;
    candidates.push({
      url,
      headers,
      payload: payloadText
    });
  }

  // Prefer the one with cookie + START_TIME filters if present
  candidates.sort((a, b) => {
    const score = (item) => {
      let s = 0;
      if (item.headers.cookie) s += 10;
      const payload = String(item.payload || "");
      if (payload.includes("START_TIME")) s += 5;
      if (payload.includes("$filter")) s += 3;
      return s;
    };
    return score(b) - score(a);
  });

  return candidates[0] || null;
}

function getSpeakerSeparation(analysis) {
  return analysis?.transcript_json?.speaker_separation || null;
}

function hasSeparatedTranscript(analysis) {
  const separation = getSpeakerSeparation(analysis);
  return Boolean(
    separation &&
    (Array.isArray(separation.turns) && separation.turns.length > 0) &&
    (separation.agent_text || separation.patient_text)
  );
}

function describePrefetchEntry(entry) {
  if (!entry) return "-";
  const bits = [];
  if (entry.audio) bits.push("audio");
  if (entry.screen) bits.push("screen");
  const suffix = bits.length ? ` • ${bits.join(" + ")}` : entry.error ? ` • ${entry.error}` : "";
  return `${entry.callId} • ${entry.status}${suffix}`;
}

function describeTranscriptEntry(entry) {
  if (!entry) return "-";
  return `${entry.callId} • ${entry.status}${entry.error ? ` • ${entry.error}` : ""}`;
}

function getCallDisplayName(call) {
  if (!call) return "Agent";
  return call.agent_name || [call.agent_first_name, call.agent_last_name].filter(Boolean).join(" ") || "Agent";
}

function formatScoreValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number % 1 === 0 ? String(number) : number.toFixed(2);
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function automationStatusLabel(day) {
  if (!day) return "Pending";
  if (day.status === "complete") return "Complete";
  if (day.status === "partial") return "In progress";
  if (day.status === "attention") return "Needs attention";
  return "Pending";
}

function automationCountsLabel(day) {
  if (!day) return "No stats yet";
  return `Calls ${day.totalCalls || 0} • Audio ${day.audioProcessed || 0} • Screen ${day.screenLocal || 0} • Transcript ${day.transcriptCount || 0}`;
}

function filterMonthStats(monthStats = [], selectedMonth = "") {
  if (!selectedMonth) return monthStats;
  return monthStats.filter(d => d.date?.startsWith(selectedMonth));
}

function parseMonthDate(monthStr, day = 1) {
  const [year, month] = String(monthStr || "").split("-").map(Number);
  if (!year || !month) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMonthDisplayName(monthStr) {
  const date = parseMonthDate(monthStr, 1);
  if (!date) return "";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function adjustMonth(monthStr, offset) {
  const [year, month] = monthStr.split("-").map(Number);
  let newMonth = month + offset;
  let newYear = year;

  while (newMonth > 12) {
    newMonth -= 12;
    newYear += 1;
  }
  while (newMonth < 1) {
    newMonth += 12;
    newYear -= 1;
  }

  return `${newYear}-${String(newMonth).padStart(2, "0")}`;
}

function buildAutomationCalendarWeeks(monthStats = []) {
  if (!monthStats || monthStats.length === 0) return [];

  const daysMap = new Map(monthStats.map(d => [d.date, d]));
  const firstDayStr = monthStats[0]?.date || "";
  if (!firstDayStr) return [];

  const [year, month] = firstDayStr.split("-").slice(0, 2);
  const firstDay = parseMonthDate(`${year}-${month}`, 1);
  if (!firstDay) return [];
  const lastDay = new Date(Number(year), Number(month), 0);

  const startWeekday = firstDay.getDay();
  const totalDays = lastDay.getDate();

  const weeks = [];
  let currentWeek = [];

  // Skip padding for Sunday, only add Mon-Fri
  for (let i = startWeekday; i < 6 && i > 0; i++) {
    currentWeek.push(null);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayOfWeek = new Date(Number(year), Number(month) - 1, day).getDay();

    // Skip weekends (0=Sunday, 6=Saturday)
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    currentWeek.push(daysMap.get(dateStr) || { date: dateStr, totalCalls: 0, audioProcessed: 0, screenLocal: 0, transcriptCount: 0, status: null });

    if (currentWeek.length === 5) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  if (currentWeek.length > 0) {
    while (currentWeek.length < 5) {
      currentWeek.push(null);
    }
    weeks.push(currentWeek);
  }

  return weeks;
}


export default function App() {
  const today = new Date();
  const fromDefault = new Date(today.getTime() - DEFAULT_RANGE_DAYS * 86400000);
  const [authed, setAuthed] = useState(isAuthenticated());
  const [activeView, setActiveView] = useState("dashboard");
  const [tokenInput, setTokenInput] = useState("");
  const [curlInput, setCurlInput] = useState("");
  const curlSaveTimer = useRef(null);
  const [summary, setSummary] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [calls, setCalls] = useState([]);
  const [realtime, setRealtime] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncingRange, setSyncingRange] = useState(false);
  const [wfoConfigured, setWfoConfigured] = useState(false);
  const [wfoSessionInfo, setWfoSessionInfo] = useState(null);
  const [manualDay, setManualDay] = useState(toDateInputValue(today));
  const [wfoStartPage, setWfoStartPage] = useState("1");
  const [wfoMaxPages, setWfoMaxPages] = useState("20");
  const [lastSyncResult, setLastSyncResult] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState(null);
  const [agentsDaily, setAgentsDaily] = useState(null);
  const [campaignsDaily, setCampaignsDaily] = useState(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [systemInfo, setSystemInfo] = useState(null);
  const [automationStatus, setAutomationStatus] = useState(null);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [manualDayMetrics, setManualDayMetrics] = useState(null);
  const [wfoValidation, setWfoValidation] = useState(null);
  const [analysisModal, setAnalysisModal] = useState(null);
  const [transcribingCallId, setTranscribingCallId] = useState(null);
  const [attachModal, setAttachModal] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [prefetchJob, setPrefetchJob] = useState(null);
  const prefetchPollTimer = useRef(null);
  const prefetchLastUpdatedAt = useRef(null);
  const prefetchPollFailures = useRef(0);
  const [transcribeDayJob, setTranscribeDayJob] = useState(null);
  const transcribeDayPollTimer = useRef(null);
  const transcribeDayLastUpdatedAt = useRef(null);
  const transcribePollFailures = useRef(0);
  const [backupPushJob, setBackupPushJob] = useState(null);
  const backupPushPollTimer = useRef(null);
  const backupPushLastUpdatedAt = useRef(null);
  const backupPushPollFailures = useRef(0);
  const [harImportInfo, setHarImportInfo] = useState(null);
  const [pendingResume, setPendingResume] = useState(null);
  const pendingResumeRef = useRef(null);
  const [prefetchResume, setPrefetchResume] = useState(() => loadStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY));
  const [transcribeResume, setTranscribeResume] = useState(() => loadStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY));
  const wfoRestoreAttemptedRef = useRef(false);

  const [filters, setFilters] = useState({
    from: toDateInputValue(fromDefault),
    to: toDateInputValue(today),
    agentId: "",
    campaignId: "",
    limit: "50"
  });
  const [selectedAutomationDay, setSelectedAutomationDay] = useState(null);
  const [selectedAutomationMonth, setSelectedAutomationMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [selectedMonthStats, setSelectedMonthStats] = useState(null);

  useEffect(() => {
    if (!authed) return;
    if (curlInput.trim()) return;
    const restored = loadStoredWfoCurl();
    if (restored) setCurlInput(restored);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    if (wfoConfigured) return;
    if (wfoRestoreAttemptedRef.current) return;
    const restored = loadStoredWfoCurl();
    if (!restored) return;
    wfoRestoreAttemptedRef.current = true;
    saveWfoSession(restored)
      .then((session) => {
        setWfoConfigured(Boolean(session?.configured));
        setWfoSessionInfo(session || null);
      })
      .catch(() => {
        // ignore auto-restore failures; manual setup remains available
      });
  }, [authed, wfoConfigured]);

  useEffect(() => {
    if (!authed) return;
    setPrefetchResume(loadStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY));
    setTranscribeResume(loadStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    if (!curlInput.trim()) return;
    if (curlSaveTimer.current) clearTimeout(curlSaveTimer.current);
    curlSaveTimer.current = setTimeout(() => {
      saveStoredWfoCurl(curlInput);
    }, 700);
    return () => {
      if (curlSaveTimer.current) clearTimeout(curlSaveTimer.current);
    };
  }, [authed, curlInput]);

  useEffect(() => {
    if (!authed) return;
    if (error !== "wfo_session_expired") return;
    clearStoredWfoCurl();
    setCurlInput("");
  }, [authed, error]);

  useEffect(() => {
    if (prefetchJob?.progress?.done == null || !prefetchJob?.progress?.date) return;
    const checkpoint = {
      date: prefetchJob.progress.date,
      offset: prefetchJob.progress.resumeOffset ?? prefetchJob.progress.done
    };
    if (prefetchJob.status === "succeeded") {
      clearStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY);
      setPrefetchResume(null);
      return;
    }
    saveStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY, checkpoint);
    setPrefetchResume(checkpoint);
  }, [prefetchJob]);

  useEffect(() => {
    if (transcribeDayJob?.progress?.done == null || !transcribeDayJob?.progress?.date) return;
    const checkpoint = {
      date: transcribeDayJob.progress.date,
      offset: transcribeDayJob.progress.resumeOffset ?? transcribeDayJob.progress.done
    };
    if (transcribeDayJob.status === "succeeded") {
      clearStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY);
      setTranscribeResume(null);
      return;
    }
    saveStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY, checkpoint);
    setTranscribeResume(checkpoint);
  }, [transcribeDayJob]);

  const analysisCall = analysisModal
    ? calls.find((call) => String(call.call_id) === String(analysisModal.call_id || analysisModal.callId))
    : null;
  const analysisAgentLabel = getCallDisplayName(analysisCall);
  const analysisAgentInitials = getAgentInitials(analysisCall || analysisModal || {});
  const analysisSentiment = analysisModal?.sentiment_json || {};
  const analysisSpeakerSentiment = analysisSentiment?.speaker_sentiment || {};
  const analysisQualityMetrics = analysisSentiment?.quality_metrics || {};
  const analysisReport = analysisSentiment?.report || {};
  const livePrefetchProgress = prefetchJob?.progress || automationStatus?.currentTask?.prefetchProgress || null;
  const liveTranscribeProgress = transcribeDayJob?.progress || automationStatus?.currentTask?.transcribeProgress || null;

  useEffect(() => {
    return () => {
      if (prefetchPollTimer.current) clearInterval(prefetchPollTimer.current);
      if (transcribeDayPollTimer.current) clearInterval(transcribeDayPollTimer.current);
      if (backupPushPollTimer.current) clearInterval(backupPushPollTimer.current);
    };
  }, []);

  function setPendingResumeSafe(next) {
    pendingResumeRef.current = next;
    setPendingResume(next);
  }

  async function maybeAutoResume() {
    const pending = pendingResumeRef.current;
    if (!pending) return;
    let configuredNow = wfoConfigured;
    try {
      const sessionData = await fetchWfoSession();
      configuredNow = Boolean(sessionData?.configured);
      setWfoConfigured(configuredNow);
      setWfoSessionInfo(sessionData);
    } catch {
      configuredNow = false;
    }
    if (!configuredNow) return;
    if (pending.type === "prefetch") {
      await startPrefetchDay({ date: pending.date, offset: pending.offset });
      setPendingResumeSafe(null);
    }
    if (pending.type === "transcribe") {
      await startTranscribeDay({ date: pending.date, offset: pending.offset });
      setPendingResumeSafe(null);
    }
  }

  async function downloadFile(urlPath, fallbackFilename) {
    setError(null);
    try {
      const token = localStorage.getItem("five9_token");
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(urlPath, { headers });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "download_failed");
      }

      const contentDisposition = res.headers.get("content-disposition") || "";
      const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      const guessedExt =
        contentType.includes("audio/mpeg") || contentType.includes("audio/mp3")
          ? "mp3"
          : contentType.includes("audio/wav")
            ? "wav"
            : contentType.includes("audio/x-wav")
              ? "wav"
              : contentType.includes("audio/mp4")
                ? "m4a"
                : contentType.includes("application/vnd.apple.mpegurl")
                  ? "m3u8"
                  : contentType.includes("video/mp4")
                    ? "mp4"
                    : "bin";
      const fallbackWithExt =
        fallbackFilename && String(fallbackFilename).includes(".")
          ? String(fallbackFilename)
          : fallbackFilename
            ? `${fallbackFilename}.${guessedExt}`
            : `download.${guessedExt}`;
      const filename = filenameMatch?.[1] || fallbackWithExt;
      const blob = await res.blob();

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      const message = String(err?.message || "download_failed");
      setError(message);
      if (message === "wfo_session_not_configured" || message === "wfo_session_expired") {
        setWfoConfigured(false);
        if (message === "wfo_session_expired") clearStoredWfoCurl();
        try {
          const sessionData = await fetchWfoSession();
          setWfoConfigured(Boolean(sessionData?.configured));
          setWfoSessionInfo(sessionData);
        } catch {
          // ignore
        }
      }
    }
  }

  async function openTranscript(callId) {
    setError(null);
    try {
      const data = await fetchCallAnalysis(callId);
      setAnalysisModal({ callId, ...data });
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleTranscribe(callId) {
    setError(null);
    setTranscribingCallId(callId);
    try {
      const result = await transcribeCall(callId, false);
      if (result?.analysis) {
        setAnalysisModal({ callId, ...result.analysis });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setTranscribingCallId(null);
    }
  }

  async function handleAttachReport(callId, reportUrl) {
    setError(null);
    setAttaching(true);
    try {
      const result = await attachWfoReport(callId, reportUrl, false);
      const updated = result?.call;
      if (updated?.recording_url) {
        setCalls((prev) =>
          prev.map((row) => (row.call_id === callId ? { ...row, recording_url: updated.recording_url } : row))
        );
      }
      setAttachModal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setAttaching(false);
    }
  }

  async function pollPrefetchJob(jobId) {
    if (!jobId) return;
    try {
      const job = await fetchWfoJob(jobId);
      prefetchPollFailures.current = 0;
      if (prefetchLastUpdatedAt.current !== job.updatedAt) {
        prefetchLastUpdatedAt.current = job.updatedAt;
        setPrefetchJob(job);
      }
      if (job.status === "succeeded" || job.status === "failed") {
        if (prefetchPollTimer.current) clearInterval(prefetchPollTimer.current);
        prefetchPollTimer.current = null;
        if (job.status === "failed" && job.error === "wfo_session_expired") {
          const resumeOffset = job.progress?.resumeOffset ?? job.progress?.done ?? 0;
          setPendingResumeSafe({ type: "prefetch", date: job.progress?.date || manualDay, offset: resumeOffset });
          setWfoConfigured(false);
          clearStoredWfoCurl();
        }
      }
    } catch (err) {
      const message = String(err?.message || "prefetch_failed");
      if (message === "service_unreachable") {
        prefetchPollFailures.current += 1;
        setError("Service temporarily unavailable. Reconnecting to resume prefetch…");
        if (prefetchPollFailures.current < 10) return;
      }
      if (message === "job_not_found") {
        const resumeOffset = prefetchJob?.progress?.done ?? prefetchResume?.offset ?? 0;
        const resumeDate = prefetchJob?.progress?.date || prefetchResume?.date || manualDay;
        if (resumeOffset > 0) {
          setPendingResumeSafe({ type: "prefetch", date: resumeDate, offset: resumeOffset });
          saveStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY, { date: resumeDate, offset: resumeOffset });
          setPrefetchResume({ date: resumeDate, offset: resumeOffset });
        }
        setError("Prefetch job was interrupted. You can resume from the saved checkpoint.");
      } else {
        setError(message);
      }
      if (prefetchPollTimer.current) clearInterval(prefetchPollTimer.current);
      prefetchPollTimer.current = null;
    }
  }

  async function startPrefetchDay({ date, offset: resumeOffset = 0 } = {}) {
    setError(null);
    try {
      const selectedDate = date || manualDay;
      if (Number(resumeOffset || 0) <= 0) {
        clearStoredCheckpoint(PREFETCH_RESUME_STORAGE_KEY);
        setPrefetchResume(null);
      }
      const started = await prefetchWfoDay({ date: selectedDate, offset: resumeOffset });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("prefetch_failed");
      setPrefetchJob(started.job);
      prefetchLastUpdatedAt.current = started.job?.updatedAt || null;
      prefetchPollFailures.current = 0;
      if (prefetchPollTimer.current) clearInterval(prefetchPollTimer.current);
      prefetchPollTimer.current = setInterval(() => {
        pollPrefetchJob(jobId);
      }, 3000);
      await pollPrefetchJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePrefetchDay() {
    const savedOffset = prefetchResume?.date === manualDay ? Number(prefetchResume.offset || 0) : 0;
    await startPrefetchDay({ date: manualDay, offset: savedOffset > 0 ? savedOffset : 0 });
  }

  async function handlePrefetchRange() {
    setError(null);
    try {
      const started = await prefetchWfoRange({ from: filters.from, to: filters.to, offset: 0 });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("prefetch_failed");
      setPrefetchJob(started.job);
      prefetchLastUpdatedAt.current = started.job?.updatedAt || null;
      prefetchPollFailures.current = 0;
      if (prefetchPollTimer.current) clearInterval(prefetchPollTimer.current);
      prefetchPollTimer.current = setInterval(() => {
        pollPrefetchJob(jobId);
      }, 3000);
      await pollPrefetchJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function pollTranscribeDayJob(jobId) {
    if (!jobId) return;
    try {
      const job = await fetchAnalysisJob(jobId);
      transcribePollFailures.current = 0;
      if (transcribeDayLastUpdatedAt.current !== job.updatedAt) {
        transcribeDayLastUpdatedAt.current = job.updatedAt;
        setTranscribeDayJob(job);
      }
      if (job.status === "succeeded" || job.status === "failed") {
        if (transcribeDayPollTimer.current) clearInterval(transcribeDayPollTimer.current);
        transcribeDayPollTimer.current = null;
        if (job.status === "failed" && job.error === "wfo_session_expired") {
          const resumeOffset = job.progress?.resumeOffset ?? job.progress?.done ?? 0;
          setPendingResumeSafe({ type: "transcribe", date: job.progress?.date || manualDay, offset: resumeOffset });
          setWfoConfigured(false);
          clearStoredWfoCurl();
        }
      }
    } catch (err) {
      const message = String(err?.message || "transcribe_failed");
      if (message === "service_unreachable") {
        transcribePollFailures.current += 1;
        setError("Service temporarily unavailable. Reconnecting to resume transcription…");
        if (transcribePollFailures.current < 10) return;
      }
      if (message === "job_not_found") {
        const resumeOffset = transcribeDayJob?.progress?.done ?? transcribeResume?.offset ?? 0;
        const resumeDate = transcribeDayJob?.progress?.date || transcribeResume?.date || manualDay;
        if (resumeOffset > 0) {
          setPendingResumeSafe({ type: "transcribe", date: resumeDate, offset: resumeOffset });
          saveStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY, { date: resumeDate, offset: resumeOffset });
          setTranscribeResume({ date: resumeDate, offset: resumeOffset });
        }
        setError("Transcription job was interrupted. You can resume from the saved checkpoint.");
      } else {
        setError(message);
      }
      if (transcribeDayPollTimer.current) clearInterval(transcribeDayPollTimer.current);
      transcribeDayPollTimer.current = null;
    }
  }

  async function startTranscribeDay({ date, offset: resumeOffset = 0, force = false } = {}) {
    setError(null);
    try {
      const selectedDate = date || manualDay;
      if (Number(resumeOffset || 0) <= 0) {
        clearStoredCheckpoint(TRANSCRIBE_RESUME_STORAGE_KEY);
        setTranscribeResume(null);
      }
      const started = await transcribeDay({ date: selectedDate, offset: resumeOffset, force });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("transcribe_failed");
      setTranscribeDayJob(started.job);
      transcribeDayLastUpdatedAt.current = started.job?.updatedAt || null;
      transcribePollFailures.current = 0;
      if (transcribeDayPollTimer.current) clearInterval(transcribeDayPollTimer.current);
      transcribeDayPollTimer.current = setInterval(() => {
        pollTranscribeDayJob(jobId);
      }, 3000);
      await pollTranscribeDayJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleTranscribeDay() {
    const savedOffset = transcribeResume?.date === manualDay ? Number(transcribeResume.offset || 0) : 0;
    await startTranscribeDay({ date: manualDay, offset: savedOffset > 0 ? savedOffset : 0, force: false });
  }

  async function handleTranscribeRange() {
    setError(null);
    try {
      const started = await transcribeRange({ from: filters.from, to: filters.to, offset: 0, force: false });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("transcribe_failed");
      setTranscribeDayJob(started.job);
      transcribeDayLastUpdatedAt.current = started.job?.updatedAt || null;
      transcribePollFailures.current = 0;
      if (transcribeDayPollTimer.current) clearInterval(transcribeDayPollTimer.current);
      transcribeDayPollTimer.current = setInterval(() => {
        pollTranscribeDayJob(jobId);
      }, 3000);
      await pollTranscribeDayJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRefreshTranscriptsDay() {
    const savedOffset = transcribeResume?.date === manualDay ? Number(transcribeResume.offset || 0) : 0;
    await startTranscribeDay({ date: manualDay, offset: savedOffset > 0 ? savedOffset : 0, force: true });
  }

  async function pollBackupPushJob(jobId) {
    if (!jobId) return;
    try {
      const job = await fetchBackupJob(jobId);
      backupPushPollFailures.current = 0;
      if (backupPushLastUpdatedAt.current !== job.updatedAt) {
        backupPushLastUpdatedAt.current = job.updatedAt;
        setBackupPushJob(job);
      }
      if (job.status === "succeeded" || job.status === "failed") {
        if (backupPushPollTimer.current) clearInterval(backupPushPollTimer.current);
        backupPushPollTimer.current = null;
      }
    } catch (err) {
      const message = String(err?.message || "backup_push_failed");
      if (message === "service_unreachable") {
        backupPushPollFailures.current += 1;
        setError("Service temporarily unavailable. Reconnecting to continue ingest update…");
        if (backupPushPollFailures.current < 10) return;
      } else if (message === "job_not_found") {
        setError("Ingest update job was interrupted. Start it again to continue.");
      } else {
        setError(message);
      }
      if (backupPushPollTimer.current) clearInterval(backupPushPollTimer.current);
      backupPushPollTimer.current = null;
    }
  }

  async function startBackupPush({ from, to, useAll = false } = {}) {
    setError(null);
    try {
      const started = await pushBackupRangeToIngest({ from, to, useAll });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("backup_push_failed");
      setBackupPushJob(started.job);
      backupPushLastUpdatedAt.current = started.job?.updatedAt || null;
      backupPushPollFailures.current = 0;
      if (backupPushPollTimer.current) clearInterval(backupPushPollTimer.current);
      backupPushPollTimer.current = setInterval(() => {
        pollBackupPushJob(jobId);
      }, 3000);
      await pollBackupPushJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function startBackupPushDay({ date } = {}) {
    setError(null);
    try {
      const started = await pushBackupDayToIngest({ date });
      const jobId = started?.jobId;
      if (!jobId) throw new Error("backup_push_failed");
      setBackupPushJob(started.job);
      backupPushLastUpdatedAt.current = started.job?.updatedAt || null;
      backupPushPollFailures.current = 0;
      if (backupPushPollTimer.current) clearInterval(backupPushPollTimer.current);
      backupPushPollTimer.current = setInterval(() => {
        pollBackupPushJob(jobId);
      }, 3000);
      await pollBackupPushJob(jobId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBackupPushRange() {
    await startBackupPush({ from: filters.from, to: filters.to, useAll: false });
  }

  async function handleBackupPushDay() {
    await startBackupPushDay({ date: manualDay });
  }

  async function handleBackupPushAll() {
    await startBackupPush({ useAll: true });
  }

  async function handleRunAutomationNow() {
    setAutomationRunning(true);
    setError(null);
    try {
      await runAutomationNow();
      const freshStatus = await fetchAutomationStatus();
      setAutomationStatus(freshStatus);
    } catch (err) {
      setError(err.message);
    } finally {
      setAutomationRunning(false);
    }
  }

  async function loadData(overrideFilters = null) {
    const activeFilters =
      overrideFilters && typeof overrideFilters === "object" && typeof overrideFilters.preventDefault === "function"
        ? filters
        : overrideFilters || filters;
    setLoading(true);
    setError(null);
    try {
      const [summaryData, metricsData, callsData, realtimeData] = await Promise.all([
        fetchSummary(activeFilters),
        fetchMetrics(activeFilters),
        fetchCalls({ ...activeFilters, offset: "0" }),
        fetchRealtime()
      ]);
      setSummary(summaryData);
      setMetrics(metricsData);
      setCalls(callsData.calls || []);
      const total = summaryData?.total_calls ?? 0;
      const initialCount = callsData.calls?.length || 0;
      setOffset(initialCount);
      setHasMore(initialCount < total);
      setRealtime(realtimeData.agents || []);
      try {
        const sessionData = await fetchWfoSession();
        setWfoConfigured(Boolean(sessionData.configured));
        setWfoSessionInfo(sessionData);
      } catch {
        setWfoConfigured(false);
        setWfoSessionInfo(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authed) {
      loadData();
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    async function loadSystemPanels() {
      try {
        const [systemData, automationData] = await Promise.all([fetchSystemInfo(), fetchAutomationStatus()]);
        if (cancelled) return;
        setSystemInfo(systemData);
        setAutomationStatus(automationData);
      } catch {
        if (cancelled) return;
        setSystemInfo(null);
        setAutomationStatus(null);
      }
    }

    loadSystemPanels();
    const timer = setInterval(loadSystemPanels, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authed]);

  useEffect(() => {
    if (!authed || !selectedAutomationMonth) return;

    async function loadMonthStats() {
      try {
        const data = await fetchMonthStats(selectedAutomationMonth);
        setSelectedMonthStats(data?.monthStats || []);
      } catch (error) {
        console.error("Failed to load month stats:", error);
        setSelectedMonthStats([]);
      }
    }

    loadMonthStats();
  }, [authed, selectedAutomationMonth]);

  useEffect(() => {
    if (!authed) return;
    if (!manualDay) return;
    fetchMetrics({ from: manualDay, to: manualDay, agentId: "", campaignId: "" })
      .then((data) => setManualDayMetrics(data))
      .catch(() => setManualDayMetrics(null));
  }, [authed, manualDay]);

  async function loadAgentsView() {
    setMatrixLoading(true);
    setError(null);
    try {
      const data = await fetchAgentsDaily({ from: filters.from, to: filters.to });
      setAgentsDaily(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setMatrixLoading(false);
    }
  }

  async function loadCampaignsView() {
    setMatrixLoading(true);
    setError(null);
    try {
      const data = await fetchCampaignsDaily({ from: filters.from, to: filters.to });
      setCampaignsDaily(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setMatrixLoading(false);
    }
  }

  useEffect(() => {
    if (!authed) return;
    if (activeView === "agents") {
      loadAgentsView();
    }
    if (activeView === "campaigns") {
      loadCampaignsView();
    }
  }, [authed, activeView, filters.from, filters.to]);

  async function handleLogin(e) {
    e.preventDefault();
    setError(null);
    try {
      const token = tokenInput.trim() || extractTokenFromText(curlInput);
      if (!token) {
        throw new Error("Paste a valid web token");
      }
      setManualToken(token);
      if (curlInput.trim()) {
        const session = await saveWfoSession(curlInput);
        saveStoredWfoCurl(curlInput);
        setWfoConfigured(Boolean(session.configured));
        setWfoSessionInfo(session);
      }
      setAuthed(true);
      setActiveView("dashboard");
    } catch (err) {
      setError(err.message);
    }
  }

  function handleExtractToken() {
    const token = extractTokenFromText(curlInput);
    if (!token) {
      setError("Token not found in the provided text");
      return;
    }
    setError(null);
    setTokenInput(token);
  }

  async function handleSyncRange() {
    setSyncingRange(true);
    setError(null);
    try {
      if (!wfoConfigured) {
        throw new Error("Paste the full WFO cURL first to configure the session");
      }
      const result = await syncWfoRange({
        from: filters.from,
        to: filters.to,
        maxPages: Number(wfoMaxPages || 50),
        startPage: Number(wfoStartPage || 1),
        order: "asc",
        uploadBackup: false
      });
      setLastSyncResult(result);
      await loadData(filters);
    } catch (err) {
      const message = String(err?.message || "wfo_sync_range_failed");
      setError(message);
      if (message === "wfo_session_not_configured" || message === "wfo_session_expired") {
        setWfoConfigured(false);
        if (message === "wfo_session_expired") clearStoredWfoCurl();
        try {
          const sessionData = await fetchWfoSession();
          setWfoConfigured(Boolean(sessionData?.configured));
          setWfoSessionInfo(sessionData);
        } catch {
          setWfoSessionInfo(null);
        }
      }
    } finally {
      setSyncingRange(false);
    }
  }

  async function handleSyncDay() {
    const nextFilters = { ...filters, from: manualDay, to: manualDay };
    setFilters(nextFilters);
    setSyncingRange(true);
    setError(null);
    try {
      if (!wfoConfigured) {
        throw new Error("Paste the full WFO cURL first to configure the session");
      }
      const result = await syncWfoRange({
        from: manualDay,
        to: manualDay,
        maxPages: Number(wfoMaxPages || 20),
        startPage: Number(wfoStartPage || 1),
        order: "asc",
        uploadBackup: false
      });
      setLastSyncResult(result);
      await loadData(nextFilters);
      try {
        const dayData = await fetchMetrics({ from: manualDay, to: manualDay, agentId: "", campaignId: "" });
        setManualDayMetrics(dayData);
      } catch {
        // ignore
      }
    } catch (err) {
      const message = String(err?.message || "wfo_sync_range_failed");
      setError(message);
      if (message === "wfo_session_not_configured" || message === "wfo_session_expired") {
        setWfoConfigured(false);
        if (message === "wfo_session_expired") clearStoredWfoCurl();
        try {
          const sessionData = await fetchWfoSession();
          setWfoConfigured(Boolean(sessionData?.configured));
          setWfoSessionInfo(sessionData);
        } catch {
          setWfoSessionInfo(null);
        }
      }
    } finally {
      setSyncingRange(false);
    }
  }

  async function handleSyncDaySplit() {
    const nextFilters = { ...filters, from: manualDay, to: manualDay };
    setFilters(nextFilters);
    setSyncingRange(true);
    setError(null);
    try {
      if (!wfoConfigured) {
        throw new Error("Paste the full WFO cURL first to configure the session");
      }
      const result = await syncWfoDaySplit({
        date: manualDay,
        maxPages: Number(wfoMaxPages || 50),
        order: "asc",
        uploadBackup: false
      });
      setLastSyncResult(result);
      await loadData(nextFilters);
      try {
        const dayData = await fetchMetrics({ from: manualDay, to: manualDay, agentId: "", campaignId: "" });
        setManualDayMetrics(dayData);
      } catch {
        // ignore
      }
    } catch (err) {
      const message = String(err?.message || "wfo_sync_range_failed");
      setError(message);
      if (message === "wfo_session_not_configured" || message === "wfo_session_expired") {
        setWfoConfigured(false);
        if (message === "wfo_session_expired") clearStoredWfoCurl();
        try {
          const sessionData = await fetchWfoSession();
          setWfoConfigured(Boolean(sessionData?.configured));
          setWfoSessionInfo(sessionData);
        } catch {
          setWfoSessionInfo(null);
        }
      }
    } finally {
      setSyncingRange(false);
    }
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
    setActiveView("dashboard");
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const callsData = await fetchCalls({ ...filters, offset: String(offset) });
      const nextCalls = callsData.calls || [];
      const total = summary?.total_calls ?? 0;
      setCalls((prev) => [...prev, ...nextCalls]);
      const nextOffset = offset + nextCalls.length;
      setOffset(nextOffset);
      setHasMore(nextOffset < total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleScroll(e) {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 120) {
      loadMore();
    }
  }

  if (!authed) {
    return (
      <div className="login">
        <div className="login-card">
          <form className="login-panel" onSubmit={handleLogin}>
            <h2>Five9 Command Center</h2>
            <p>Open Five9, copy your token, and paste it here to continue.</p>
            <div className="login-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => window.open("https://app.five9.com/", "_blank", "noopener,noreferrer")}
              >
                Open Five9 Login
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() =>
                  window.open(
                    "https://app-atl.five9.com/clients/supervisor/index.html?role=DomainSupervisor",
                    "_blank",
                    "noopener,noreferrer"
                  )
                }
              >
                Open Supervisor
              </button>
            </div>
            <input
              className="input"
              placeholder="Bearer token (without 'Bearer ')"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <textarea
              className="input login-textarea"
              placeholder="Paste a cURL or headers here (we can extract the token automatically)"
              value={curlInput}
              onChange={(e) => setCurlInput(e.target.value)}
            />
            <div className="login-actions">
              <button className="button button-secondary" type="button" onClick={handleExtractToken}>
                Extract token from text
              </button>
            </div>
            <div style={{ height: 16 }} />
            <button className="button" type="submit">
              Sign in
            </button>
            <p className="login-hint">
              Five9 blocks embedded logins. Use the token from DevTools.
            </p>
            {error && <p style={{ color: "#f25f5c" }}>{userErrorMessage(error)}</p>}
          </form>
          <div className="login-guide">
            <div className="login-guide-header">Quick guide (step-by-step)</div>
            <div className="login-step-card">
              <div className="login-shot">
                <img src="/guide/step1.svg" alt="Step 1" />
              </div>
              <div>
                <strong>Sign in</strong>
                <p>Go to https://app.five9.com/ and authenticate.</p>
              </div>
            </div>
            <div className="login-step-card">
              <div className="login-shot">
                <img src="/guide/step2.svg" alt="Step 2" />
              </div>
              <div>
                <strong>Supervisor</strong>
                <p>Open Supervisor with the DomainSupervisor role.</p>
              </div>
            </div>
            <div className="login-step-card">
              <div className="login-shot">
                <img src="/guide/step3.svg" alt="Step 3" />
              </div>
              <div>
                <strong>Open Five9 WEM</strong>
                <p>Click the WEM button in the top bar.</p>
              </div>
            </div>
            <div className="login-step-card">
              <div className="login-shot">
                <img src="/guide/step4.svg" alt="Step 4" />
              </div>
              <div>
                <strong>Token</strong>
                <p>DevTools → Network → Authorization: Bearer.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>Five9</span>
          <strong>Agent Pulse</strong>
        </div>
        <div className="nav-section">
          <button
            type="button"
            className={`nav-item ${activeView === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveView("dashboard")}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`nav-item ${activeView === "agents" ? "active" : ""}`}
            onClick={() => setActiveView("agents")}
          >
            Agents
          </button>
          <button
            type="button"
            className={`nav-item ${activeView === "campaigns" ? "active" : ""}`}
            onClick={() => setActiveView("campaigns")}
          >
            Campaigns
          </button>
          <button
            type="button"
            className={`nav-item ${activeView === "wfo" ? "active" : ""}`}
            onClick={() => setActiveView("wfo")}
          >
            WFO Setup
          </button>
        </div>
        <div className="nav-section">
          <button className="button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        {activeView === "agents" && (
          <>
            <div className="header">
              <div>
                <h1>Agents</h1>
                <small>
                  Daily totals ({filters.from} → {filters.to})
                </small>
              </div>
              <div className="badge">Timezone: {agentsDaily?.timezone || "America/Bogota"}</div>
            </div>

            <div className="filters">
              <div className="field">
                <div className="field-label">From</div>
                <input
                  className="input"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field-label">To</div>
                <input
                  className="input"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                />
              </div>
              <button className="button" onClick={loadAgentsView} disabled={matrixLoading}>
                {matrixLoading ? "Loading" : "Refresh"}
              </button>
            </div>

            <AgentsMatrixTable rows={agentsDaily?.rows || []} days={buildDayList(filters.from, filters.to)} />
            {error && <p style={{ color: "#f25f5c" }}>{userErrorMessage(error)}</p>}
          </>
        )}

        {activeView === "campaigns" && (
          <>
            <div className="header">
              <div>
                <h1>Campaigns</h1>
                <small>
                  Daily totals ({filters.from} → {filters.to})
                </small>
              </div>
              <div className="badge">Timezone: {campaignsDaily?.timezone || "America/Bogota"}</div>
            </div>

            <div className="filters">
              <div className="field">
                <div className="field-label">From</div>
                <input
                  className="input"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field-label">To</div>
                <input
                  className="input"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                />
              </div>
              <button className="button" onClick={loadCampaignsView} disabled={matrixLoading}>
                {matrixLoading ? "Loading" : "Refresh"}
              </button>
            </div>

            <CampaignsMatrixTable rows={campaignsDaily?.rows || []} days={buildDayList(filters.from, filters.to)} />
            {error && <p style={{ color: "#f25f5c" }}>{userErrorMessage(error)}</p>}
          </>
        )}

        {activeView === "dashboard" && (
          <>
            <div className="header">
              <div>
                <h1>Calls overview</h1>
                <small>Updated {new Date().toLocaleString()}</small>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <div className="badge">Realtime: {realtime.length}</div>
                <div className="badge">WFO: {wfoConfigured ? "Ready" : "Not configured"}</div>
              </div>
            </div>

            <div className="filters">
              <div className="field">
                <div className="field-label">From</div>
                <input
                  className="input"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field-label">To</div>
                <input
                  className="input"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field-label">Agent ID</div>
                <input
                  className="input"
                  placeholder="Optional"
                  value={filters.agentId}
                  onChange={(e) => setFilters({ ...filters, agentId: e.target.value })}
                />
              </div>
              <div className="field">
                <div className="field-label">Campaign ID</div>
                <input
                  className="input"
                  placeholder="Optional"
                  value={filters.campaignId}
                  onChange={(e) => setFilters({ ...filters, campaignId: e.target.value })}
                />
              </div>
              <button className="button" onClick={() => loadData()} disabled={loading}>
                {loading ? "Loading" : "Refresh"}
              </button>
              <button className="button button-secondary" type="button" onClick={() => setActiveView("wfo")}>
                Open WFO setup
              </button>
            </div>

            <div className="cards">
              <div className="card">
                <h3>Total calls</h3>
                <div className="metric">{summary?.total_calls ?? 0}</div>
              </div>
              {filters.from === filters.to && (
                <div className="card">
                  <h3>Total (selected day)</h3>
                  <div className="metric">{metrics?.total_calls ?? 0}</div>
                </div>
              )}
              <div className="card">
                <h3>Avg duration</h3>
                <div className="metric">{formatDuration(summary?.avg_duration_sec)}</div>
              </div>
              <div className="card">
                <h3>Answered</h3>
                <div className="metric">{summary?.answered_calls ?? 0}</div>
              </div>
              <div className="card">
                <h3>Missed</h3>
                <div className="metric">{summary?.missed_calls ?? 0}</div>
              </div>
            </div>

            {filters.from === filters.to && (
              <div className="cards">
                <div className="card">
                  <h3>First call</h3>
                  <div className="metric" style={{ fontSize: 18 }}>
                    {formatDateTime(metrics?.first_call_start_time)}
                  </div>
                </div>
                <div className="card">
                  <h3>Last call</h3>
                  <div className="metric" style={{ fontSize: 18 }}>
                    {formatDateTime(metrics?.last_call_start_time)}
                  </div>
                </div>
              </div>
            )}

            <div className="table-wrapper" onScroll={handleScroll}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Call ID</th>
                    <th>Start Time</th>
                    <th>Agent</th>
                    <th>ANI</th>
                    <th>DNIS</th>
                    <th>Duration</th>
                    <th>Direction</th>
                    <th>Result</th>
                    <th>Media</th>
                    <th>Transcript</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => {
                    const hasLocalAudio = Boolean(call.has_local_audio);
                    const hasLocalScreen = Boolean(call.has_local_screen);
                    const hasTranscript = Boolean(call.analysis_ready);

                    return (
                      <tr key={call.call_id}>
                        <td>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{call.call_id || "-"}</span>
                          </div>
                        </td>
                        <td>{call.start_time ? new Date(call.start_time).toLocaleString() : "-"}</td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span className="avatar">{getAgentInitials(call)}</span>
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <span>{call.agent_name || [call.agent_first_name, call.agent_last_name].filter(Boolean).join(" ") || "-"}</span>
                              <small style={{ color: "#a7b1c7" }}>{call.agent_id || "-"}</small>
                            </div>
                          </div>
                        </td>
                        <td>{call.ani || "-"}</td>
                        <td>{call.dnis || "-"}</td>
                        <td>{formatDuration(call.duration_sec)}</td>
                        <td>{call.direction || call.event_dir || "-"}</td>
                        <td>{call.result_code ?? "-"}</td>
                        <td>
                          <div className="media-actions media-actions-compact">
                            <button
                              className={`icon-button ${hasLocalAudio ? "is-ready" : "is-muted"}`}
                              type="button"
                              title={
                                hasLocalAudio
                                  ? `Open local audio${call.local_audio_path ? ` (${call.local_audio_path})` : ""}`
                                  : "Audio not downloaded yet"
                              }
                              onClick={() =>
                                hasLocalAudio
                                  ? downloadFile(`/api/wfo/calls/${encodeURIComponent(call.call_id)}/audio`, call.call_id)
                                  : undefined
                              }
                              disabled={!hasLocalAudio}
                            >
                              <span aria-hidden>📞</span>
                            </button>
                            <button
                              className={`icon-button ${hasLocalScreen ? "is-ready" : "is-muted"}`}
                              type="button"
                              title={
                                hasLocalScreen
                                  ? `Open local screen${call.local_screen_path ? ` (${call.local_screen_path})` : ""}`
                                  : "Screen not downloaded yet"
                              }
                              onClick={() =>
                                hasLocalScreen
                                  ? downloadFile(`/api/wfo/calls/${encodeURIComponent(call.call_id)}/screen`, call.call_id)
                                  : undefined
                              }
                              disabled={!hasLocalScreen}
                            >
                              <span aria-hidden>🖥️</span>
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="media-actions media-actions-compact">
                            <button
                              className={`icon-button ${hasTranscript ? "is-ready" : "is-muted"}`}
                              type="button"
                              title={hasTranscript ? "Open local transcript" : "Transcript not available yet"}
                              onClick={() => (hasTranscript ? openTranscript(call.call_id) : undefined)}
                              disabled={!hasTranscript}
                            >
                              <span aria-hidden>📄</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {loadingMore && <p style={{ padding: "12px 8px", color: "#a7b1c7" }}>Loading more...</p>}
            </div>
            {analysisModal && (
              <div className="modal-overlay" role="dialog" aria-modal="true">
                <div className="modal">
                  <div className="modal-header">
                    <div>
                      <div className="panel-title">Transcript</div>
                      <div className="panel-subtitle">Call ID: {analysisModal.call_id || analysisModal.callId}</div>
                    </div>
                    <button className="icon-button" type="button" title="Close" onClick={() => setAnalysisModal(null)}>
                      <span aria-hidden>✕</span>
                    </button>
                  </div>
                  <div className="modal-meta">
                    <div className="badge">Overall sentiment: {analysisModal.sentiment_label || "-"}</div>
                    <div className="badge">Overall score: {formatScoreValue(analysisModal.sentiment_score)}</div>
                    <div className="badge">
                      Patient sentiment: {analysisSpeakerSentiment?.patient?.sentiment_label || "-"}
                    </div>
                    <div className="badge">Agent sentiment: {analysisSpeakerSentiment?.agent?.sentiment_label || "-"}</div>
                    <div className="badge">Language: {analysisModal.language || "-"}</div>
                    <div className="badge">Provider: {analysisModal.provider || "-"}</div>
                  </div>
                  <div className="analysis-metrics-grid">
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Overall quality</div>
                      <div className="analysis-metric-value">
                        {formatScoreValue(analysisQualityMetrics?.overall_quality_score)}
                      </div>
                      <div className="analysis-metric-hint">{analysisQualityMetrics?.overall_quality_label || "-"}</div>
                    </div>
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Empathy</div>
                      <div className="analysis-metric-value">{formatScoreValue(analysisQualityMetrics?.empathy_score)}</div>
                    </div>
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Professionalism</div>
                      <div className="analysis-metric-value">
                        {formatScoreValue(analysisQualityMetrics?.professionalism_score)}
                      </div>
                    </div>
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Clarity</div>
                      <div className="analysis-metric-value">{formatScoreValue(analysisQualityMetrics?.clarity_score)}</div>
                    </div>
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Resolution</div>
                      <div className="analysis-metric-value">
                        {formatScoreValue(analysisQualityMetrics?.resolution_score)}
                      </div>
                    </div>
                    <div className="analysis-metric-card">
                      <div className="analysis-metric-label">Patient experience</div>
                      <div className="analysis-metric-value">
                        {formatScoreValue(analysisQualityMetrics?.patient_experience_score)}
                      </div>
                    </div>
                  </div>
                  <div className="analysis-report-grid">
                    <div className="analysis-report-card">
                      <div className="analysis-report-title">Patient report</div>
                      <div className="analysis-report-summary">
                        {analysisReport?.patient?.summary || analysisSpeakerSentiment?.patient?.summary || "No patient report yet."}
                      </div>
                      <div className="analysis-report-section-label">Main concerns</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.patient?.main_concerns).length ? (
                          asArray(analysisReport?.patient?.main_concerns).map((item, index) => (
                            <span className="analysis-pill" key={`patient-concern-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No major concerns flagged</span>
                        )}
                      </div>
                      <div className="analysis-report-section-label">Likely needs</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.patient?.likely_needs).length ? (
                          asArray(analysisReport?.patient?.likely_needs).map((item, index) => (
                            <span className="analysis-pill" key={`patient-need-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No needs identified</span>
                        )}
                      </div>
                      <div className="analysis-report-footnote">
                        {analysisReport?.patient?.satisfaction_outlook || "No patient outlook available."}
                      </div>
                    </div>
                    <div className="analysis-report-card">
                      <div className="analysis-report-title">Agent report</div>
                      <div className="analysis-report-summary">
                        {analysisReport?.agent?.summary || analysisSpeakerSentiment?.agent?.summary || "No agent report yet."}
                      </div>
                      <div className="analysis-report-section-label">Strengths</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.agent?.strengths).length ? (
                          asArray(analysisReport?.agent?.strengths).map((item, index) => (
                            <span className="analysis-pill" key={`agent-strength-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No strengths highlighted</span>
                        )}
                      </div>
                      <div className="analysis-report-section-label">Coaching opportunities</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.agent?.coaching_opportunities).length ? (
                          asArray(analysisReport?.agent?.coaching_opportunities).map((item, index) => (
                            <span className="analysis-pill" key={`agent-coaching-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No coaching opportunities highlighted</span>
                        )}
                      </div>
                      <div className="analysis-report-footnote">
                        Quality score: {formatScoreValue(analysisReport?.agent?.quality_score)}
                      </div>
                    </div>
                    <div className="analysis-report-card">
                      <div className="analysis-report-title">Overall report</div>
                      <div className="analysis-report-summary">
                        {analysisReport?.overall?.summary || analysisSentiment?.summary || "No overall report available."}
                      </div>
                      <div className="analysis-report-section-label">Recommendations</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.overall?.recommendations).length ? (
                          asArray(analysisReport?.overall?.recommendations).map((item, index) => (
                            <span className="analysis-pill" key={`overall-rec-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No recommendations generated</span>
                        )}
                      </div>
                      <div className="analysis-report-section-label">Risk flags</div>
                      <div className="analysis-pill-list">
                        {asArray(analysisReport?.overall?.risk_flags).length ? (
                          asArray(analysisReport?.overall?.risk_flags).map((item, index) => (
                            <span className="analysis-pill" key={`overall-risk-${index}`}>
                              {item}
                            </span>
                          ))
                        ) : (
                          <span className="analysis-pill analysis-pill-muted">No risk flags</span>
                        )}
                      </div>
                      <div className="analysis-report-footnote">
                        Resolution: {analysisReport?.overall?.resolution_status || "-"} • Quality:{" "}
                        {analysisReport?.overall?.call_quality_label || analysisQualityMetrics?.overall_quality_label || "-"}
                      </div>
                    </div>
                  </div>
                  {hasSeparatedTranscript(analysisModal) ? (
                    <div className="transcript-split">
                      <div className="transcript-columns">
                        <div className="transcript-card">
                          <div className="transcript-card-title">Agent</div>
                          <pre className="modal-body transcript-card-body">
                            {getSpeakerSeparation(analysisModal)?.agent_text || "No agent transcript detected."}
                          </pre>
                        </div>
                        <div className="transcript-card">
                          <div className="transcript-card-title">Patient</div>
                          <pre className="modal-body transcript-card-body">
                            {getSpeakerSeparation(analysisModal)?.patient_text || "No patient transcript detected."}
                          </pre>
                        </div>
                      </div>
                      <div className="transcript-card">
                        <div className="transcript-card-title">
                          Conversation turns
                          <span className="transcript-card-hint">
                            {` ${getSpeakerSeparation(analysisModal)?.strategy || "speaker_separation"} • ${getSpeakerSeparation(analysisModal)?.confidence || "unknown"
                              }`}
                          </span>
                        </div>
                        <div className="transcript-chat">
                          {(getSpeakerSeparation(analysisModal)?.turns || []).map((turn, index) => (
                            <div
                              key={turn.id ?? `${turn.speaker}-${index}`}
                              className={`transcript-chat-row transcript-chat-row-${turn.speaker || "unknown"}`}
                            >
                              <div
                                className={`transcript-chat-avatar transcript-chat-avatar-${turn.speaker || "unknown"}`}
                                title={turn.speaker === "agent" ? analysisAgentLabel : "Patient"}
                              >
                                {turn.speaker === "agent" ? analysisAgentInitials : <span aria-hidden>👤</span>}
                              </div>
                              <div className={`transcript-chat-bubble transcript-chat-bubble-${turn.speaker || "unknown"}`}>
                                <div className="transcript-chat-speaker">
                                  {turn.speaker === "agent" ? analysisAgentLabel : "Patient"}
                                </div>
                                <div className="transcript-chat-text">{turn.text || "-"}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="badge" style={{ marginBottom: 12 }}>
                        Speaker split not rebuilt yet. Use “Refresh transcripts (selected day)” to regenerate old transcripts.
                      </div>
                      <pre className="modal-body">{analysisModal.transcript_text || "No transcript available."}</pre>
                    </>
                  )}
                  {analysisModal.sentiment_json?.summary && (
                    <div className="modal-summary">
                      <div className="panel-title">Summary</div>
                      <div className="panel-subtitle">{analysisModal.sentiment_json.summary}</div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {attachModal && (
              <div className="modal-overlay" role="dialog" aria-modal="true">
                <div className="modal">
                  <div className="modal-header">
                    <div>
                      <div className="panel-title">Attach WFO report URL</div>
                      <div className="panel-subtitle">
                        Paste the WFO report link that contains <strong>ul=...</strong> (index.html or wfoplayer).
                      </div>
                    </div>
                    <button className="icon-button" type="button" title="Close" onClick={() => setAttachModal(null)}>
                      <span aria-hidden>✕</span>
                    </button>
                  </div>
                  <div className="filters" style={{ marginBottom: 0 }}>
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <div className="field-label">Report URL</div>
                      <input
                        className="input"
                        placeholder="https://cloud....wfo.five9.com/five9wfo/index.html?ul=...&widget="
                        value={attachModal.reportUrl}
                        onChange={(e) => setAttachModal({ ...attachModal, reportUrl: e.target.value })}
                      />
                    </div>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => handleAttachReport(attachModal.callId, attachModal.reportUrl)}
                      disabled={attaching}
                    >
                      {attaching ? "Saving..." : "Save"}
                    </button>
                    <button className="button" type="button" onClick={() => setAttachModal(null)} disabled={attaching}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
            {error && <p style={{ color: "#f25f5c" }}>{userErrorMessage(error)}</p>}
          </>
        )}

        {activeView === "wfo" && (
          <>
            <div className="header">
              <div>
                <h1>WFO setup</h1>
                <small>Configure session, validate it, and sync data into the local database.</small>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <div className="badge">Timezone: {systemInfo?.reports?.timezone || "America/Bogota"}</div>
                <div className="badge">Service: {systemInfo?.service?.port ? `:${systemInfo.service.port}` : "-"}</div>
              </div>
            </div>

            <div className="wfo-grid">
              <div className="wfo-session-panel">
                <div>
                  <div className="panel-title">WFO Session (cURL)</div>
                  <div className="panel-subtitle">
                    Paste the full request so we can reuse headers, cookies, and payload. This may contain sensitive
                    tokens.
                  </div>
                </div>
                <textarea
                  className="input login-textarea curl-textarea"
                  placeholder="Paste the full WFO cURL here (it can be very long) to refresh token, cookies, and payload"
                  value={curlInput}
                  onChange={(e) => setCurlInput(e.target.value)}
                  spellCheck={false}
                />
                <div className="login-actions">
                  <button
                    className="button button-secondary"
                    onClick={async () => {
                      try {
                        setError(null);
                        const token = extractTokenFromText(curlInput);
                        if (token) {
                          setManualToken(token);
                          setTokenInput(token);
                        }
                        const session = await saveWfoSession(curlInput);
                        saveStoredWfoCurl(curlInput);
                        setWfoConfigured(Boolean(session.configured));
                        setWfoSessionInfo(session);
                        try {
                          const result = await validateWfoSession();
                          setWfoValidation({ ok: true, at: new Date().toISOString(), ...result });
                          await maybeAutoResume();
                        } catch (validationError) {
                          setWfoValidation({ ok: false, at: new Date().toISOString(), error: validationError.message });
                        }
                      } catch (err) {
                        setError(err.message);
                      }
                    }}
                  >
                    Configure WFO session from cURL
                  </button>
                  <label className="button button-secondary" style={{ cursor: "pointer" }} title="Import a Chrome HAR file to auto-configure the WFO session.">
                    Import HAR
                    <input
                      type="file"
                      accept=".har,application/json"
                      style={{ display: "none" }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        try {
                          setError(null);
                          setHarImportInfo(null);
                          const text = await file.text();
                          const har = JSON.parse(text);
                          const best = extractHarBestSession(har);
                          if (!best?.url) throw new Error("Invalid HAR: no InteractionRecordings/GetAll request found");
                          const token = extractTokenFromText(best.headers.authorization || "");
                          if (token) {
                            setManualToken(token);
                            setTokenInput(token);
                          }
                          const session = await saveWfoSessionHar(best);
                          setWfoConfigured(Boolean(session.configured));
                          setWfoSessionInfo(session);
                          setHarImportInfo({
                            fileName: file.name,
                            selectedUrl: best.url,
                            hasCookie: Boolean(best.headers.cookie),
                            hasToken: Boolean(best.headers.authorization)
                          });
                          try {
                            const result = await validateWfoSession();
                            setWfoValidation({ ok: true, at: new Date().toISOString(), ...result });
                            await maybeAutoResume();
                          } catch (validationError) {
                            setWfoValidation({ ok: false, at: new Date().toISOString(), error: validationError.message });
                          }
                        } catch (err) {
                          setError(err.message);
                        }
                      }}
                    />
                  </label>
                  <button
                    className="button button-secondary"
                    onClick={async () => {
                      try {
                        setError(null);
                        const result = await validateWfoSession();
                        setWfoValidation({ ok: true, at: new Date().toISOString(), ...result });
                        await maybeAutoResume();
                      } catch (err) {
                        setWfoValidation({ ok: false, at: new Date().toISOString(), error: err.message });
                        setError(err.message);
                      }
                    }}
                    disabled={!wfoConfigured}
                  >
                    Test WFO session
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => {
                      clearStoredWfoCurl();
                      setCurlInput("");
                      setHarImportInfo(null);
                    }}
                  >
                    Clear stored cURL
                  </button>
                  <button className="button" type="button" onClick={() => setActiveView("dashboard")}>
                    Back to dashboard
                  </button>
                </div>
                {harImportInfo && (
                  <div className="badge" style={{ marginTop: 10 }}>
                    HAR imported: {harImportInfo.fileName} • Cookie: {harImportInfo.hasCookie ? "Yes" : "No"} • Token:{" "}
                    {harImportInfo.hasToken ? "Yes" : "No"}
                  </div>
                )}
              </div>

              <div className="wfo-side">
                <div className="wfo-side-grid">
                  <div className="card card-compact">
                    <h3>WFO Status</h3>
                    <div className="metric">{wfoConfigured ? "Ready" : "Missing"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Page Size</h3>
                    <div className="metric">{wfoSessionInfo?.pageSize ?? "-"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Cookie</h3>
                    <div className="metric">{wfoSessionInfo?.hasCookie ? "Yes" : "No"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Token</h3>
                    <div className="metric">{wfoSessionInfo?.hasToken ? "Yes" : "No"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>WFO Test</h3>
                    <div className="metric">{wfoValidation?.ok ? "OK" : wfoValidation?.error ? "Failed" : "-"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Test Time</h3>
                    <div className="metric">{wfoValidation?.at ? formatDateTime(wfoValidation.at) : "-"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Auth Mode</h3>
                    <div className="metric">{systemInfo?.auth?.mode || "-"}</div>
                  </div>
                  <div className="card card-compact">
                    <h3>Backup Host</h3>
                    <div className="metric">
                      {systemInfo?.backup?.endpointConfigured ? systemInfo?.backup?.endpointHost || "-" : "-"}
                    </div>
                  </div>
                </div>

                <div className="wfo-side-grid wfo-side-grid-2">
                  <div className="card card-compact">
                    <h3>Selected day: first call</h3>
                    <div className="metric" style={{ fontSize: 16 }}>
                      {formatDateTime(manualDayMetrics?.first_call_start_time)}
                    </div>
                  </div>
                  <div className="card card-compact">
                    <h3>Selected day: last call</h3>
                    <div className="metric" style={{ fontSize: 16 }}>
                      {formatDateTime(manualDayMetrics?.last_call_start_time)}
                    </div>
                  </div>
                  <div className="card card-compact">
                    <h3>Selected day total</h3>
                    <div className="metric">{manualDayMetrics?.total_calls ?? 0}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <div className="panel-title">Automation</div>
                  <div className="panel-subtitle">
                    Every hour the app can sync the current day, prefetch media, transcribe locally, and keep filling missing days from the current month.
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <div className="badge">
                    Automation: {automationStatus?.enabled ? "Enabled" : "Disabled"}
                  </div>
                  <div className="badge">
                    Schedule: {automationStatus?.cron || systemInfo?.automation?.cron || "0 * * * *"}
                  </div>
                  <div className="badge">
                    Timezone: {automationStatus?.timezone || systemInfo?.automation?.timezone || "America/Bogota"}
                  </div>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={handleRunAutomationNow}
                    disabled={automationRunning || automationStatus?.running}
                    title="Runs the hourly workflow now: current day sync + prefetch + local transcription, then continues with missing days in the current month."
                  >
                    {automationRunning || automationStatus?.running ? "Automation running…" : "Run automation now"}
                  </button>
                </div>
              </div>

              <div className="automation-summary-grid">
                <div className="card card-compact">
                  <h3>Current phase</h3>
                  <div className="metric">{automationStatus?.currentTask?.phase || (automationStatus?.running ? "Running" : "Idle")}</div>
                </div>
                <div className="card card-compact">
                  <h3>Processing day</h3>
                  <div className="metric">{automationStatus?.currentTask?.date || "-"}</div>
                </div>
                <div className="card card-compact">
                  <h3>Mode</h3>
                  <div className="metric">{automationStatus?.currentTask?.mode || "-"}</div>
                </div>
                <div className="card card-compact">
                  <h3>Last run</h3>
                  <div className="metric" style={{ fontSize: 16 }}>
                    {automationStatus?.lastRun?.finishedAt ? formatDateTime(automationStatus.lastRun.finishedAt) : "-"}
                  </div>
                </div>
                <div className="card card-compact">
                  <h3>Pending backfill days</h3>
                  <div className="metric">{automationStatus?.backfill?.pendingDates?.length ?? 0}</div>
                </div>
                <div className="card card-compact">
                  <h3>Processed this cycle</h3>
                  <div className="metric">{automationStatus?.backfill?.processedDates?.length ?? 0}</div>
                </div>
              </div>

              <div className="automation-calendar">
                <div className="automation-calendar-controls">
                  <button
                    className="button button-small button-secondary"
                    onClick={() => setSelectedAutomationMonth(adjustMonth(selectedAutomationMonth, -1))}
                  >
                    ← Prev
                  </button>
                  <h3 className="automation-calendar-title">{getMonthDisplayName(selectedAutomationMonth)}</h3>
                  <button
                    className="button button-small button-secondary"
                    onClick={() => setSelectedAutomationMonth(adjustMonth(selectedAutomationMonth, 1))}
                  >
                    Next →
                  </button>
                </div>
                <div className="automation-calendar-header">
                  <div className="automation-weekday">Mon</div>
                  <div className="automation-weekday">Tue</div>
                  <div className="automation-weekday">Wed</div>
                  <div className="automation-weekday">Thu</div>
                  <div className="automation-weekday">Fri</div>
                </div>
                {buildAutomationCalendarWeeks(selectedMonthStats || []).map((week, weekIdx) => (
                  <div key={`week-${weekIdx}`} className="automation-calendar-week">
                    {week.map((day, dayIdx) =>
                      day ? (
                        <div
                          key={day.date}
                          className={`automation-calendar-day automation-calendar-day-${day.status || "pending"}`}
                          onClick={() => setSelectedAutomationDay(day)}
                          style={{ cursor: "pointer" }}
                        >
                          <div className="automation-calendar-date">{day.date.split("-")[2]}</div>
                          <div className="automation-calendar-status">{automationStatusLabel(day)}</div>
                          <div className="automation-calendar-mini">
                            <div className="automation-calendar-mini-item">
                              {day.totalCalls || 0}c
                            </div>
                            <div className="automation-calendar-mini-item">
                              {day.audioProcessed || 0}a
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div key={`empty-${dayIdx}`} className="automation-calendar-day automation-calendar-day-empty"></div>
                      )
                    )}
                  </div>
                ))}
              </div>

              {selectedAutomationDay && (
                <div className="modal-overlay" onClick={() => setSelectedAutomationDay(null)}>
                  <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                    <div className="modal-header">
                      <h2>{selectedAutomationDay.date}</h2>
                      <button className="modal-close" onClick={() => setSelectedAutomationDay(null)}>×</button>
                    </div>
                    <div className="modal-body">
                      <div className="modal-grid">
                        <div className="modal-item">
                          <div className="modal-label">Status</div>
                          <div className="modal-value">{automationStatusLabel(selectedAutomationDay)}</div>
                        </div>
                        <div className="modal-item">
                          <div className="modal-label">Total Calls</div>
                          <div className="modal-value">{selectedAutomationDay.totalCalls || 0}</div>
                        </div>
                        <div className="modal-item">
                          <div className="modal-label">Audio Processed</div>
                          <div className="modal-value">{selectedAutomationDay.audioProcessed || 0}</div>
                        </div>
                        <div className="modal-item">
                          <div className="modal-label">Audio Local</div>
                          <div className="modal-value">{selectedAutomationDay.audioLocal || 0}</div>
                        </div>
                        <div className="modal-item">
                          <div className="modal-label">Screen Local</div>
                          <div className="modal-value">{selectedAutomationDay.screenLocal || 0}</div>
                        </div>
                        <div className="modal-item">
                          <div className="modal-label">Transcripts</div>
                          <div className="modal-value">{selectedAutomationDay.transcriptCount || 0}</div>
                        </div>
                      </div>
                      <div className="modal-flags">
                        <div className="modal-flag-group">
                          <span className="modal-flag-label">Sync:</span>
                          <span className={`modal-flag modal-flag-${selectedAutomationDay.syncStatus}`}>{selectedAutomationDay.syncStatus}</span>
                        </div>
                        <div className="modal-flag-group">
                          <span className="modal-flag-label">Media:</span>
                          <span className={`modal-flag modal-flag-${selectedAutomationDay.prefetchStatus}`}>{selectedAutomationDay.prefetchStatus}</span>
                        </div>
                        <div className="modal-flag-group">
                          <span className="modal-flag-label">Transcript:</span>
                          <span className={`modal-flag modal-flag-${selectedAutomationDay.transcribeStatus}`}>{selectedAutomationDay.transcribeStatus}</span>
                        </div>
                        <div className="modal-flag-group">
                          <span className="modal-flag-label">Ingest:</span>
                          <span className={`modal-flag modal-flag-${selectedAutomationDay.backupStatus}`}>{selectedAutomationDay.backupStatus}</span>
                        </div>
                      </div>
                      {selectedAutomationDay.lastError && (
                        <div className="modal-error">
                          <strong>Error:</strong> {userErrorMessage(selectedAutomationDay.lastError)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="section">
              <div className="section-header">
                <div>
                  <div className="panel-title">Sync tools</div>
                  <div className="panel-subtitle">Load WFO recordings into the database so they appear on the dashboard.</div>
                </div>
                {lastSyncResult && (
                  <div className="badge">
                    Last sync: inserted {lastSyncResult.inserted ?? 0}, backup{" "}
                    {lastSyncResult.backup?.pushed ?? lastSyncResult.backupPushed ?? 0}
                  </div>
                )}
              </div>

              <div className="filters">
                <div className="field">
                  <div className="field-label">Range from</div>
                  <input
                    className="input"
                    type="date"
                    value={filters.from}
                    onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-label">Range to</div>
                  <input
                    className="input"
                    type="date"
                    value={filters.to}
                    onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-label">WFO start page</div>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    value={wfoStartPage}
                    onChange={(e) => setWfoStartPage(e.target.value)}
                  />
                </div>
                <div className="field">
                  <div className="field-label">WFO max pages</div>
                  <input
                    className="input"
                    type="number"
                    min="1"
                    value={wfoMaxPages}
                    onChange={(e) => setWfoMaxPages(e.target.value)}
                  />
                </div>
                <button className="button button-secondary" onClick={handleSyncRange} disabled={syncingRange}>
                  {syncingRange ? "Syncing" : "Sync range"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleBackupPushRange}
                  disabled={!systemInfo?.backup?.endpointConfigured || backupPushJob?.status === "running"}
                  title="Pushes calls in the selected range to ingest.php so MySQL receives the latest calls, transcript, sentiment, and raw_json."
                >
                  {backupPushJob?.status === "running" ? "Updating ingest…" : "Update ingest (selected range)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleBackupPushAll}
                  disabled={!systemInfo?.backup?.endpointConfigured || backupPushJob?.status === "running"}
                  title="Pushes ALL local calls to ingest.php (can be large). Prefer the selected range/day buttons when possible."
                >
                  {backupPushJob?.status === "running" ? "Updating ingest…" : "Update ingest (ALL local data)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handlePrefetchRange}
                  disabled={!wfoConfigured || syncingRange || prefetchJob?.status === "running"}
                  title="Downloads audio/screen only for calls that are missing local media in the selected range."
                >
                  {prefetchJob?.status === "running" ? "Prefetching range…" : "Prefetch media (selected range)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleTranscribeRange}
                  disabled={syncingRange || transcribeDayJob?.status === "running"}
                  title="Transcribes only calls missing transcripts in the selected range (reuses existing transcripts)."
                >
                  {transcribeDayJob?.status === "running" ? "Transcribing range…" : "Transcribe range"}
                </button>
              </div>

              <div className="filters">
                <div className="field">
                  <div className="field-label">Day</div>
                  <input className="input" type="date" value={manualDay} onChange={(e) => setManualDay(e.target.value)} />
                </div>
                <button className="button button-secondary" onClick={handleSyncDay} disabled={syncingRange}>
                  {syncingRange ? "Syncing day" : "Sync day (WFO + API)"}
                </button>
                <button className="button button-secondary" onClick={handleSyncDaySplit} disabled={syncingRange}>
                  {syncingRange ? "Syncing splits" : "Sync day (AM/PM splits)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleBackupPushDay}
                  disabled={!systemInfo?.backup?.endpointConfigured || backupPushJob?.status === "running"}
                  title="Incremental ingest for the selected day: only pushes calls that changed since the last successful push for this day (e.g., transcript/media updates)."
                >
                  {backupPushJob?.status === "running" ? "Updating ingest…" : "Update ingest (selected day)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handlePrefetchDay}
                  disabled={!wfoConfigured || syncingRange || prefetchJob?.status === "running"}
                  title="Downloads audio/screen only for calls that are missing local media in the selected day."
                >
                  {prefetchJob?.status === "running" ? "Prefetching media…" : "Prefetch media (selected day)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleTranscribeDay}
                  disabled={syncingRange || transcribeDayJob?.status === "running"}
                  title="Runs transcription + sentiment only for calls missing transcripts in the selected day."
                >
                  {transcribeDayJob?.status === "running" ? "Transcribing…" : "Transcribe day (selected day)"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={handleRefreshTranscriptsDay}
                  disabled={syncingRange || transcribeDayJob?.status === "running"}
                  title="Rebuilds existing transcripts one by one using the new speaker separation logic, without needing to download audio again."
                >
                  Refresh transcripts (selected day)
                </button>
                {prefetchResume?.offset > 0 && prefetchJob?.status !== "running" && (
                  <button
                    className="button"
                    type="button"
                    disabled={!wfoConfigured}
                    title="Resume prefetch from the last saved offset without starting over."
                    onClick={() => {
                      setManualDay(prefetchResume.date);
                      startPrefetchDay({ date: prefetchResume.date, offset: prefetchResume.offset });
                    }}
                  >
                    {wfoConfigured
                      ? `Resume prefetch @ ${prefetchResume.offset}`
                      : `Resume prefetch @ ${prefetchResume.offset} (refresh session first)`}
                  </button>
                )}
                {transcribeResume?.offset > 0 && transcribeDayJob?.status !== "running" && (
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setManualDay(transcribeResume.date);
                      startTranscribeDay({ date: transcribeResume.date, offset: transcribeResume.offset });
                    }}
                    title="Resume transcription from the last saved offset."
                  >
                    {`Resume transcription @ ${transcribeResume.offset}`}
                  </button>
                )}
              </div>
              {(prefetchResume?.date === manualDay && prefetchResume?.offset > 0) ||
                (transcribeResume?.date === manualDay && transcribeResume?.offset > 0) ? (
                <div className="filters" style={{ paddingTop: 0 }}>
                  {prefetchResume?.date === manualDay && prefetchResume?.offset > 0 && (
                    <div className="badge">Saved prefetch checkpoint: {prefetchResume.offset}</div>
                  )}
                  {transcribeResume?.date === manualDay && transcribeResume?.offset > 0 && (
                    <div className="badge">Saved transcription checkpoint: {transcribeResume.offset}</div>
                  )}
                </div>
              ) : null}

              {(backupPushJob || prefetchJob || transcribeDayJob) && (
                <div className="filters" style={{ alignItems: "center" }}>
                  {backupPushJob && (
                    <>
                      <div className="badge">
                        Ingest: {backupPushJob.status}
                        {backupPushJob.progress?.done != null && backupPushJob.progress?.total != null
                          ? ` — ${backupPushJob.progress.done}/${backupPushJob.progress.total}`
                          : ""}
                      </div>
                      <div className="badge">
                        Pushed: {backupPushJob.progress?.pushed ?? 0} • Batches: {backupPushJob.progress?.batches ?? 0}
                      </div>
                      <div className="badge">
                        Range: {backupPushJob.progress?.from ? formatDateTime(backupPushJob.progress.from) : "-"} →{" "}
                        {backupPushJob.progress?.to ? formatDateTime(backupPushJob.progress.to) : "-"}
                      </div>
                      {backupPushJob.status === "failed" && <div className="badge">Error: {backupPushJob.error || "-"}</div>}
                    </>
                  )}
                  {prefetchJob && (
                    <>
                      <div className="badge">
                        Prefetch: {prefetchJob.status}
                        {prefetchJob.progress?.done != null && prefetchJob.progress?.total != null
                          ? ` — ${prefetchJob.progress.done}/${prefetchJob.progress.total}`
                          : ""}
                      </div>
                      <div className="badge">
                        Audio: {prefetchJob.progress?.okAudio ?? 0} • Screen: {prefetchJob.progress?.okScreen ?? 0} • No media:{" "}
                        {prefetchJob.progress?.noMedia ?? 0} • Failed: {prefetchJob.progress?.failed ?? 0}
                      </div>
                      {(prefetchJob.progress?.failed ?? 0) > 0 && (
                        <div className="badge">
                          Top error: {topErrorLabel(prefetchJob.progress?.errorCounts) || "-"}
                          {prefetchJob.progress?.lastError?.callId
                            ? ` • Last: ${prefetchJob.progress.lastError.error} (${prefetchJob.progress.lastError.callId})`
                            : ""}
                        </div>
                      )}
                      {prefetchJob.status === "failed" && (
                        <>
                          <div className="badge">Error: {prefetchJob.error || "-"}</div>
                          {prefetchJob.error === "wfo_session_expired" && (
                            <button
                              className="button button-secondary"
                              type="button"
                              disabled={!wfoConfigured}
                              title="Refresh the WFO session (cURL/HAR), then resume from the last processed offset."
                              onClick={() =>
                                startPrefetchDay({
                                  date: prefetchJob.progress?.date || manualDay,
                                  offset: prefetchJob.progress?.resumeOffset ?? prefetchJob.progress?.done ?? 0
                                })
                              }
                            >
                              {wfoConfigured ? "Resume prefetch" : "Resume prefetch (refresh session first)"}
                            </button>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {transcribeDayJob && (
                    <>
                      <div className="badge">
                        Transcribe: {transcribeDayJob.status}
                        {transcribeDayJob.progress?.done != null && transcribeDayJob.progress?.total != null
                          ? ` — ${transcribeDayJob.progress.done}/${transcribeDayJob.progress.total}`
                          : ""}
                      </div>
                      <div className="badge">
                        Reused: {transcribeDayJob.progress?.reused ?? 0} • OK: {transcribeDayJob.progress?.succeeded ?? 0} • No audio:{" "}
                        {transcribeDayJob.progress?.noAudio ?? 0} • Failed: {transcribeDayJob.progress?.failed ?? 0}
                      </div>
                      <div className="badge">
                        Top error: {topErrorLabel(transcribeDayJob.progress?.errorCounts) || "-"}
                        {transcribeDayJob.progress?.lastError?.callId
                          ? ` • Last: ${transcribeDayJob.progress.lastError.error} (${transcribeDayJob.progress.lastError.callId})`
                          : ""}
                      </div>
                      {transcribeDayJob.status === "failed" && (
                        <>
                          <div className="badge">Error: {transcribeDayJob.error || "-"}</div>
                          {transcribeDayJob.error === "wfo_session_expired" && (
                            <button
                              className="button button-secondary"
                              type="button"
                              disabled={!wfoConfigured}
                              title="Refresh the WFO session (cURL/HAR), then resume from the last processed offset."
                              onClick={() =>
                                startTranscribeDay({
                                  date: transcribeDayJob.progress?.date || manualDay,
                                  offset: transcribeDayJob.progress?.resumeOffset ?? transcribeDayJob.progress?.done ?? 0
                                })
                              }
                            >
                              {wfoConfigured ? "Resume transcription" : "Resume transcription (refresh session first)"}
                            </button>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {(prefetchJob || transcribeDayJob || livePrefetchProgress || liveTranscribeProgress) && (
                <div className="sync-live-grid">
                  <div className="sync-live-card">
                    <div className="panel-title">Downloading media</div>
                    <div className="panel-subtitle">
                      {livePrefetchProgress?.from && livePrefetchProgress?.to
                        ? `${formatDateTime(livePrefetchProgress.from)} → ${formatDateTime(livePrefetchProgress.to)}`
                        : livePrefetchProgress?.date || "Waiting for prefetch"}
                    </div>
                    <div className="sync-live-section">
                      <div className="sync-live-label">In progress</div>
                      {livePrefetchProgress?.activeCalls?.length ? (
                        <div className="sync-live-list">
                          {livePrefetchProgress.activeCalls.map((callId) => (
                            <div key={callId} className="sync-live-item">
                              {callId}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="sync-live-empty">No active downloads right now.</div>
                      )}
                    </div>
                    <div className="sync-live-section">
                      <div className="sync-live-label">Recent downloads</div>
                      {livePrefetchProgress?.recentDownloads?.length ? (
                        <div className="sync-live-list">
                          {livePrefetchProgress.recentDownloads.map((entry, index) => (
                            <div key={`${entry.callId}-${index}`} className="sync-live-item">
                              {describePrefetchEntry(entry)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="sync-live-empty">No download activity yet.</div>
                      )}
                    </div>
                  </div>

                  <div className="sync-live-card">
                    <div className="panel-title">Transcribing calls</div>
                    <div className="panel-subtitle">
                      {liveTranscribeProgress?.from && liveTranscribeProgress?.to
                        ? `${formatDateTime(liveTranscribeProgress.from)} → ${formatDateTime(liveTranscribeProgress.to)}`
                        : liveTranscribeProgress?.date || "Waiting for transcription"}
                    </div>
                    <div className="sync-live-section">
                      <div className="sync-live-label">Current call</div>
                      {liveTranscribeProgress?.currentCallId ? (
                        <div className="sync-live-item">{liveTranscribeProgress.currentCallId}</div>
                      ) : (
                        <div className="sync-live-empty">No active transcription right now.</div>
                      )}
                    </div>
                    <div className="sync-live-section">
                      <div className="sync-live-label">Recent transcripts</div>
                      {liveTranscribeProgress?.recentTranscribed?.length ? (
                        <div className="sync-live-list">
                          {liveTranscribeProgress.recentTranscribed.map((entry, index) => (
                            <div key={`${entry.callId}-${index}`} className="sync-live-item">
                              {describeTranscriptEntry(entry)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="sync-live-empty">No transcription activity yet.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {error && <p style={{ color: "#f25f5c" }}>{userErrorMessage(error)}</p>}
          </>
        )}
      </main>
    </div>
  );
}

function AgentsMatrixTable({ rows, days }) {
  const agentMap = new Map();
  const totalsByDay = Object.fromEntries(days.map((day) => [day, 0]));

  for (const row of rows) {
    const agentId = row.agent_id;
    if (!agentId) continue;
    const day = String(row.day || "");
    const total = Number(row.total_calls || 0);
    const label = row.agent_label || agentId;

    if (!agentMap.has(agentId)) {
      agentMap.set(agentId, { agentId, label, counts: {} });
    }
    agentMap.get(agentId).counts[day] = total;
    if (totalsByDay[day] !== undefined) totalsByDay[day] += total;
  }

  const agents = Array.from(agentMap.values()).sort((a, b) => a.label.localeCompare(b.label));
  const grandTotal = days.reduce((sum, day) => sum + (totalsByDay[day] || 0), 0);

  return (
    <div className="table-wrapper">
      <table className="table matrix-table">
        <thead>
          <tr>
            <th>Agent</th>
            {days.map((day) => (
              <th key={day}>{day}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const rowTotal = days.reduce((sum, day) => sum + (agent.counts[day] || 0), 0);
            return (
              <tr key={agent.agentId}>
                <td>{agent.label}</td>
                {days.map((day) => (
                  <td key={day}>{agent.counts[day] || 0}</td>
                ))}
                <td>{rowTotal}</td>
              </tr>
            );
          })}
          {agents.length > 0 && (
            <tr>
              <td style={{ fontWeight: 700 }}>TOTAL</td>
              {days.map((day) => (
                <td key={day} style={{ fontWeight: 700 }}>
                  {totalsByDay[day] || 0}
                </td>
              ))}
              <td style={{ fontWeight: 700 }}>{grandTotal}</td>
            </tr>
          )}
          {agents.length === 0 && (
            <tr>
              <td colSpan={days.length + 2} style={{ color: "#a7b1c7" }}>
                No data for the selected range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CampaignsMatrixTable({ rows, days }) {
  const campaignMap = new Map();
  const totalsByDay = Object.fromEntries(days.map((day) => [day, 0]));

  for (const row of rows) {
    const campaignId = row.campaign_id;
    if (!campaignId) continue;
    const day = String(row.day || "");
    const total = Number(row.total_calls || 0);
    const label = row.campaign_label || campaignId;

    if (!campaignMap.has(campaignId)) {
      campaignMap.set(campaignId, { campaignId, label, counts: {} });
    }
    campaignMap.get(campaignId).counts[day] = total;
    if (totalsByDay[day] !== undefined) totalsByDay[day] += total;
  }

  const campaigns = Array.from(campaignMap.values()).sort((a, b) => a.label.localeCompare(b.label));
  const grandTotal = days.reduce((sum, day) => sum + (totalsByDay[day] || 0), 0);

  return (
    <div className="table-wrapper">
      <table className="table matrix-table">
        <thead>
          <tr>
            <th>Campaign</th>
            {days.map((day) => (
              <th key={day}>{day}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => {
            const rowTotal = days.reduce((sum, day) => sum + (campaign.counts[day] || 0), 0);
            return (
              <tr key={campaign.campaignId}>
                <td>{campaign.label}</td>
                {days.map((day) => (
                  <td key={day}>{campaign.counts[day] || 0}</td>
                ))}
                <td>{rowTotal}</td>
              </tr>
            );
          })}
          {campaigns.length > 0 && (
            <tr>
              <td style={{ fontWeight: 700 }}>TOTAL</td>
              {days.map((day) => (
                <td key={day} style={{ fontWeight: 700 }}>
                  {totalsByDay[day] || 0}
                </td>
              ))}
              <td style={{ fontWeight: 700 }}>{grandTotal}</td>
            </tr>
          )}
          {campaigns.length === 0 && (
            <tr>
              <td colSpan={days.length + 2} style={{ color: "#a7b1c7" }}>
                No data for the selected range.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
